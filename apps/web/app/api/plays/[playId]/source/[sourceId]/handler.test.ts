import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { plays, sourceFiles, users } from "@drama/db/schema";
import type { ObjectStorage } from "@drama/storage/port";
import { createSourceHandler } from "./handler";

const migrationUrl = new URL("../../../../../../../../packages/db/migrations/0001_foundation.sql", import.meta.url);
const statusMigrationUrl = new URL(
  "../../../../../../../../packages/db/migrations/0002_play_processing_status.sql", import.meta.url,
);
const accountDeletionMigrationUrl = new URL(
  "../../../../../../../../packages/db/migrations/0019_account_deletion.sql", import.meta.url,
);
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";

describe("GET private play source", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let storage: ReadingStorage;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(await readFile(migrationUrl, "utf8"));
    await client.exec(await readFile(statusMigrationUrl, "utf8"));
    await client.exec(await readFile(accountDeletionMigrationUrl, "utf8"));
    db = drizzle(client, { schema });
    storage = new ReadingStorage();
    await db.insert(users).values([
      { id: ownerUserId, email: "owner@example.com", passwordHash: "hash" },
      { id: otherUserId, email: "other@example.com", passwordHash: "hash" },
    ]);
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private" });
  });

  afterEach(async () => client.close());

  it.each([
    { filename: "private-play.txt", contentType: "text/plain; charset=utf-8", bytes: new TextEncoder().encode("ALEX: Begin.") },
    { filename: "private-play.pdf", contentType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) },
    { filename: "private-play.docx", contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: new Uint8Array([80, 75, 3, 4]) },
  ])("streams owned $filename bytes without exposing storage details", async ({ filename, contentType, bytes }) => {
    const objectKey = `users/${ownerUserId}/secret-provider-key`;
    storage.objects.set(objectKey, bytes);
    await db.insert(sourceFiles).values({ id: sourceId, ownerUserId, playId, filename, objectKey });

    const response = await handler(ownerUserId)(context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("content-disposition")).toContain(encodeURIComponent(filename));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect([...response.headers.values()].join(" ")).not.toContain(objectKey);
  });

  it("preserves the pasted-text JSON response", async () => {
    await db.insert(sourceFiles).values({ id: sourceId, ownerUserId, playId,
      filename: "pasted-text.txt", sourceText: "ALEX: We begin." });
    const response = await handler(ownerUserId)(context());
    expect(await response.json()).toEqual({ source: { id: sourceId, filename: "pasted-text.txt",
      sourceText: "ALEX: We begin." } });
  });

  it("returns 404 without reading another owner's binary object", async () => {
    await db.insert(sourceFiles).values({ id: sourceId, ownerUserId, playId,
      filename: "private.pdf", objectKey: "users/owner/private" });
    const response = await handler(otherUserId)(context());
    expect(response.status).toBe(404);
    expect(storage.reads).toEqual([]);
  });

  function handler(userId: string) {
    return (contextValue: ReturnType<typeof context>) => createSourceHandler({
      authenticate: async () => ({ id: userId }), db, storage,
    })(new Request("http://localhost/source"), contextValue);
  }
});

class ReadingStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  async putPrivate(): Promise<void> {}
  async putPrivateVersioned() { return { versionToken: "reading:unused" }; }
  async deletePrivate(): Promise<void> {}
  async purgePrivate(): Promise<void> {}
  async deletePrivateVersion(): Promise<boolean> { return false; }
  async getPrivate(key: string): Promise<Uint8Array> {
    this.reads.push(key);
    const value = this.objects.get(key);
    if (!value) throw new Error("missing object");
    return value.slice();
  }
}

function context() { return { params: Promise.resolve({ playId, sourceId }) }; }
