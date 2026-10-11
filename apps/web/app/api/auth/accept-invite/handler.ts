import type { AcceptInviteInput, AcceptInviteResult } from "@drama/db/repositories/auth";

import { hashPassword } from "../../../../lib/auth/password";
import {
  createBearerToken,
  hashBearerToken,
  sessionCookie,
  SESSION_TTL_MS,
} from "../../../../lib/auth/session";

type AcceptInviteAuth = {
  acceptInvite(input: AcceptInviteInput): Promise<AcceptInviteResult>;
};

export function createAcceptInviteHandler(auth: AcceptInviteAuth, now: () => Date = () => new Date()) {
  return async function POST(request: Request): Promise<Response> {
    const formSubmission = request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") ?? false;
    const body = formSubmission
      ? Object.fromEntries(await request.formData().catch(() => new FormData()))
      : await request.json().catch(() => null) as { token?: unknown; password?: unknown } | null;
    if (!body || typeof body.token !== "string" || typeof body.password !== "string") {
      return Response.json({ error: "Invalid request" }, { status: 400 });
    }
    const passwordBytes = Buffer.byteLength(body.password, "utf8");
    if (passwordBytes < 12 || passwordBytes > 1_024) {
      return Response.json({ error: "Invalid request" }, { status: 400 });
    }

    const acceptedAt = now();
    const rawSessionToken = createBearerToken();
    const sessionExpiresAt = new Date(acceptedAt.getTime() + SESSION_TTL_MS);
    const result = await auth.acceptInvite({
      tokenHash: hashBearerToken(body.token),
      passwordHash: await hashPassword(body.password),
      sessionTokenHash: hashBearerToken(rawSessionToken),
      sessionExpiresAt,
      now: acceptedAt,
    });

    if (result.status === "invalid") {
      return Response.json({ error: "Invite not found" }, { status: 404 });
    }
    if (result.status === "expired") {
      return Response.json({ error: "Invite expired" }, { status: 410 });
    }
    if (result.status === "used") {
      return Response.json({ error: "Invite already used" }, { status: 409 });
    }
    if (result.status === "existing_user") {
      return Response.json({ error: "Account already exists" }, { status: 409 });
    }

    const cookie = sessionCookie(rawSessionToken, sessionExpiresAt, acceptedAt);
    if (formSubmission) {
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie } });
    }
    return Response.json({ user: { id: result.user.id, email: result.user.email } },
      { status: 201, headers: { "set-cookie": cookie } });
  };
}
