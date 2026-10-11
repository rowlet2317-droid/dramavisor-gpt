export const OPERATIONAL_EVENT_FIELDS = [
  "playId",
  "takeId",
  "jobId",
  "state",
  "status",
  "eventCode",
  "durationMs",
  "byteCount",
  "modelId",
  "retryCount",
  "userHash",
  "sessionHash",
] as const;

export type OperationalEventField = typeof OPERATIONAL_EVENT_FIELDS[number];
export type OperationalEvent = {
  type: string;
  fields: Partial<Record<OperationalEventField, string | number>>;
};

export function isOperationalEventField(value: string): value is OperationalEventField {
  return (OPERATIONAL_EVENT_FIELDS as readonly string[]).includes(value);
}
