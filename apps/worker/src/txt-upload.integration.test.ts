import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { jobs, plays, users } from "@drama/db/schema";
import type { ParseProposal } from "@drama/domain/parse-review";
import { OpenAiPlayParser } from "@drama/ai/play-parser/openai-parser";
import { ScriptExtractor } from "@drama/media/scripts/extract";
import type { ObjectStorage } from "@drama/storage/port";
import { createPlayHandler } from "../../web/app/api/plays/handler";
import { runWorkerOnce } from "./index";

const migrations = new URL("../../../packages/db/migrations/", import.meta.url);
const fixtures = new URL("../../../fixtures/plays/", import.meta.url);
const ownerUserId = "11111111-1111-4111-8111-111111111111";

describe("TXT upload through worker parsing", () => {
  let client: PGlite;

  afterEach(async () => client?.close());

  it.each(["two-scene-play", "riders-to-the-sea", "the-importance-of-being-earnest", "hamlet"])(
    "adds and parses %s.txt without an extract failure",
    async (fixture) => {
      client = new PGlite();
      const names = (await readdir(migrations)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
      for (const name of names) await client.exec(await readFile(new URL(name, migrations), "utf8"));
      const db = drizzle(client, { schema });
      const storage = new MemoryStorage();
      await db.insert(users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash" });
      const bytes = await readFile(new URL(`${fixture}.txt`, fixtures));
      const form = new FormData();
      form.set("file", new File([bytes], `${fixture}.txt`, { type: "text/plain" }));

      const response = await createPlayHandler({ authenticate: async () => ({ id: ownerUserId }), db, storage })(
        new Request("http://local/api/plays", { method: "POST", body: form }),
      );
      expect(response.status).toBe(202);

      const parser = fixture === "riders-to-the-sea"
        ? new OpenAiPlayParser({ model: "model", apiKey: "key",
            fetch: async () => Response.json({ error: "request rejected" }, { status: 400 }) })
        : { parse: async () => proposal(fixture) };
      const worker = () => runWorkerOnce({ db, ownerUserId, extractor: new ScriptExtractor(), parser,
        loadPrivateObject: (key) => storage.getPrivate(key), now: new Date("2030-09-28T12:00:00Z") });
      await expect(worker()).resolves.toBe(true);
      await expect(worker()).resolves.toBe(true);

      expect(await db.select().from(jobs)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "extract_script", status: "completed", errorCode: null }),
        expect.objectContaining({ kind: "parse_play", status: "completed", errorCode: null }),
      ]));
      expect((await db.select().from(plays))[0]).toMatchObject({ title: fixture, status: "review" });
    }, 30_000,
  );
});

class MemoryStorage implements ObjectStorage {
  private readonly objects = new Map<string, Uint8Array>();
  async putPrivate(key: string, bytes: Uint8Array) { this.objects.set(key, bytes.slice()); }
  async putPrivateVersioned(key: string, bytes: Uint8Array) {
    await this.putPrivate(key, bytes); return { versionToken: "memory:1" };
  }
  async getPrivate(key: string) {
    const value = this.objects.get(key); if (!value) throw new Error("missing object"); return value.slice();
  }
  async deletePrivate(key: string) { this.objects.delete(key); }
  async purgePrivate(key: string) { this.objects.delete(key); }
  async deletePrivateVersion(key: string) { return this.objects.delete(key); }
}

function proposal(title: string): ParseProposal {
  return { playModel: { id: "model", title, language: "en", characters: [{ id: "alex", name: "Alex", aliases: [] }],
    acts: [{ id: "act", ordinal: 1, title: "Act I", scenes: [{ id: "scene", ordinal: 1, title: "Scene I",
      characterIds: ["alex"], elements: [{ id: "line", ordinal: 1, kind: "dialogue", characterId: "alex",
        text: "We begin.", sourcePage: 1 }] }] }] }, issues: [] };
}
