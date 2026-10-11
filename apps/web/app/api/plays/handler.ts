import { randomUUID } from "node:crypto";

import { PlayRepository } from "@drama/db/repositories/plays";
import { lockActiveOwner } from "@drama/db/repositories/auth";
import * as schema from "@drama/db/schema";
import { jobs, sourceFiles } from "@drama/db/schema";
import type { JobEnvelope } from "@drama/domain/jobs";
import { isNonEnglishScript } from "@drama/media/scripts/language";
import type { ObjectStorage } from "@drama/storage/port";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PDF_CONTENT_TYPE = "application/pdf";
const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEXT_CONTENT_TYPE = "text/plain";

type HandlerDependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  storage: ObjectStorage;
  createId?: () => string;
};

type ParsedSource =
  | { kind: "file"; filename: string; contentType: string; bytes: Uint8Array }
  | { kind: "text"; filename: "pasted-text.txt"; text: string };

export function createPlayHandler<TQueryResult extends PgQueryResultHKT>(
  dependencies: HandlerDependencies<TQueryResult>,
) {
  return async function POST(request: Request): Promise<Response> {
    let user: { id: string };
    try {
      user = await dependencies.authenticate();
    } catch (error) {
      if (error instanceof Error && error.name === "UnauthorizedError") {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      return Response.json({ error: "Unable to authenticate" }, { status: 500 });
    }

    const source = await parseSource(request);
    if (!source) {
      return Response.json({ error: "A valid PDF, DOCX, TXT, or English pasted script is required" }, { status: 422 });
    }

    const createId = dependencies.createId ?? randomUUID;
    const playId = createId();
    const sourceFileId = createId();
    const title = source.kind === "file" ? fileTitle(source.filename) : pastedTitle(source.text);
    const objectKey = source.kind === "file"
      ? `users/${user.id}/plays/${playId}/source/${sourceFileId}`
      : null;

    try {
      const play = await dependencies.db.transaction(async (transaction) => {
        if (!await lockActiveOwner(transaction, user.id)) throw new Error("ACCOUNT_NOT_ACTIVE");
        const repository = new PlayRepository(transaction);
        const created = await repository.create(user.id, { id: playId, title, status: "processing" });
        await transaction.insert(sourceFiles).values({
          id: sourceFileId,
          ownerUserId: user.id,
          playId: created.id,
          filename: source.filename,
          objectKey,
          sourceText: source.kind === "text" ? source.text : null,
        });
        const envelope: JobEnvelope<{ sourceFileId: string }> = {
          type: "extract_script",
          payload: { sourceFileId },
        };
        await transaction.insert(jobs).values({
          ownerUserId: user.id,
          playId: created.id,
          kind: envelope.type,
          dedupeKey: `extract_script:${sourceFileId}`,
          payload: envelope.payload,
        });
        if (source.kind === "file") {
          await dependencies.storage.putPrivate(objectKey!, source.bytes, source.contentType);
        }
        return created;
      });

      return Response.json({
        play: { id: play.id, title: play.title, status: play.status },
      }, { status: 202 });
    } catch (error) {
      if (error instanceof Error && error.message === "ACCOUNT_NOT_ACTIVE") {
        return Response.json({ error: "Unable to create play" }, { status: 404 });
      }
      return Response.json({ error: "Unable to create play" }, { status: 500 });
    }
  };
}

async function parseSource(request: Request): Promise<ParsedSource | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.startsWith("application/json")) {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.pastedText !== "string" || "file" in body) {
      return null;
    }
    const text = body.pastedText;
    if (!text.trim() || isNonEnglishScript(text)) {
      return null;
    }
    return { kind: "text", filename: "pasted-text.txt", text };
  }

  if (!contentType.startsWith("multipart/form-data")) {
    return null;
  }
  const form = await request.formData().catch(() => null);
  if (!form || form.has("pastedText")) {
    return null;
  }
  const files = form.getAll("file");
  if (files.length !== 1) {
    return null;
  }
  const value = files[0];
  if (!(value instanceof File) || value.size === 0 || value.size > MAX_FILE_BYTES) {
    return null;
  }
  const bytes = new Uint8Array(await value.arrayBuffer());
  const fileContentType = supportedContentType(value.name, bytes);
  if (!fileContentType) {
    return null;
  }
  try {
    const { validateScriptFile } = await import("@drama/media/scripts/validate");
    const extractedText = await validateScriptFile({
      kind: "file",
      filename: value.name,
      contentType: fileContentType,
      bytes,
    });
    if (isNonEnglishScript(extractedText)) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    kind: "file",
    filename: value.name,
    contentType: fileContentType,
    bytes,
  };
}

function supportedContentType(filename: string, bytes: Uint8Array): string | null {
  const extension = filename.toLowerCase().split(".").pop();
  if (extension === "txt") {
    return TEXT_CONTENT_TYPE;
  }
  if (extension === "pdf" && hasSignature(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return PDF_CONTENT_TYPE;
  }
  if (extension === "docx" && hasSignature(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return DOCX_CONTENT_TYPE;
  }
  return null;
}

function hasSignature(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function fileTitle(filename: string): string {
  const title = filename.replace(/\.(pdf|docx|txt)$/i, "").trim();
  return title || "Untitled play";
}

function pastedTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine?.slice(0, 200) ?? "Untitled play";
}
