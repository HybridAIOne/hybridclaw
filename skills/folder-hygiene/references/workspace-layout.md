# Canonical Workspace Layout

This document is the grounding reference for how an LLM should place files in a
HybridClaw workspace. It is guidance for judgment, not a checker, JSON schema,
or list of file globs to enforce. When placement is ambiguous, use `inbox/`
rather than guessing.

The top-level bootstrap files below are mirrored from
[`templates/`](../../../templates/). If that directory changes, update this
reference so workspace guidance stays aligned with runtime bootstrap behavior.

## Top-Level Files

These files belong at the workspace root. They are durable context files or
runtime startup instructions, not general storage buckets.

| File | Purpose | Who Writes It | Lifecycle |
| --- | --- | --- | --- |
| `IDENTITY.md` | Agent identity: name, self-description, tone, avatar, and related metadata. | Agent during onboarding; user or agent for explicit identity changes. | Long-lived; update rarely and intentionally. |
| `SOUL.md` | Agent behavior, boundaries, and working style. | Template author initially; user or agent when behavior expectations change. | Long-lived; avoid casual churn. |
| `USER.md` | Stable user facts, preferences, timezone, work context, and durable notes. | Agent during onboarding and when the user provides durable context. | Long-lived; keep concise and respectful. |
| `MEMORY.md` | Curated long-term facts, decisions, and patterns across sessions. | Dream consolidation or deliberate agent maintenance. | Long-lived; promote stable facts from daily intake. |
| `BOOT.md` | Passive startup guidance loaded into system context. | User, operator, or template author. | Long-lived; keep short and explicit. |
| `BOOTSTRAP.md` | One-time first-run onboarding script. | Template author; agent follows it. | Temporary; delete after onboarding. |
| `HEARTBEAT.md` | Optional periodic tasks or reminders. | User or agent when periodic checks are requested. | Long-lived but often empty; remove stale tasks. |
| `OPENING.md` | First proactive message instructions for a fresh session. | User, operator, or template author. | Long-lived and optional. |
| `TOOLS.md` | Local tool notes, device names, service aliases, and setup-specific facts. | Agent as local tool knowledge is discovered; user as needed. | Long-lived; local notes only, not shared skill instructions. |
| `README.md` | Workspace or template orientation for readers. | Template author, user, or agent. | Long-lived; keep current. |
| `AGENTS.md` | Workspace-level operating instructions for agents. | User, operator, or agent for durable rules. | Long-lived; follow as local policy. |

## Reserved Directories

Each entry includes soft naming guidance and TTL hints. These are not regular
expressions or automatic deletion rules.

### `memory/`

Use `memory/` for raw chronological memory intake, especially daily shards such
as the daily notes described below. Put session facts, decisions, observations,
and "remember this" notes here before they are consolidated. Do not store
generated deliverables, scratch drafts, or imported files here. Name daily raw
memory shards as `memory/YYYY-MM-DD.md`. There is no strict TTL; consolidate
durable facts into `MEMORY.md`.

### `notes/`

Use `notes/` for stable reference notes that are useful but do not belong in the
root memory files: project notes, meeting notes, research summaries, checklists,
and reusable explanations. Do not place unfinished drafts, output artifacts,
uncategorized downloads, or raw memory intake here. Prefer short descriptive
names, with date prefixes only when chronology matters. Notes are durable by
default and should be archived only when clearly obsolete.

### `drafts/`

Use `drafts/` for work in progress: unfinished writing, reply drafts,
half-formed plans, and temporary compositions that may become final output
later. Do not store final deliverables, durable memory, or files that arrived
from outside without review. Name unfinished writing and plans as
`drafts/<topic>-<YYYY-MM-DD>.md`. Drafts older than 30 days should be archived
or promoted.

### `outputs/`

Use `outputs/` for final or near-final task artifacts produced by the agent:
reports, exports, generated files, rendered documents, and task-specific result
bundles. Do not place raw notes, inbox items, or ongoing scratch work here.
Group multi-file task deliverables under `outputs/<task-id>/...`. Generated
output without enough context to choose a task grouping should be an `ask`, not
a guessed folder name. Outputs older than 90 days should be archived when
inactive.

### `inbox/`

Use `inbox/` as the no-questions-asked landing zone for anything ambiguous:
uncategorized files, user drops, copied snippets, files whose ownership is not
clear, or material that needs operator review before placement. Do not treat
`inbox/` as permanent storage and do not silently classify uncertain material
elsewhere. Preserve original filenames when possible, adding a date or source
hint only to avoid collisions. Surface inbox items older than 7 days by
mentioning them in the next operator-visible audit, tidy report, or session
opening before taking further action.

### `archive/`

Use `archive/` for inactive material that should be retained but no longer
belongs in active workspace areas. Do not use it for temporary scratch files or
for hiding uncertain material that should first go through `inbox/`. Preserve
source context as `archive/YYYY-MM-DD/<original-path>` when moving inactive
material out of active areas. Archived material has no default deletion TTL;
deletion requires an explicit cleanup decision.

### `skills/`

Use workspace-level `skills/` for local skill instructions, scripts, templates,
and references that teach the agent how to perform a repeatable capability in
this workspace. Do not store ordinary project notes, generated outputs, or
general memory here. Keep each skill in its own directory with `SKILL.md` and
clear helper subdirectories. Skills are durable until replaced, retired, or
moved into a shared skill distribution.

Prefer short, descriptive, kebab-case filenames for notes, drafts, and generated
markdown unless the user or source system provides a meaningful original name.

## Placement Decisions

Use this order when triaging a file or directory:

1. If the path is one of the top-level files listed above, keep it at the
   workspace root unless the user explicitly asks to revise or remove it.
2. If the path is already inside a reserved directory and its content still
   matches that directory's purpose, keep it there.
3. If a root file clearly matches one reserved directory by name and visible
   content, move it there using that directory's naming guidance.
4. If a root file is recent work in progress, prefer `drafts/` over `archive/`.
5. If a root file is stale work in progress and exceeds the relevant TTL hint,
   archive it using the `archive/` naming guidance.
6. If a root file is ambiguous, user-supplied, or missing the context needed to
   choose a durable home, move it to `inbox/` or ask the operator when moving it
   could lose important intent.
7. If a root directory is not one of the reserved directories, ask before moving
   it. Directories have more hidden context than single files.

Use `ask` rather than forcing a move when the file's purpose depends on context
not visible in the filename, modified time, or first-page content. Common `ask`
cases include generated outputs without a clear task ID, files that look like
working revisions of root identity or instruction files, unknown root
directories, and anything that may be an active operator workspace.

## Hard Cases

- A half-finished draft at the root that was modified recently belongs in
  `drafts/`; do not archive recent active work.
- A half-finished draft at the root that has been untouched beyond the draft TTL
  should be archived.
- A generated output without a clear task ID should be an `ask`, because the
  correct `outputs/` task parent cannot be guessed safely.
- A user-supplied root file may move to `notes/` only when its visible content
  is clearly stable reference material; otherwise put it in `inbox/`.
- Memory-shaped markdown belongs in `memory/` only when the date is present in
  the file or otherwise explicit. If no date can be inferred, put it in
  `inbox/`.
- Scratch or temporary root files belong in `drafts/` only when the operator is
  visibly mid-task. If they are stale, archive them. If their role is unclear,
  ask.
- A root directory outside the reserved list should be an `ask`, not an
  automatic move to `inbox/` or `archive/`.

## Inbox Contract

`inbox/` is the workspace safety valve. The LLM may put any ambiguous item there
without asking first, and doing so is preferable to inventing a category,
misfiling user data, or mixing raw intake with durable memory. Placement in
`inbox/` means "needs triage," not "unimportant." When the operator later
clarifies intent, move the item to the appropriate active directory or archive
it with its original path preserved. If a filename or visible content suggests
credentials, PII, or secrets, choose `ask` before placement and use the
`distil-pii-redactor` skill before summarizing or logging sensitive details.
