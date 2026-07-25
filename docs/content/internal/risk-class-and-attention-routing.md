---
title: Risk Class And Attention Routing — Design Addendum
description: Two structural changes to Approvals v2 — a side-effect taxonomy (read/write_local/exec/external) alongside the green/yellow/red severity scale, and splitting the autonomy ceiling from where the human is reached (inline vs queued attention).
---

> **Internal document.** Addendum to `approvals-v2-design.md`. Status: **Proposal**
> (2026-07-24).

# Risk Class and Attention Routing

Addendum to `approvals-v2-design.md` (branch `claude/approvals-v2`, not yet on
`main`). Two changes to that proposal, both structural rather than additive:
give the pipeline a side-effect taxonomy alongside its severity scale, and
split "how much may the agent do" from "where does the human get asked".

Neither idea is new machinery — both re-express state the approval pipeline
already computes, so the cost is in the declaration and the tests, not in a
new engine.

## 1. Risk class — what kind of side effect, not how scary

`ApprovalTier` (`green | yellow | red`, `src/types/execution.ts:82`) is a
severity scale. It answers "how loud should this be" and nothing else. The
orthogonal question — *what kind of blast radius does this call have* — is
currently spread across three fields of `ClassifiedAction`
(`container/src/approval-policy.ts:155`): `writeIntent`, `pathHints`,
`hostHints`, plus string matching on `actionKey`. Every rule that needs the
answer re-derives it: `pinned_red` for path safeguards, `red_promotable` and
`stickyYellow` for promotion eligibility, `full_auto.never_approve`, and the
durable-trust rules for what may be granted "for all".

Add one declared field:

```ts
export type RiskClass =
  | 'read'         // no side effects
  | 'write_local'  // mutates the filesystem inside the workspace fence
  | 'exec'         // runs a command (shell, container exec)
  | 'external';    // side effects off this machine — messages, API writes, A2A sends
```

`riskClass` and `tier` are independent. A `read` can be red (reading
`~/.ssh/id_rsa`); an `external` can be green (an `allow` rule for
`slack:C0123`). Severity is *policy output*; class is *call input*.

### What falls out mechanically

The point of the field is that it turns several hand-maintained name lists
into type-level facts:

| Class | Durable grant eligibility | Scoping key |
| --- | --- | --- |
| `read` | n/a — never prompts except via `pinned_red` | — |
| `write_local` | only with an explicit `paths:` glob under the fence | path |
| `exec` | only with an explicit `command:` glob; never wildcard | command prefix |
| `external` | target-bound rule (`tool + exact target`) | target address |

`external` is the only class with a stable, nameable target — a channel
address, a recipient, a host, a peer agent id. That is precisely why it is the
only class where "always allow this" is safe to offer as a one-tap grant, and
why shell must keep asking unless the operator wrote a glob by hand. Today
that distinction lives in reviewers' heads and in the `pinned_red` default
list; making it a class means a new tool inherits the right behavior without
anyone remembering to add it to a list.

Concretely, in the §2 grant writer of approvals-v2: a "yes for all" reply mints
a rule only if `riskClass === 'external'` and the tool declares a target
argument. Everything else stays a one-time or session approval, fail-closed.

### Landing it

1. `classify_action` sets `riskClass` from the existing action-key table plus
   `writeIntent`/`hostHints`. Derivable for every shipped tool; no config.
2. Emit it on `ToolExecution` and every tool-execution audit event, next to
   `approvalTier`.
3. Ship steps 1–2 with **no gating behavior** first. That validates the
   taxonomy against real traffic (and against the anomaly reranker's
   trajectories) before anything depends on it.
4. Then move grant eligibility, `never_approve`, and promotion eligibility to
   read the class instead of re-deriving.

Tools declaring their own class (plugins, MCP) resolve as: user-local override
→ declared class → conservative default. MCP tools default to `external`,
which is the safe reading of an unknown remote tool and matches how
`requires_approval` metadata is treated today.

## 2. Attention routing is not autonomy

`full` mode / `/fullauto` currently conflates two independent things:

- **Autonomy ceiling** — how much the agent may do without a human.
- **Attention routing** — where a human gets asked, and whether one is
  present at all.

The practical cost shows up in scheduled runs. When a cron-fired turn hits a
red prompt at 03:00 the only levers are "raise the mode so it doesn't ask" or
"let the prompt expire into a denial". Both are wrong answers to "the person
is asleep". `escalationTarget` is the only routing primitive we have, it is
per-agent, and it is undocumented (approvals-v2 §3 already moves it).

Add a second per-session axis:

```yaml
approval:
  mode: auto            # ask | auto | full | custom   — the autonomy ceiling
  attention: inline     # inline | queued              — where the human is reached
```

- `inline` (default): prompts render in the session that raised them; the
  requester answers; today's behavior exactly.
- `queued`: the session is unattended. Anything that would prompt inline
  becomes a queued item, the turn suspends, and the composer is disabled.

**The contract, and it is the whole point: `queued` never raises the ceiling.**
A red prompt under `mode: ask` with `attention: queued` still blocks. It
blocks in the queue instead of on screen. Turning on "I'm away" must never be
a way to grant autonomy, and today's `/fullauto` is exactly that.

This is also what makes approvals-v2 §3 (Approvers) implementable without
special cases:

- `inline` + approvers → requester waits, designated approver answers from
  wherever they are.
- `queued` + `approvers.escalate` → the item is routed to the security
  channel and resolved there.

Both are the same record resolved by the same chokepoint.

### Landing it on `pending-approvals.ts`

`PendingApprovalPrompt` (`src/gateway/pending-approvals.ts:24`) is already
most of a queue: per-session records, TTL, durable persistence via runtime
assets. Three deltas:

1. **`visibility: 'inline' | 'queued'`** on the record. `attention` is the
   per-session default that stamps it at creation.
2. **Cross-session listing.** Today the map is keyed one-prompt-per-session
   (`pendingApprovalBySession`); a queue needs "everything waiting on me,
   across sessions", which is what the console Approvals page and
   `/approvals` should both render.
3. **TTL semantics must differ by visibility.** `APPROVAL_PROMPT_DEFAULT_TTL_MS`
   is 120s (`src/gateway/pending-approvals.ts:11`), which is right for an
   inline prompt and wrong for a queued one — a queued item silently aging
   into a denial while the operator is asleep is the failure mode this axis
   exists to prevent. Queued items get no TTL, and `expired` becomes a state
   distinct from `denied`.

`authorizeApprovalResponse` (approvals-v2 §3) then becomes the single resolver
for every transport. Make its contract explicit and test it: **`pending →
resolved` exactly once, idempotent, first-responder-wins.** Discord buttons,
Slack buttons, `/approve`, plain-text `yes`, voice, and the console card are
transports of one record — never parallel registries. The current
`claimPendingApprovalByApprovalId` ownership check exists only on Discord and
Slack buttons, so the race is reachable today.

Generalizing the record's `kind` beyond approvals (`question`, `notification`,
`plan`) is the natural follow-on but is not required for this split; keep it
out of the first PR.

### Managed overlay

The platform overlay (approvals-v2 §4) may pin `attention` the same way it
pins `mode_max` — an unattended fleet can be forced to `queued` so no run can
ever park a prompt where nobody is looking.

## Phasing delta

Against the five phases in `approvals-v2-design.md`:

- **Phase 1 (Mode)** — unchanged, plus `riskClass` on `ClassifiedAction` and
  audit events, observability only.
- **Phase 2 (Grants → policy)** — grant eligibility keyed on `riskClass` per
  the table above, replacing the name lists.
- **Phase 2.5 (new)** — `attention` axis; `visibility` + TTL split on
  `pending-approvals.ts`; `/approvals attention <inline|queued>`; `/fullauto`
  folds into `mode`, not into this.
- **Phase 3 (Approvers)** — unchanged, but `authorizeApprovalResponse` now
  resolves queue items and its idempotency contract is tested.
- **Phase 4–5** — unchanged; overlay gains `attention`.

## Open questions

- Does `read` short-circuit the pipeline? It cannot skip `pinned_red` (reading
  `~/.ssh/id_rsa` is red). Recommendation: `read` runs `pinned_red` and then
  returns green, skipping stakes/anomaly/trust — a measurable latency win on
  the most common call class.
- Is an A2A send `external`, or its own class? Recommendation: `external`,
  target = peer agent id; it needs the same target-bound grant shape.
- Does `queued` disable the composer, or allow steering without answering?
  Recommendation: disable, matching the "the human is not here" premise;
  revisit if operators want to redirect a parked run.
