---
title: Routing transparency
description: Per-response routing and model usage in the web chat.
---

# Routing transparency

In **Admin → Providers**, enable **Show routing information in chat**. The
`routing.showRoutingInfo` setting defaults to `false`. It controls presentation;
routing policy, accounting, and persisted evidence remain active when hidden.

Each model-backed response has expandable tags showing its routing strategy
(direct, concierge, or tiered), final model, catalog execution zone, token count,
and model cost. While a request runs, the tags show the current attempt. The
expanded view lists each recorded execution and auxiliary-model attempt with its
reason, tier, status, duration, input/output tokens, and available cache counts.
Concierge and other in-turn auxiliary calls appear as overhead. Retries and
escalations contribute to the totals. Routing metadata survives reloads and
session branching; older messages without records display no tags.

These are execution records, not generated explanations. No PII detector or new
privacy, speed, cost, or Auto mode is introduced by this feature. An execution
zone is catalog metadata, not an independent attestation of where data traveled.

## Cost and token semantics

- Provider-reported costs are shown without an estimate prefix.
- Catalog-rate prices and explicitly estimated costs carry `Est.`. Estimated
  token counts carry `≈`.
- Unknown usage or missing prices remain unavailable, including for local models.
  They must not be interpreted as zero cost. A known zero remains zero.
- Totals include all recorded model attempts, including failures, retries, and
  in-turn auxiliary calls. These are model-usage totals; local hardware costs,
  media-generation charges, and other non-model tool charges are outside them.
- Catalog estimates use the same token-rate basis as the existing usage ledger;
  cache discounts may differ from an eventual invoice. Cache counts are shown
  separately and are not added again to input/output totals.
- Calls that throw without returning usage remain unknown. Detached background
  work that finishes after the response is not attributed to that response.

## Storage and boundaries

A request-local collector isolates concurrent turns. Completed metadata is
redacted, attached to the assistant row as `routing_trace_json`, and recorded in
a `route.completed` audit event. Schema migration 60 adds the nullable column;
branching copies it. No prompt text, tool payloads, or model reasoning is stored
in routing records. The presentation switch filters both live results and chat
history. It is not an authorization boundary for the underlying admin audit log.

Telemetry persistence failures are logged and must not discard a completed answer.

## Acceptance checks

1. Enable the switch, run local and cloud requests, and inspect tags and details.
2. Force a test provider failure followed by a successful escalation. Confirm
   both attempts and their usage remain visible, including after reload.
3. Disable the switch. Confirm live/history responses hide the metadata while
   database records and usage collection continue; re-enable to reveal it again.
4. Use an unpriced model. Confirm the UI says unavailable rather than free.
5. Exercise two concurrent sessions, branch a conversation, and migrate an older
   database. Confirm records remain attached to the correct assistant messages.

No gateway restart, provider credential change, or routing policy change is needed
for the visibility setting itself.

## Configure tiers in the console

Open **Providers → Model routing** (`/admin/models#model-routing`). Add a tier,
name it, and select its first model. Optional backup models are tried in their
listed order. Add further tiers and use the arrow buttons to order them. Choose
**Start new requests at**, enable **Automatic model routing**, then **Save routing**.
Saving also registers selected discovered remote models in their provider model
lists, so routing validation and the picker agree after a reload. Existing models
and provider settings are preserved. Changes remain a draft until saved; **Discard changes** restores the saved ladder.

An agent's default model can determine its starting tier. A model explicitly
selected in chat bypasses the ladder. For a manual test, enable routing visibility,
open a chat, run `/model clear`, and send a request. Inspect the routing tags.
Use `/escalate` before another request to test the next tier. Automatic fallback
requires a failure safe to retry; reordering tiers does not force an escalation.

**Session Routing** in general configuration controls conversation grouping and
identity, not model selection. The tier editor preserves concierge settings,
visibility, and escalation stickiness when saving.
