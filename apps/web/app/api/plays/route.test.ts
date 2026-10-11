import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteQueryResultHKT } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { jobs, plays, sourceFiles, users } from "@drama/db/schema";
import type { ObjectStorage } from "@drama/storage/port";
import { createPlayHandler } from "./handler";

const migrationUrl = new URL("../../../../../packages/db/migrations/0001_foundation.sql", import.meta.url);
const playStatusMigrationUrl = new URL("../../../../../packages/db/migrations/0002_play_processing_status.sql", import.meta.url);
const parseJobsMigrationUrl = new URL("../../../../../packages/db/migrations/0003_reviewable_parse_jobs.sql", import.meta.url);
const leaseFencingMigrationUrl = new URL("../../../../../packages/db/migrations/0004_job_lease_fencing.sql", import.meta.url);
const accountDeletionMigrationUrl = new URL("../../../../../packages/db/migrations/0019_account_deletion.sql", import.meta.url);
const fixtureUrl = new URL("../../../../../fixtures/plays/", import.meta.url);
const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";

describe("POST /api/plays", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let storage: RecordingStorage;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(await readFile(migrationUrl, "utf8"));
    await client.exec(await readFile(playStatusMigrationUrl, "utf8"));
    await client.exec(await readFile(parseJobsMigrationUrl, "utf8"));
    await client.exec(await readFile(leaseFencingMigrationUrl, "utf8"));
    await client.exec(await readFile(accountDeletionMigrationUrl, "utf8"));
    db = drizzle(client, { schema });
    storage = new RecordingStorage();
    await db.insert(users).values([
      { id: userA, email: "a@example.com", passwordHash: "hash-a" },
      { id: userB, email: "b@example.com", passwordHash: "hash-b" },
    ]);
  });

  afterEach(async () => {
    await client.close();
  });

  it.each([
    { format: "txt", contentType: "text/plain" },
    { format: "pdf", contentType: "application/pdf" },
    {
      format: "docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ])("accepts real $format bytes and returns no storage details", async ({ format, contentType }) => {
    const bytes = await readFile(new URL(`two-scene-play.${format}`, fixtureUrl));
    const response = await handler()(multipartRequest(
      new File([bytes], `two-scene-play.${format}`, { type: contentType }),
    ));

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({ play: { title: "two-scene-play", status: "processing" } });
    expect(JSON.stringify(body)).not.toContain("objectKey");
    expect(JSON.stringify(body)).not.toContain("providerUrl");
    expect(JSON.stringify(body)).not.toContain("users/");

    const [play] = await db.select().from(plays);
    const [source] = await db.select().from(sourceFiles);
    const [job] = await db.select().from(jobs);
    expect(play).toMatchObject({ id: body.play.id, ownerUserId: userA, status: "processing" });
    expect(source).toMatchObject({ ownerUserId: userA, playId: play!.id, sourceText: null });
    expect(job).toMatchObject({
      ownerUserId: userA,
      playId: play!.id,
      kind: "extract_script",
      status: "queued",
      dedupeKey: `extract_script:${source!.id}`,
    });
    expect(job!.payload).toEqual({ sourceFileId: source!.id });
    expect(source!.objectKey).toBe(`users/${userA}/plays/${play!.id}/source/${source!.id}`);
    expect(storage.objects).toHaveLength(1);
    expect(storage.objects[0]).toMatchObject({ key: source!.objectKey, contentType });
    expect(Buffer.from(storage.objects[0]!.bytes)).toEqual(bytes);
  });

  it.each(["", "application/octet-stream"])(
    "recognizes a PDF when the browser reports the MIME type as %j",
    async (reportedContentType) => {
      const bytes = await readFile(new URL("two-scene-play.pdf", fixtureUrl));

      const response = await handler()(multipartRequest(
        new File([bytes], "two-scene-play.pdf", { type: reportedContentType }),
      ));

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ play: { title: "two-scene-play" } });
      expect(storage.objects).toHaveLength(1);
      expect(storage.objects[0]!.contentType).toBe("application/pdf");
      expect(Buffer.from(storage.objects[0]!.bytes)).toEqual(bytes);
    },
  );

  it.each(["riders-to-the-sea", "the-importance-of-being-earnest", "hamlet"])(
    "accepts the complete public-domain TXT fixture %s",
    async (title) => {
      const bytes = await readFile(new URL(`${title}.txt`, fixtureUrl));
      const response = await handler()(multipartRequest(new File([bytes], `${title}.txt`, { type: "text/plain" })));

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ play: { title, status: "processing" } });
      expect(storage.objects).toHaveLength(1);
      expect(storage.objects[0]!.contentType).toBe("text/plain");
    },
  );

  it.each([
    { format: "txt", contentType: "text/plain" },
    { format: "pdf", contentType: "application/pdf" },
    {
      format: "docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ])("rejects a real non-English $format before creating private data", async ({ format, contentType }) => {
    const bytes = await readFile(new URL(`two-scene-play-es.${format}`, fixtureUrl));

    const response = await handler()(multipartRequest(
      new File([bytes], `two-scene-play-es.${format}`, { type: contentType }),
    ));

    expect(response.status).toBe(422);
    expect(await db.select().from(plays)).toEqual([]);
    expect(await db.select().from(sourceFiles)).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([]);
    expect(storage.objects).toEqual([]);
  });

  it("accepts non-empty English pasted text without putting an object", async () => {
    const pastedText = await readFile(new URL("two-scene-play.txt", fixtureUrl), "utf8");

    const response = await handler()(jsonRequest({ pastedText }));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      play: { title: "THE FIRST STEP", status: "processing" },
    });
    const [source] = await db.select().from(sourceFiles);
    expect(source).toMatchObject({ ownerUserId: userA, filename: "pasted-text.txt", objectKey: null, sourceText: pastedText });
    expect(storage.objects).toEqual([]);
  });

  it.each([
    "Bonjour tout le monde, nous commençons maintenant cette scène avec les autres personnages.",
    "Guten Abend zusammen, wir beginnen jetzt diese Szene mit allen anderen Figuren.",
    "Buonasera a tutti, iniziamo ora questa scena insieme a tutti gli altri personaggi.",
  ])("rejects detected non-English Latin-script text", async (pastedText) => {
    const response = await handler()(jsonRequest({ pastedText }));

    expect(response.status).toBe(422);
    expect(await db.select().from(plays)).toEqual([]);
  });

  it("rejects unauthenticated requests before creating private data", async () => {
    const response = await createPlayHandler({
      authenticate: async () => {
        throw Object.assign(new Error("Authentication required"), { name: "UnauthorizedError" });
      },
      db,
      storage,
    })(jsonRequest({ pastedText: "ALEX: We begin." }));

    expect(response.status).toBe(401);
    expect(await db.select().from(plays)).toEqual([]);
    expect(storage.objects).toEqual([]);
  });

  it.each([
    { name: "empty pasted text", request: () => jsonRequest({ pastedText: "   \n" }) },
    {
      name: "non-English pasted text",
      request: () => jsonRequest({ pastedText: "Este guion está completamente escrito en español y no contiene diálogo inglés." }),
    },
    {
      name: "unsupported upload",
      request: () => multipartRequest(new File(["ALEX: We begin."], "play.rtf", { type: "application/rtf" })),
    },
    {
      name: "a non-UTF-8 TXT upload",
      request: () => multipartRequest(new File([new Uint8Array([0xff, 0xfe, 0x41])], "play.txt", { type: "text/plain" })),
    },
    {
      name: "a MIME-spoofed PDF",
      request: () => multipartRequest(new File(["not really a PDF"], "play.pdf", { type: "application/pdf" })),
    },
    {
      name: "a truncated PDF-shaped payload",
      request: () => multipartRequest(new File(["%PDF-1.4\n%%EOF"], "play.pdf", { type: "application/pdf" })),
    },
    {
      name: "an arbitrary ZIP labeled DOCX",
      request: () => multipartRequest(new File(
        [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
        "play.docx",
        { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      )),
    },
    {
      name: "both upload sources",
      request: () => multipartRequest(
        new File(["%PDF"], "play.pdf", { type: "application/pdf" }),
        "ALEX: We begin.",
      ),
    },
  ])("returns 422 for $name", async ({ request }) => {
    const response = await handler()(request());

    expect(response.status).toBe(422);
    expect(await db.select().from(plays)).toEqual([]);
    expect(storage.objects).toEqual([]);
  });

  it("rejects files over 25 MiB without reading or storing them", async () => {
    const response = await handler()(multipartRequest(new File(
      [new Uint8Array(25 * 1024 * 1024 + 1)],
      "too-large.pdf",
      { type: "application/pdf" },
    )));

    expect(response.status).toBe(422);
    expect(await db.select().from(plays)).toEqual([]);
    expect(storage.objects).toEqual([]);
  });

  it("rejects multipart requests containing more than one file", async () => {
    const bytes = await readFile(new URL("two-scene-play.pdf", fixtureUrl));
    const form = new FormData();
    form.append("file", new File([bytes], "first.pdf", { type: "application/pdf" }));
    form.append("file", new File([bytes], "second.pdf", { type: "application/pdf" }));

    const response = await handler()(new Request("http://localhost/api/plays", { method: "POST", body: form }));

    expect(response.status).toBe(422);
    expect(await db.select().from(plays)).toEqual([]);
    expect(storage.objects).toEqual([]);
  });

  it("rolls back the processing play and source when extract-job insertion fails", async () => {
    await client.exec("ALTER TABLE jobs ADD CONSTRAINT reject_extract_job CHECK (kind <> 'extract_script')");
    const bytes = await readFile(new URL("two-scene-play.pdf", fixtureUrl));

    const response = await handler()(multipartRequest(new File(
      [bytes],
      "two-scene-play.pdf",
      { type: "application/pdf" },
    )));

    expect(response.status).toBe(500);
    expect(await db.select().from(plays)).toEqual([]);
    expect(await db.select().from(sourceFiles)).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([]);
    expect(storage.objects).toEqual([]);
  });

  function handler() {
    return createPlayHandler<PgliteQueryResultHKT>({
      authenticate: async () => ({ id: userA }),
      db,
      storage,
    });
  }
});

class RecordingStorage implements ObjectStorage {
  readonly objects: Array<{ key: string; bytes: Uint8Array; contentType: string }> = [];

  async putPrivate(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.push({ key, bytes: bytes.slice(), contentType });
  }

  async putPrivateVersioned(key: string, bytes: Uint8Array, contentType: string) {
    await this.putPrivate(key, bytes, contentType);
    return { versionToken: `recording:${this.objects.length}` };
  }

  async getPrivate(): Promise<Uint8Array> {
    throw new Error("RecordingStorage has no readable objects");
  }

  async deletePrivate(key: string): Promise<void> {
    const index = this.objects.findIndex((object) => object.key === key);
    if (index >= 0) this.objects.splice(index, 1);
  }

  async purgePrivate(key: string): Promise<void> {
    for (let index = this.objects.length - 1; index >= 0; index -= 1) {
      if (this.objects[index]!.key === key) this.objects.splice(index, 1);
    }
  }

  async deletePrivateVersion(key: string): Promise<boolean> {
    const index = this.objects.findIndex((object) => object.key === key);
    if (index < 0) return false;
    this.objects.splice(index, 1);
    return true;
  }
}

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/plays", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function multipartRequest(file: File, pastedText?: string) {
  const form = new FormData();
  form.set("file", file);
  if (pastedText !== undefined) {
    form.set("pastedText", pastedText);
  }
  return new Request("http://localhost/api/plays", { method: "POST", body: form });
}
