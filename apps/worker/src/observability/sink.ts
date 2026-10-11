import { isOperationalEventField, type OperationalEvent } from "@drama/domain/operational-events";

const EVENT_TYPE = "worker.fatal";
const STATE = "failed";
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

type Sink = (line: string) => void;

/** App-owned worker stderr uses this allowlisted serialization boundary only. */
export function emitWorkerFatalEvent(error: unknown, sink: Sink = (line) => process.stderr.write(`${line}\n`)): void {
  const eventCode = safeErrorCode(error);
  const fields: OperationalEvent["fields"] = {};
  if (isOperationalEventField("state")) fields.state = STATE;
  if (eventCode && isOperationalEventField("eventCode")) fields.eventCode = eventCode;
  sink(JSON.stringify({ type: EVENT_TYPE, fields }));
}

function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : undefined;
}


export function emitWorkerJobFailureEvent(input: {
  jobId: string;
  jobKind: string;
  error: unknown;
}, sink: Sink = (line) => process.stderr.write(`${line}\n`)): void {
  const eventCode = safeErrorCode(input.error) ?? "UNCLASSIFIED_JOB_FAILURE";
  const fields: OperationalEvent["fields"] = {};
  if (isOperationalEventField("state")) fields.state = STATE;
  if (isOperationalEventField("jobId")) fields.jobId = input.jobId;
  if (isOperationalEventField("eventCode")) fields.eventCode = eventCode;
  sink(JSON.stringify({ type: `worker.job_failure.${input.jobKind}`, fields }));
}
