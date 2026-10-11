# Provider failure

## Scope

Use this runbook when the parser, study, transcription, coaching, realtime credential, or storage provider fails or returns an invalid response. Do not place script text, transcript text, audio, prompts, credentials, or provider request bodies in tickets or operational events.

## Immediate response

1. Identify the affected job or rehearsal session using only its hashed actor/session identifier and opaque job or play ID.
2. Check the job's state and retry count. Retryable worker failures remain queued; terminal failures become `action_required` after the configured retry limit.
3. For realtime credential failures, return the existing 502/503 response and ask the actor to retry. Never expose a provider credential to diagnose the problem.
4. Emit only the redacted event fields: state code, duration, byte count, model ID, retry count, opaque IDs, and hashed actor/session IDs.

## Recovery and escalation

- Confirm provider status through the provider's service-status channel without copying private payloads.
- A direct browser/provider termination cannot be fully reproduced from a provider endpoint alone: browser media,
  data-channel, and page-lifecycle teardown may suppress the client-side event. Verify recovery with the
  production-shaped browser fixture or a controlled nonproduction session; record only the resulting state and
  opaque identifiers.
- Re-run an idempotent job only from its persisted input and owner partition.
- If an object delete fails, leave account or play database content intact and retry the object operation. Do not force a cascade.
- Escalate after repeated failure with the redacted event, UTC interval, model ID, and retry count.

## Exit criteria

The affected job completes, the actor sees the normal completed/limited state, and the incident record contains no private content.
