import { readFile, readdir } from "node:fs/promises";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js/session";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../schema";
import { playModels, plays, rehearsalEvents, rehearsalSessions, users } from "../schema";
import { RehearsalRepository } from "./rehearsal";

const databaseUrl = process.env.REHEARSAL_POSTGRES_TEST_URL;
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const playId = "33333333-3333-4333-8333-333333333333";
const modelId = "44444444-4444-4444-8444-444444444444";
const sceneId = "scene_1";
const actorRoleId = "char_actor";
const schemaName = `task4_rehearsal_${process.pid}_${Date.now()}`;

describe.skipIf(!databaseUrl)("RehearsalRepository real PostgreSQL contention", () => {
  let control: Sql;
  let clientA: Sql;
  let clientB: Sql;
  let locker: Sql;
  let repositoryA: RehearsalRepository<PostgresJsQueryResultHKT>;
  let repositoryB: RehearsalRepository<PostgresJsQueryResultHKT>;
  let databaseA: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    control = postgres(databaseUrl!, { max: 1, connection: { application_name: "task4_control" } });
    await control`CREATE SCHEMA ${control(schemaName)}`;
    await control`SET search_path TO ${control(schemaName)}`;
    const migrationDirectory = new URL("../../migrations/", import.meta.url);
    const names = (await readdir(migrationDirectory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    for (const name of names) await control.unsafe(await readFile(new URL(name, migrationDirectory), "utf8"));

    clientA = postgres(databaseUrl!, { max: 1,
      connection: { application_name: "task4_append_a", search_path: schemaName } });
    clientB = postgres(databaseUrl!, { max: 1,
      connection: { application_name: "task4_append_b", search_path: schemaName } });
    locker = postgres(databaseUrl!, { max: 1,
      connection: { application_name: "task4_locker", search_path: schemaName } });
    databaseA = drizzle(clientA, { schema });
    repositoryA = new RehearsalRepository(databaseA);
    repositoryB = new RehearsalRepository(drizzle(clientB, { schema }));
    await databaseA.insert(users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash" });
    await databaseA.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await databaseA.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 1,
      status: "approved", model: playModel(), issues: [] });
  }, 30_000);

  afterAll(async () => {
    await Promise.all([clientA?.end(), clientB?.end(), locker?.end()]);
    if (control) {
      await control`SET search_path TO public`;
      await control`DROP SCHEMA IF EXISTS ${control(schemaName)} CASCADE`;
      await control.end();
    }
  }, 30_000);

  it("serializes concurrent identical retries on independent connections", async () => {
    const sessionId = "55555555-5555-4555-8555-555555555551";
    await seedSession(sessionId);
    await repositoryA.appendEvent({ ownerUserId, sessionId,
      event: { type: "started", sequence: 1, startedAtMs: 0 } });

    const results = await Promise.all([
      repositoryA.appendEvent({ ownerUserId, sessionId, event: { type: "paused", sequence: 2 } }),
      repositoryB.appendEvent({ ownerUserId, sessionId, event: { type: "paused", sequence: 2 } }),
    ]);

    expect(results.map(({ idempotent }) => idempotent).sort()).toEqual([false, true]);
    const rows = await clientA`SELECT sequence, type FROM rehearsal_events
      WHERE rehearsal_session_id = ${sessionId} ORDER BY sequence`;
    expect(rows).toEqual([{ sequence: 1, type: "started" }, { sequence: 2, type: "paused" }]);
  });

  it("rejects one of two nonidentical same-sequence writes on independent connections", async () => {
    const sessionId = "55555555-5555-4555-8555-555555555552";
    await seedSession(sessionId);
    await repositoryA.appendEvent({ ownerUserId, sessionId,
      event: { type: "started", sequence: 1, startedAtMs: 0 } });

    const results = await Promise.allSettled([
      repositoryA.appendEvent({ ownerUserId, sessionId, event: { type: "paused", sequence: 2 } }),
      repositoryB.appendEvent({ ownerUserId, sessionId,
        event: { type: "connection_lost", sequence: 2, reason: "network" } }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected",
      reason: { message: "Expected rehearsal sequence 3, received 2" } });
    const rows = await clientA`SELECT sequence, type FROM rehearsal_events
      WHERE rehearsal_session_id = ${sessionId} ORDER BY sequence`;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ sequence: 2 });
    expect(["paused", "connection_lost"]).toContain(rows[1]?.type);
  });

  it("makes a waiting Stop terminal before a contending write on independent connections", async () => {
    const sessionId = "55555555-5555-4555-8555-555555555553";
    await seedSession(sessionId);
    await repositoryA.appendEvent({ ownerUserId, sessionId,
      event: { type: "started", sequence: 1, startedAtMs: 0 } });
    const reserved = await locker.reserve();
    await reserved.unsafe("BEGIN");
    try {
      await reserved`SELECT id FROM rehearsal_sessions WHERE id = ${sessionId} FOR UPDATE`;
      const stopping = repositoryA.appendEvent({ ownerUserId, sessionId,
        event: { type: "stopped", sequence: 2 } });
      await waitUntilConnectionBlocks("task4_append_a");
      const writing = repositoryB.appendEvent({ ownerUserId, sessionId,
        event: { type: "paused", sequence: 2 } });
      await waitUntilConnectionBlocks("task4_append_b");
      await reserved.unsafe("COMMIT");

      await expect(stopping).resolves.toMatchObject({ sequence: 2, type: "stopped", idempotent: false });
      await expect(writing).rejects.toThrow("TERMINAL_SESSION");
    } catch (error) {
      await reserved.unsafe("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      reserved.release();
    }

    const rows = await clientA`SELECT sequence, type FROM rehearsal_events
      WHERE rehearsal_session_id = ${sessionId} ORDER BY sequence`;
    expect(rows).toEqual([{ sequence: 1, type: "started" }, { sequence: 2, type: "stopped" }]);
    await expect(databaseA.select({ state: rehearsalSessions.state }).from(rehearsalSessions))
      .resolves.toContainEqual({ state: "stopped" });
  });

  async function seedSession(sessionId: string): Promise<void> {
    await databaseA.insert(rehearsalSessions).values({ id: sessionId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId, actorRoleId, model: "gpt-realtime-2.1",
      grantExpiresAt: new Date("2099-01-01T00:00:00.000Z") });
  }

  async function waitUntilConnectionBlocks(applicationName: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = await control<{ blocked: boolean }[]>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE application_name = ${applicationName}
          AND wait_event_type = 'Lock'
      ) AS blocked`;
      if (rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${applicationName} lock contention`);
  }
});

function playModel() {
  return { id: "model:v1", title: "Private Play", language: "en" as const,
    characters: [{ id: actorRoleId, name: "Actor", aliases: [] },
      { id: "char_bea", name: "Bea", aliases: [] }], acts: [{ id: "act", ordinal: 1, title: "Act I",
      scenes: [{ id: sceneId, ordinal: 1, title: "Scene", characterIds: [actorRoleId, "char_bea"],
        elements: [
          { id: "line_0001", ordinal: 1, kind: "dialogue" as const, characterId: actorRoleId,
            text: "We begin.", sourcePage: 1 },
          { id: "line_0002", ordinal: 2, kind: "dialogue" as const, characterId: "char_bea",
            text: "At last.", sourcePage: 1 },
        ] }] }] };
}
