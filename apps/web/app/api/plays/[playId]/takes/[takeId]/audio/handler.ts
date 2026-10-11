import type * as schema from "@drama/db/schema";
import { takes } from "@drama/db/schema";
import type { ObjectStorage } from "@drama/storage/port";
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type RouteContext = { params: Promise<{ playId: string; takeId: string }> };
type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  storage: ObjectStorage;
};

export function createTakeAudioHandler<TQueryResult extends PgQueryResultHKT>(
  dependencies: Dependencies<TQueryResult>,
) {
  return async function GET(request: Request, context: RouteContext): Promise<Response> {
    let user: { id: string };
    try {
      user = await dependencies.authenticate();
    } catch (error) {
      if (error instanceof Error && error.name === "UnauthorizedError") {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      return Response.json({ error: "Unable to authenticate" }, { status: 500 });
    }

    const { playId, takeId } = await context.params;
    const [take] = await dependencies.db.select({ objectKey: takes.objectKey, mediaType: takes.mediaType,
      audioDeletedAt: takes.audioDeletedAt })
      .from(takes).where(and(eq(takes.id, takeId), eq(takes.playId, playId),
        eq(takes.ownerUserId, user.id))).limit(1);
    if (!take || take.audioDeletedAt) return Response.json({ error: "Take not found" }, { status: 404 });

    let bytes: Uint8Array;
    try {
      bytes = await dependencies.storage.getPrivate(take.objectKey);
    } catch {
      return Response.json({ error: "Unable to load private take" }, { status: 500 });
    }

    const rangeHeader = request.headers.get("range");
    const headers = { "accept-ranges": "bytes", "cache-control": "private, no-store",
      "content-type": take.mediaType };
    if (!rangeHeader) {
      return new Response(responseBuffer(bytes), { status: 200,
        headers: { ...headers, "content-length": String(bytes.byteLength) } });
    }
    const range = parseByteRange(rangeHeader, bytes.byteLength);
    if (!range) return new Response(null, { status: 416,
      headers: { ...headers, "content-range": `bytes */${bytes.byteLength}` } });
    const body = bytes.slice(range.start, range.end + 1);
    return new Response(responseBuffer(body), { status: 206, headers: { ...headers,
      "content-range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
      "content-length": String(body.byteLength) } });
  };
}

function parseByteRange(header: string, totalBytes: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || totalBytes === 0 || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, totalBytes - suffixLength), end: totalBytes - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalBytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
    || start < 0 || start >= totalBytes || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, totalBytes - 1) };
}

function responseBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
