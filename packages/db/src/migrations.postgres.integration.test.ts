import { readFile, readdir } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.COACHING_POSTGRES_TEST_URL;
const schemaName = `task5_coaching_${process.pid}_${Date.now()}`;
const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const modelId = "44444444-4444-4444-8444-444444444444";
const practiceId = "55555555-5555-4555-8555-555555555555";
const rehearsalA = "66666666-6666-4666-8666-666666666666";
const rehearsalB = "77777777-7777-4777-8777-777777777777";
const takeId = "88888888-8888-4888-8888-888888888888";
const cueA = "99999999-9999-4999-8999-999999999999";
const actorA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const cueB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe.skipIf(!databaseUrl)("0020 real PostgreSQL migration", () => {
  let control: Sql;
  let database: Sql;
  const migrationDirectory = new URL("../migrations/", import.meta.url);

  beforeAll(async () => {
    control = postgres(databaseUrl!, { max: 1, connection: { application_name: "task5_migration_control" } });
    await control`CREATE SCHEMA ${control(schemaName)}`;
    database = postgres(databaseUrl!, { max: 1,
      connection: { application_name: "task5_migration", search_path: schemaName } });
    const names = (await readdir(migrationDirectory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)
      && name !== "0020_rehearsal_linked_coaching.sql").sort();
    for (const name of names) await database.unsafe(await readFile(new URL(name, migrationDirectory), "utf8"));
    await database`INSERT INTO users (id, email, password_hash) VALUES
      (${ownerA}, 'a@example.com', 'a'), (${ownerB}, 'b@example.com', 'b')`;
    await database`INSERT INTO plays (id, owner_user_id, title) VALUES (${playId}, ${ownerA}, 'Private')`;
    await database`INSERT INTO play_models
      (id, owner_user_id, play_id, version, status, model) VALUES
      (${modelId}, ${ownerA}, ${playId}, 1, 'approved', '{}'::jsonb)`;
    await database`INSERT INTO practice_sessions
      (id, owner_user_id, play_id, play_model_id, play_model_version, scene_id, role_id, retention_choice)
      VALUES (${practiceId}, ${ownerA}, ${playId}, ${modelId}, 1, 'scene', 'role', 'retain')`;
    await database`INSERT INTO rehearsal_sessions
      (id, owner_user_id, play_id, play_model_id, play_model_version, scene_id, actor_role_id, model,
       grant_expires_at, state) VALUES
      (${rehearsalA}, ${ownerA}, ${playId}, ${modelId}, 1, 'scene', 'role', 'realtime', now(), 'completed'),
      (${rehearsalB}, ${ownerA}, ${playId}, ${modelId}, 1, 'scene', 'role', 'realtime', now(), 'completed')`;
    await database`INSERT INTO takes
      (id, owner_user_id, practice_session_id, play_id, play_model_id, play_model_version, scene_id, role_id,
       retention_choice, duration_ms, media_type, object_key, state)
      VALUES (${takeId}, ${ownerA}, ${practiceId}, ${playId}, ${modelId}, 1, 'scene', 'role', 'retain',
        1000, 'audio/wav', 'private', 'completed')`;
  }, 30_000);

  afterAll(async () => {
    await database?.end();
    if (control) {
      await control`DROP SCHEMA IF EXISTS ${control(schemaName)} CASCADE`;
      await control.end();
    }
  }, 30_000);

  it("runs forward, down, and re-forward with owner-chain and check mutations", async () => {
    const forward = await readFile(new URL("0020_rehearsal_linked_coaching.sql", migrationDirectory), "utf8");
    const down = await readFile(new URL("down/0020_rehearsal_linked_coaching.sql", migrationDirectory), "utf8");
    await database.unsafe(forward);

    expect(await database`SELECT rehearsal_session_id FROM takes WHERE id = ${takeId}`)
      .toEqual([{ rehearsal_session_id: null }]);
    await database`UPDATE takes SET rehearsal_session_id = ${rehearsalA} WHERE id = ${takeId}`;
    await expectSqlState(database`UPDATE takes SET owner_user_id = ${ownerB} WHERE id = ${takeId}`, "23503");
    await database`INSERT INTO rehearsal_events
      (id, owner_user_id, rehearsal_session_id, sequence, type, event, received_at_ms, received_clock_id,
       timing_source, timing_at_ms, timing_clock_id) VALUES
      (${cueA}, ${ownerA}, ${rehearsalA}, 1, 'ai_speech_finished', '{}'::jsonb, 10000,
       'server:unix-epoch-ms', 'provider-derived', 10000, 'provider:real'),
      (${actorA}, ${ownerA}, ${rehearsalA}, 2, 'actor_line_final', '{}'::jsonb, 10740,
       'server:unix-epoch-ms', 'provider-derived', 10740, 'provider:real'),
      (${cueB}, ${ownerA}, ${rehearsalB}, 1, 'ai_speech_finished', '{}'::jsonb, 10000,
       'server:unix-epoch-ms', 'provider-derived', 10000, 'provider:other')`;
    await database`INSERT INTO cue_response_evidence
      (owner_user_id, take_id, rehearsal_session_id, measurement_version, cue_event_id, actor_event_id,
       clock_id, delay_ms, confidence, score) VALUES
      (${ownerA}, ${takeId}, ${rehearsalA}, 'cue-response-v1', ${cueA}, ${actorA},
       'provider:real', 740, 'high', 85)`;
    await expectSqlState(database`INSERT INTO cue_response_evidence
      (owner_user_id, take_id, rehearsal_session_id, measurement_version, cue_event_id, actor_event_id,
       clock_id, delay_ms, confidence, score) VALUES
      (${ownerA}, ${takeId}, ${rehearsalA}, 'cross-session', ${cueB}, ${actorA},
       'provider:real', 740, 'high', 85)`, "23503");
    await expectSqlState(database`INSERT INTO cue_response_evidence
      (owner_user_id, take_id, rehearsal_session_id, measurement_version, confidence, score)
      VALUES (${ownerA}, ${takeId}, ${rehearsalA}, 'invented-low', 'low', 99)`, "23514");
    await expectSqlState(database`UPDATE rehearsal_events SET timing_at_ms = NULL
      WHERE id = ${cueA}`, "23514");

    await database.unsafe(down);
    expect(await database<{ count: number }[]>`SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema = ${schemaName} AND
        ((table_name = 'takes' AND column_name = 'rehearsal_session_id') OR
         (table_name = 'rehearsal_events' AND column_name = 'timing_source'))`).toEqual([{ count: 0 }]);

    await database.unsafe(forward);
    expect(await database`SELECT rehearsal_session_id FROM takes WHERE id = ${takeId}`)
      .toEqual([{ rehearsal_session_id: null }]);
  }, 30_000);
});

async function expectSqlState(operation: Promise<unknown>, code: string): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected SQLSTATE ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}
