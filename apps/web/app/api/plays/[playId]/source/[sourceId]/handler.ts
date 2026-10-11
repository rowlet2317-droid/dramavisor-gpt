import type * as schema from "@drama/db/schema";
import { sourceFiles } from "@drama/db/schema";
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ObjectStorage } from "@drama/storage/port";

type RouteContext = { params: Promise<{ playId: string; sourceId: string }> };
type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  storage: ObjectStorage;
};

export function createSourceHandler<TQueryResult extends PgQueryResultHKT>(dependencies: Dependencies<TQueryResult>) {
  return async function GET(_request: Request, context: RouteContext): Promise<Response> {
    let user: { id: string };
    try {
      user = await dependencies.authenticate();
    } catch (error) {
      if (error instanceof Error && error.name === "UnauthorizedError") {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      return Response.json({ error: "Unable to authenticate" }, { status: 500 });
    }
    const { playId, sourceId } = await context.params;
    const [source] = await dependencies.db.select({ id: sourceFiles.id, filename: sourceFiles.filename,
      sourceText: sourceFiles.sourceText, objectKey: sourceFiles.objectKey }).from(sourceFiles).where(and(
      eq(sourceFiles.id, sourceId), eq(sourceFiles.playId, playId), eq(sourceFiles.ownerUserId, user.id),
    )).limit(1);
    if (!source) return Response.json({ error: "Source not found" }, { status: 404 });
    if (source.sourceText !== null) {
      return Response.json({ source: { id: source.id, filename: source.filename, sourceText: source.sourceText } });
    }
    if (!source.objectKey) return Response.json({ error: "Source object is unavailable" }, { status: 404 });
    try {
      const bytes = await dependencies.storage.getPrivate(source.objectKey);
      return new Response(new Blob([Uint8Array.from(bytes).buffer]), { headers: {
        "content-type": sourceContentType(source.filename),
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(safeFilename(source.filename))}`,
        "cache-control": "private, no-store",
      } });
    } catch {
      return Response.json({ error: "Unable to load private source" }, { status: 500 });
    }
  };
}

function sourceContentType(filename: string): string {
  if (filename.toLowerCase().endsWith(".txt")) return "text/plain; charset=utf-8";
  return filename.toLowerCase().endsWith(".pdf")
    ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

function safeFilename(filename: string): string {
  const safe = filename.replace(/[\r\n]/g, "").slice(0, 255);
  return safe || "script";
}
