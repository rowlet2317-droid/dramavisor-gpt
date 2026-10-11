import { createHash } from "node:crypto";

import { isOperationalEventField, type OperationalEvent } from "@drama/domain/operational-events";

const HASHED_IDENTIFIERS = new Map<string, "userHash" | "sessionHash">([
  ["userId", "userHash"],
  ["ownerUserId", "userHash"],
  ["sessionId", "sessionHash"],
  ["rehearsalSessionId", "sessionHash"],
]);

/** Builds a safe-to-serialize event; non-operational fields are never copied. */
export function redactOperationalEvent(type: string, input: Record<string, unknown>, salt: string): OperationalEvent {
  const fields: OperationalEvent["fields"] = {};
  for (const [key, value] of Object.entries(input)) {
    const hashKey = HASHED_IDENTIFIERS.get(key);
    if (hashKey && typeof value === "string") {
      fields[hashKey] = hashIdentifier(value, salt);
      continue;
    }
    if (isOperationalEventField(key) && (typeof value === "string" || typeof value === "number")) {
      fields[key] = value;
    }
  }
  return { type, fields };
}

function hashIdentifier(value: string, salt: string): string {
  return createHash("sha256").update(salt).update("\0").update(value).digest("hex");
}
