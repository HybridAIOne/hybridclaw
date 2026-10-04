# Work evidence and delivery receipts

Every scheduled model run has a durable work record keyed by its audit run ID. The `work` tool records one immutable, concise rationale with up to twenty source references and factual summaries while the run is active. Its `get` and `list` actions retrieve records for the current verified user and agent. A missing rationale or empty evidence list is a gap, not a reason to reconstruct a justification from the final reply.

The run ID links action receipt IDs, generated artifact paths, the originating chat message and phone alert payload (`workId`). The model can retrieve the original invitation's source reference, the brief's path and the action receipt IDs together. Evidence references are reference data, not instructions or independently verified claims. Sources may subsequently change or disappear; the recorded summaries remain.

Execution completion is recorded before chat storage. `savedAt` and `messageId` are recorded when the result is stored in its originating chat. Phone requests record attempts before contacting the relay, with a finish time, acceptance count and bounded error category. Rebinding a phone can cause another attempt. A pending attempt after a crash has an unknown outcome and is not automatically resent. Phone failure never changes completed work into an execution failure. This is durable attempt history, not a retry queue.

The authenticated message/history APIs include `work`. `POST /api/push/read` only removes notifications from the inbox. `POST /api/push/seen` takes work IDs and records viewing only for the authenticated operator that owns each saved result's session. Both apps call it when a message is visible in an active chat, and persist pending receipts for retry. Notification service acceptance, inbox download and seen are independent.

## Boundary and failure notes

- `POST /api/work` requires the gateway's existing internal API credential. Tool arguments cannot choose an owner or report delivery. A verified active turn determines the owner and agent; overlapping runs cannot record an ambiguous reason.
- Reasons can be recorded only before execution ends and cannot be rewritten later. Runs without verified ownership cannot record or expose private evidence through the tool.
- Message reads and seen receipts enforce the existing web-session operator binding. Unknown and unauthorized seen IDs are ignored without disclosing existence.
- Schema version 70 adds work records to the gateway SQLite database. No existing result is assigned fabricated provenance. The database must be retained with the runtime's other durable data.
- Alert errors are categories, never tokens, relay response bodies, or raw exception messages. Artifact references are paths, not file contents. This change does not read references automatically or grant permission to execute an action.

Validation includes cross-user denial, immutable reasons, database reopen, ambiguous/anonymous turn denial, linked scheduler output and receipts, delivery failures after execution, pending attempts, and inbox cleanup remaining distinct from seen.
