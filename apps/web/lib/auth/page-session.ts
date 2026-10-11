import { redirect } from "next/navigation";

import { requireUser } from "./session";

type User = { id: string };

export async function requirePageUser(
  loadUser: () => Promise<User> = requireUser,
  redirectToSignIn: (path: string) => never = redirect,
): Promise<User> {
  try {
    return await loadUser();
  } catch (error) {
    if (error instanceof Error && error.name === "UnauthorizedError") {
      return redirectToSignIn("/sign-in");
    }
    throw error;
  }
}
