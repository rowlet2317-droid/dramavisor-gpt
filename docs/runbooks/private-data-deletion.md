# Private data deletion

## Actor-initiated account deletion

1. The actor submits `DELETE /api/account/delete` with their current password. The endpoint must reject missing or incorrect passwords.
2. The service sets `users.account_status` to `deleting`, revokes all sessions, and stops/revokes persisted realtime grants in the same transaction.
3. The service snapshots the exact private-object inventory into `account_deletions` and queues one `delete_account` job. A repeated request is idempotent and does not create another inventory or job.
4. The worker deletes every inventory object (including immutable normalized-audio versions). If any deletion fails, it must not delete database records; retry after the provider issue is resolved.
5. Once every object deletion resolves, the worker deletes the user row, letting foreign-key cascades remove account data. It retains one nonidentifying audit record with the deletion UUID, completion time, and object count only.

## Verification

- Confirm sessions are revoked and no `active` account can sign in after the status changes to `deleting`.
- Confirm the stored inventory exactly matches the source-file, take, and normalized-audio object keys at request time.
- Confirm private storage rejects reads for each inventory item before verifying the database cascade.
- Confirm a second worker completion attempt returns safely without adding an audit record.

## Never do

- Do not log transcript text, script text, notes, audio bytes, credentials, or provider request bodies.
- Do not manually delete database rows before object deletion is confirmed.
- Do not retain email, user ID, scripts, recordings, or notes in the deletion audit.
