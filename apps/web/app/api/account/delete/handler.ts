import { verifyPassword } from "../../../../lib/auth/password";

type DeleteAccountAuth = {
  findUserById(userId: string): Promise<{ id: string; passwordHash: string } | null>;
  requestAccountDeletion(input: { ownerUserId: string; now: Date }): Promise<{ status: "queued" | "not_found" }>;
};

type Dependencies = {
  authenticate: () => Promise<{ id: string }>;
  auth: DeleteAccountAuth;
  now?: () => Date;
  verify?: typeof verifyPassword;
};

export function createDeleteAccountHandler(dependencies: Dependencies) {
  return async function DELETE(request: Request): Promise<Response> {
    let user: { id: string };
    try {
      user = await dependencies.authenticate();
    } catch (error) {
      if (error instanceof Error && error.name === "UnauthorizedError") {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      return Response.json({ error: "Unable to authenticate" }, { status: 500 });
    }
    const body = await request.json().catch(() => null) as { password?: unknown } | null;
    if (!body || typeof body.password !== "string" || Buffer.byteLength(body.password, "utf8") > 1_024) {
      return Response.json({ error: "Invalid request" }, { status: 400 });
    }
    const account = await dependencies.auth.findUserById(user.id);
    if (!account || !await (dependencies.verify ?? verifyPassword)(body.password, account.passwordHash)) {
      return Response.json({ error: "Password reauthentication failed" }, { status: 401 });
    }
    const result = await dependencies.auth.requestAccountDeletion({ ownerUserId: user.id,
      now: (dependencies.now ?? (() => new Date()))() });
    if (result.status === "not_found") return Response.json({ error: "Account not found" }, { status: 404 });
    return Response.json({ status: "deletion_queued" }, { status: 202 });
  };
}
