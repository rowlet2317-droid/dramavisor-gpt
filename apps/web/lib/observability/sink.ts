import { redactOperationalEvent } from "./redact";

const EVENT_TYPES = new Set(["realtime.provider_failure", "realtime.authentication_failure"]);
const STATES = new Set(["failed", "unauthorized"]);
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

type Sink = (line: string) => void;

export function emitOperationalEvent(input: {
  type: string;
  state: string;
  error?: unknown;
  userId?: string;
  sessionId?: string;
  // eslint-disable-next-line no-console -- this sink receives only the redacted event serialized below
}, sink: Sink = (line) => console.error(line), salt = process.env.OPERATIONAL_EVENT_SALT ?? "unset") {
  if (!EVENT_TYPES.has(input.type) || !STATES.has(input.state)) return;
  const eventCode = safeErrorCode(input.error);
  const event = redactOperationalEvent(input.type, {
    state: input.state,
    ...(eventCode ? { eventCode } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  }, salt);
  sink(JSON.stringify(event));
}

export function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : undefined;
}
