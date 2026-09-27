---
title: Approval State Out of the Workspace — Design Note
description: Move approval policy, durable grants, pending approvals, and per-session guard state out of the agent-writable workspace into gateway-owned storage that the agent container reads read-only, with the gateway as the only writer. Sequenced with the approvals-v2 grants-to-policy phase.
---

> **Internal document.** Status: **Proposal** (2026-09-27). High-risk area
> (`container/src/approval-policy.ts`, `src/infra/`). Builds on work that is
> not on `main` yet: the approval-state guard, the per-session state dir, and
> the pending-approval store
> ([HybridAIOne/hybridclaw#1622](https://github.com/HybridAIOne/hybridclaw/pull/1622)),
> and the approvals-v2 design (`approvals-v2-design.md`, not yet committed; its
> addendum [risk-class-and-attention-routing.md](./risk-class-and-attention-routing.md)
> is on `main`). Code anchors are verified against `main` at `c879c35b1`.

# Approval State Out of the Workspace

## Problem

The approval runtime keeps its state in the agent workspace:

| State | Path in the workspace | Written by | Read by |
| --- | --- | --- | --- |
| Operator policy | `.hybridclaw/policy.yaml` | Gateway (policy commands, admin API, remote policy, seeding), operators by hand | Worker, reloaded when its mtime changes, on every tool call; gateway checks listed below |
| `yes for agent` grants | `.hybridclaw/approval-agent-trust.json`, legacy `.hybridclaw/approval-trust.json` | Worker | Worker, once at start |
| `yes for all` grants | `approval-trust.json` | Worker | Worker, once at start |
| Pending approvals | `.hybridclaw/pending-approvals.json` | Worker | Worker |
| Fetched-files guard set | `.hybridclaw-runtime/sessions/<hash>/fetched-files.json` (unmerged) | Worker | Worker |

The gateway also enforces parts of `policy.yaml` on the agent's behalf:

- secret injection (`secret.*`, `src/security/secret-policy.ts:124`)
- private-network targets of the HTTP proxy (`network`,
  `src/gateway/gateway-http-proxy.ts:389`)
- skill availability (`skill.rules`)
- browser stealth
- the full-auto exclusions that it sends back to the worker
  (`full_auto.never_approve`)

The workspace is mounted read-write (`src/infra/container-runner.ts:766`) and
is the shell's working directory. The 2026-09-26 guard pins tool calls whose
arguments name these paths. It cannot see a path that a program builds at run
time, and interpreter commands are yellow. `python3 -c …`, `node -e …`, and
`python3 x.py` classify as `bash:other` and run with narration only (verified
2026-09-27; see `tests/approval-policy-bash.test.ts:193`). The threat model
therefore has to assume that a prompt-injected agent runs code in the sandbox
without a human. Code that writes one of these files changes what every later
call of every session of the agent needs. It also changes checks the gateway
makes, and the change outlives the session.

## Goal and boundary

Invariant, container mode: **approval state has one writer, the gateway, and
the sandbox has no write path to it.** The gateway never takes a durable
decision from anything the worker reports. A grant exists only because the
gateway resolved a human reply itself.

The worker process and the commands it runs share a container and a uid, and
the worker must be able to write its IPC directory. Code the agent runs can
therefore influence the worker's decisions for its own session. This design
does not change that. It guarantees that nothing the sandbox does outlives the
worker or reaches another session or agent, and that operator policy cannot be
changed from inside. Moving the files is necessary but not sufficient: the
sandbox must also have no other write route to the same state (step 0).

## 1. Where the state lives and how the worker reads it

**Home.** The state lives in `DATA_DIR/agents/<workspace id>/approval/`, a
sibling of `workspace/`. No container mounts it today: only `workspace/` is
mounted (`src/infra/ipc.ts:44`, `:88`). It is keyed like the workspace because
policy is per workspace today: agents can share a workspace through
`agent.workspace`, and rules carry `agent:` scopes. The directory holds
`policy.yaml`, and after step 3 the grants inside it. Per-session state goes to
gateway storage, not to this directory.

**Read path.** The directory is bind-mounted read-only at
`/hybridclaw/approval`, and `HYBRIDCLAW_AGENT_APPROVAL_DIR` names it; in host
mode that variable holds the host path. The gateway creates the directory
before spawn, with the same ownership and modes the workspace files have
today. Mount the directory, not the file: the gateway replaces files by
rename, and a file mount would keep showing the old inode. The container
already runs `--read-only --cap-drop=ALL` (`container-runner.ts:758`), so the
sandbox cannot remount it. The trajectory store is the precedent for a
gateway-owned `:ro` mount (`container-runner.ts:776`).

Why a mount rather than `ContainerInput`:

1. Warm containers are started per agent before any session exists. The agent
   id and workspace mount are fixed at spawn, and a claim matches on agent id
   (`src/infra/warm-runner-utils.ts:373`). Agent-scoped state fits that model;
   nothing session-specific is needed.
2. `policy_reload` keeps working. An operator edit, or a grant made in another
   session, applies from the next tool call, even mid-turn. Through
   `ContainerInput` it would wait for the next turn, and grants from other
   sessions would need a second channel.
3. The mount does not depend on the IPC input path. The worker must be able to
   write that path, because it deletes `input.json` after reading it
   (`container/src/ipc.ts:36`).
4. No bulk fields are added to `ContainerInput`. That type exists as two
   hand-copied definitions (`src/types/container.ts`,
   `container/src/types.ts`), which have already drifted (`memoryCitations`,
   `provider`) and are not compared by any test.

Small per-session state travels in `ContainerInput`: the session's open
approvals, the resolved decision, and the fetched-files set. It matters only
inside the worker's own trust domain. Define these shapes once in
`container/shared/approval-state.{js,d.ts}` and reference them from both type
files (AGENTS.md §3.3) instead of adding hand copies.

**One path, one writer.** Every gateway reader resolves the file through one
helper. Today they pass a workspace to `resolveWorkspacePolicyPath`
(`src/policy/policy-store.ts:383`), with two exceptions:

- The `hybridclaw policy` CLI edits `./.hybridclaw/policy.yaml` in its own
  working directory (`src/policy/policy-cli.ts`).
- The camofox stealth check falls back to the process working directory
  (`src/browser/camofox-provider.ts:137`).

Writes go through one module that serializes them and replaces the file
atomically with `writeMemoryFileAtomic` (`container/shared/memory-file.js`).
Today three modules read, modify, and rewrite the file with plain
`writeFileSync`: `policy-store.ts:348`, `secret-route-policy.ts:48`, and
`remote-policy-authority.ts:690`. A worker that reloads during such a write
can read a truncated file, or fail to parse it and fall back to the defaults
(`container/src/approval-policy.ts:803`). Once grants live in the file
(step 3), writes become frequent, so this matters more.

## 2. Writing grants and pending approvals

The rule: the worker proposes, the gateway records, and only a human reply
that the gateway resolved creates trust.

**Pending approvals.** The worker already streams each new prompt to the
gateway as an `[approval]` stderr line before the turn ends
(`container/src/tool-approval.ts:39`, parsed at `container-runner.ts:287`). It
repeats the prompt in `ContainerOutput.pendingApproval`.

- Extend that payload with the fields a replay needs: tool name, arguments,
  action key, fingerprint, pinned flag, and original prompt.
- Record it at the runner callback in the gateway's existing prompt store,
  `src/gateway/pending-approvals.ts`, which persists to the runtime revisions
  DB (`:111`). That store is populated today only on channel routing paths
  (`src/gateway/gateway.ts:520`), not for web chat. It holds one prompt per
  session today and becomes a list keyed by approval id.
- Upsert on the stream line, and treat the output field as an idempotent
  fallback.
- The worker stops writing `pending-approvals.json`, and the stateless branch's
  `pending-approval-store.ts` is no longer needed.

**Replies.** One gateway function resolves every approval reply before the
turn is dispatched. That covers plain text (today it reaches the worker
unparsed), `/approve`, TUI shortcuts, and channel or web buttons. It parses the
reply with the existing parser, moved from `approval-policy.ts` to
`container/shared/`, and matches only the replying session's records. Then:

- For `yes`, `yes for session`, and `no`, it marks the record resolved and
  passes `approvalDecision` (the record plus the scope) in `ContainerInput`.
  The worker records the one-shot fingerprint or session trust and replays the
  call, as `handleApprovalResponse` does today.
- For `yes for agent` and `yes for all`, it first writes the grant to
  gateway-owned storage, then dispatches the same way. Pinned records fall back
  to a one-time approval, as they do today.

This is the `authorizeApprovalResponse` chokepoint of approvals-v2 phase 3,
without the approver identity check. Phase 3 then adds a check to one function
instead of rerouting every reply path. Resolving against the replying
session's records also fixes cross-session replies at the source.

**Crash behavior:**

| Failure point | Result |
| --- | --- |
| The worker dies before it streams the prompt | No prompt was shown; the model asks again next turn |
| The worker dies after streaming, before its output | The gateway has the record, the human can still answer, and the next worker replays the call |
| The worker dies after the gateway wrote a grant, before the replay | The grant stands; the next attempt runs without a prompt |
| The worker dies after a one-time approval, before the replay | The record is spent and the call did not run; the retry prompts again (fails closed) |
| The gateway restarts | Records (revisions DB) and grants (approval dir) survive |

No grant waits for a turn to end, so a crash cannot lose one halfway.

**Forged reports.** The sandbox can reach the worker's IPC files and stderr,
so the gateway treats `[approval]` lines and outputs as untrusted input. It
already checks their shape and redacts them (`container-runner.ts:287`). A
forged record can produce a prompt but never a grant.

One residual risk also exists today: forged prompt text can misdescribe the
call that a human approves "for all". Two changes narrow it. The v2 grant
writer shows the rule it will write (tool plus command or paths) instead of the
worker's prose. The risk-class addendum limits one-tap durable grants to
`external` targets.

**Guard state.** The fetched-files set becomes add-only session state:

- The worker reports each download on a `[session-state]` stderr line.
- The gateway appends it to the session's record.
- The set comes back to the worker in `ContainerInput`.

Because the set is add-only, a forged report can only make the guard stricter.
The shell's working directory stays in the workspace session dir. It is shell
state, not approval state, and the classifier and the shell read the same
value.

`yes for session` can stay in worker memory, as documented. If the owner
decides to persist it per session, the gateway record makes that cheap. The
question is still open from the stateless-gateway work.

## 3. Migration

- **Trigger.** Run once per install at gateway startup, after `listAgents()`
  (`src/gateway/gateway.ts:4400`), gated on a row in the existing `migrations`
  table (`recordMigration`, `src/memory/schema/migrations.ts:899`). Do not gate
  it on a missing target: the agent can recreate the old files, and that gate
  would copy them into the trusted location after an operator deletes the new
  file.
- **Per workspace.** Parse the old file, write the gateway-owned file
  atomically, read it back, then delete the source. Each step is idempotent,
  and the row is recorded after the last workspace, so a crash mid-run only
  repeats it.
- **Pending approvals** are not migrated; they expire after
  `approval_timeout_secs` (120 s by default), and the file is deleted. The
  fetched-files set is not on `main` yet, so it ships gateway-side from the
  start.
- **After the gate,** no code reads approval state from a workspace. New
  workspaces get the default policy in the new place: the seeding at
  `src/workspace.ts:37` moves.
- **Agent archives** pack `.hybridclaw/policy.yaml` and
  `pending-approvals.json` today, and install copies them unfiltered
  (`src/agents/claw-archive.ts:236`). Export instead takes the policy from the
  approval dir and drops pending approvals. Install writes the policy there as
  part of the operator's install action, never as workspace content. Whether
  install shows or limits the imported sections (for example, refusing
  `secret.default: allow`) is an owner call.
- **Compat marker.** The import step carries `// compat: remove after v0.35`,
  assuming it ships in 0.33; the extra minor covers skipped upgrades. After
  removal, a workspace that was never migrated falls back to the default
  policy. Lost grants fail closed, but lost operator deny rules and
  `pinned_red` additions fail open, so the CHANGELOG entry says to upgrade
  through 0.33 or 0.34.
- **One conversion per item.** `policy.yaml` moves once (step 1). The trust
  stores convert once, straight from the workspace into managed rules in the
  moved file (step 3, which is v2 phase 2). They are never moved as JSON.

## 4. Host sandbox mode

In host mode the worker runs as the gateway's OS user with no OS sandbox. Bash
is a plain `spawnSync` in the workspace (`src/infra/host-runner.ts:609`,
`container/src/bash-process.ts:57`). Any path the gateway can write, code the
agent runs can write. What remains:

1. **File tools.** `write`, `edit`, and `delete` take literal paths. Extend
   the approval-state guard to the approval dir and match it on the resolved
   real path, so symlinks cannot get around it. The guard then stays sound for
   these tools.
2. **Bash, interpreters, and stdio MCP servers** get only the static guard. It
   stops accidents, not an attacker.
3. **The move still helps.** The state leaves the agent's working directory,
   so workspace cleanups, `git` operations, and archive extraction no longer
   touch it.

There is no useful tamper detection: a hash or key the gateway could check is
as writable as the file it protects. `developer-guide/approvals.md` and
`SECURITY.md` should say plainly that host mode has no boundary around approval
state and that untrusted input belongs in container mode.

## 5. Fit with approvals-v2

- **The file must move by grants-to-policy.** v2 §2 writes grants into
  `.hybridclaw/policy.yaml`, and §3 and §4 put approvers and the managed
  overlay in the same file. If the file stays in the workspace, grants-to-policy
  merges two agent-writable stores into one, and an agent could name itself an
  approver or delete managed rules. So the file must be gateway-owned no later
  than grants-to-policy. Keep v2's one-file surface and change only where the
  file lives: amend v2's "three concepts" section and its phase 2 migration
  text.
- **The grant writer runs on the gateway,** at step 2's reply resolution
  point. Rules carry `agent:`, so `yes for agent` then applies to the agent. It
  no longer applies to every agent that shares the workspace, as the workspace
  trust file does today.
- **The queue builds on step 2.** The risk-class addendum's queued attention
  (phase 2.5) keeps queue items in `src/gateway/pending-approvals.ts`, and step
  2 makes that module the store of record.

## Plan

| Step | Change | Needs | Notes |
| --- | --- | --- | --- |
| 0 | Scope the gateway credential that is available inside the sandbox to the runtime routes the tools use, and bind it to its agent | — | Without it, moving the files does not meet the goal. Tracked separately |
| 1 | Move `policy.yaml`: approval dir, `:ro` mount, env var, one path helper and one atomic writer for the gateway, seeding, archives, migration | 0 | Largest gain for the size: the policy drives the worker pipeline and the gateway checks |
| 2 | The gateway resolves replies and owns pending approvals and the fetched-files set; the worker stops writing both | The stateless-gateway branch, whose pending store and session files this replaces | v2 phase 3 chokepoint, without identity checks |
| 3 | v2 phase 2: grants become managed rules in the moved file, written at step 2's resolution point; import both trust stores, then delete them and their load paths | 1, 2 | The only conversion of grant data |
| 4+ | v2 approvers (an identity check in step 2's function) and the managed overlay | 3 | |

The workspace patterns of the approval-state guard stay until step 3. After
it, the guard keeps only the approval dir, which host mode still needs.

**Tests** (boundary and failure mode, AGENTS.md §4):

- An agent-container e2e test shows that `python3 -c` cannot write to
  `/hybridclaw/approval`: the write fails as read-only.
- A forged `[approval]` line never produces a grant.
- A `yes for all` in session B cannot resolve session A's record.
- The grant is written before the replay turn is dispatched.
- Migration honors the gate row, can rerun after a mid-run crash, and ignores
  a workspace file recreated after the gate.
- Archive round trip: the policy comes from the approval dir, and install
  never reads it from workspace content.
- In host mode, the guard pins a file-tool write that reaches the approval dir
  through a symlink.

## Out of scope

- **Gateway checks for actions the gateway executes for the worker** (HTTP
  proxy, message send, scheduler). The gateway trusts the worker's approval
  decision today. Holding against code that runs in the sandbox needs a check
  of its own.
- **Persisting `yes for session`** is an open owner decision.
