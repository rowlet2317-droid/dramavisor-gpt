import { verifyPassword } from "../../../../lib/auth/password";
import {
  createBearerToken,
  hashBearerToken,
  readSessionToken,
  sessionCookie,
  SESSION_TTL_MS,
} from "../../../../lib/auth/session";

type SignInAuth = {
  findUserByEmail(email: string): Promise<{
    id: string;
    email: string;
    passwordHash: string;
    accountStatus: "active" | "deleting";
  } | null>;
  rotateSession(input: {
    ownerUserId: string;
    previousTokenHash?: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<boolean>;
};

export function createSignInHandler(
  auth: SignInAuth,
  now: () => Date = () => new Date(),
  verify: typeof verifyPassword = verifyPassword,
) {
  return async function POST(request: Request): Promise<Response> {
    const formSubmission = request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") ?? false;
    const body = formSubmission
      ? Object.fromEntries(await request.formData().catch(() => new FormData()))
      : await request.json().catch(() => null) as { email?: unknown; password?: unknown } | null;
    if (!body || typeof body.email !== "string" || typeof body.password !== "string") {
      return Response.json({ error: "Invalid request" }, { status: 400 });
    }
    if (Buffer.byteLength(body.password, "utf8") > 1_024) {
      return Response.json({ error: "Invalid request" }, { status: 400 });
    }

    const user = await auth.findUserByEmail(body.email);
    if (!user || user.accountStatus !== "active" || !(await verify(body.password, user.passwordHash))) {
      return Response.json({ error: "Invalid email or password" }, { status: 401 });
    }

    const signedInAt = now();
    const rawSessionToken = createBearerToken();
    const sessionExpiresAt = new Date(signedInAt.getTime() + SESSION_TTL_MS);
    const previousToken = readSessionToken(request.headers.get("cookie"));
    const issued = await auth.rotateSession({
      ownerUserId: user.id,
      previousTokenHash: previousToken ? hashBearerToken(previousToken) : undefined,
      tokenHash: hashBearerToken(rawSessionToken),
      expiresAt: sessionExpiresAt,
      now: signedInAt,
    });
    if (!issued) return Response.json({ error: "Invalid email or password" }, { status: 401 });

    const cookie = sessionCookie(rawSessionToken, sessionExpiresAt, signedInAt);
    if (formSubmission) {
      return new Response(null, { status: 303, headers: { location: "/plays", "set-cookie": cookie } });
    }
    return Response.json({ user: { id: user.id, email: user.email } }, { headers: { "set-cookie": cookie } });
  };
}
