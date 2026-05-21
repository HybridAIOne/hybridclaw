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
| `IDENTITY.md` | Defines who the agent is in this workspace: name, self-description, tone, avatar, and other identity metadata. | The agent during onboarding, then the user or agent only when identity is explicitly changed. | Created from the bootstrap template and updated rarely. Treat changes as meaningful identity edits. |
| `SOUL.md` | Captures the agent's core behavior, boundaries, and working style. | The product template provides the baseline; the agent or user may refine it when behavior expectations change. | Long-lived. Read as stable identity guidance and avoid casual churn. |
| `USER.md` | Records stable facts about the human: name, preferences, timezone, work context, and durable notes. | The agent writes it during onboarding and updates it when the user provides durable personal or workflow context. | Long-lived. Keep it concise and respectful; do not turn it into an exhaustive dossier. |
| `MEMORY.md` | Curated long-term memory for facts, decisions, and patterns that matter across sessions. | Dream consolidation or deliberate agent maintenance writes it; daily intake usually starts in `memory/YYYY-MM-DD.md`. | Long-lived and rewritten carefully. Prefer promoting stable facts into it rather than appending noisy raw notes. |
| `BOOT.md` | Passive startup guidance loaded into the agent's system context. | The user, operator, or template author. | Long-lived. Keep it short and explicit; update when default startup behavior changes. |
| `BOOTSTRAP.md` | One-time first-run onboarding script for a fresh workspace. | The product template creates it; the agent follows it during first run. | Temporary. Delete it after onboarding is complete. |
| `HEARTBEAT.md` | Optional periodic tasks or reminders for heartbeat-style follow-up. | The user or agent when the user asks for periodic checks. | Long-lived but often empty. Remove stale tasks once they no longer need to run. |
| `OPENING.md` | Instructions for the first proactive message in a fresh session. | The user, operator, or template author. | Long-lived and optional. Keep only current opening behavior here. |
| `TOOLS.md` | Local environment notes for tool usage, device names, service aliases, and setup-specific facts. | The agent updates it as local tool knowledge is discovered; the user may add environment details. | Long-lived. Store setup-specific notes, not shared skill instructions. |
| `README.md` | Explains the purpose of the workspace or template area for readers. | The template author, user, or agent when workspace-facing orientation changes. | Long-lived. Keep it descriptive and current. |
| `AGENTS.md` | Workspace-level operating instructions for agents working inside the workspace. | The user, operator, or agent when durable agent rules change. | Long-lived. Follow it as local policy and update only for durable instructions. |

## Reserved Directories

### `memory/`

Use `memory/` for raw chronological memory intake, especially daily shards such
as `memory/YYYY-MM-DD.md`. Put session facts, decisions, observations, and
"remember this" notes here before they are consolidated. Do not store generated
deliverables, random scratch drafts, or imported files here. Name daily notes by
date, and use clear headings inside the file rather than creating many small
memory fragments. Daily memory does not have a strict TTL, but old raw intake
should be consolidated into `MEMORY.md` when it becomes durable.

### `notes/`

Use `notes/` for stable reference notes that are useful but do not belong in the
root memory files: project notes, meeting notes, research summaries, checklists,
and reusable explanations. Do not place unfinished drafts, output artifacts, or
uncategorized downloads here. Prefer descriptive kebab-case names such as
`notes/project-alpha-context.md` or date-prefixed names when chronology matters.
Notes are durable by default and should be archived only when they are clearly
obsolete.

### `drafts/`

Use `drafts/` for work in progress: unfinished writing, reply drafts,
half-formed plans, and temporary compositions that may become final output
later. Do not store final deliverables, durable memory, or files that arrived
from outside without review. Prefer names like
`drafts/<topic>-<YYYY-MM-DD>.md`, where the topic is short and human-readable.
As a TTL hint, drafts older than 30 days should be reviewed and either moved to
`archive/` or promoted to a more durable location.

### `outputs/`

Use `outputs/` for final or near-final task artifacts produced by the agent:
reports, exports, generated files, rendered documents, and task-specific result
bundles. Do not place raw notes, inbox items, or ongoing scratch work here.
Group task output under `outputs/<task-id>/...` when a task creates more than
one file; otherwise use a clear filename that names the deliverable. As a TTL
hint, outputs older than 90 days should be reviewed and archived if they are no
longer active.

### `inbox/`

Use `inbox/` as the no-questions-asked landing zone for anything ambiguous:
uncategorized files, user drops, copied snippets, files whose ownership is not
clear, or material that needs operator review before placement. Do not treat
`inbox/` as permanent storage and do not silently classify uncertain material
elsewhere. Use names that preserve the original filename when possible, adding a
date or short source hint only to avoid collisions. As a TTL hint, inbox items
older than 7 days should be surfaced to the operator for triage.

### `archive/`

Use `archive/` for inactive material that should be retained but no longer
belongs in active workspace areas. Do not use it for temporary scratch files or
for hiding uncertain material that should first go through `inbox/`. Preserve
source context with paths like `archive/YYYY-MM-DD/<original-path>`, where the
date is the archive date and the original path helps explain where the file came
from. Archived material has no default deletion TTL; deletion requires an
explicit cleanup decision.

### `skills/`

Use workspace-level `skills/` for local skill instructions, scripts, templates,
and references that teach the agent how to perform a repeatable capability in
this workspace. Do not store ordinary project notes, generated outputs, or
general memory here. Keep each skill in its own directory with a `SKILL.md` file
and place supporting material alongside it in clear subdirectories such as
`references/`, `scripts/`, or `templates/`. Skills are durable until replaced,
retired, or moved into a shared skill distribution.

## Naming Guidance

These are soft placement conventions, not regular expressions:

- Use `memory/YYYY-MM-DD.md` for daily raw memory shards.
- Use `outputs/<task-id>/...` for multi-file task deliverables.
- Use `drafts/<topic>-<YYYY-MM-DD>.md` for unfinished writing and plans.
- Use `archive/YYYY-MM-DD/<original-path>` when moving inactive material out of
  active workspace areas.
- Prefer short, descriptive, kebab-case filenames for notes, drafts, and
  generated markdown unless the user or source system provides a meaningful
  original name.
- Preserve original filenames for user-supplied files when that helps
  traceability.

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
   archive it under `archive/YYYY-MM-DD/<original-path>`.
6. If a root file is ambiguous, user-supplied, or missing the context needed to
   choose a durable home, move it to `inbox/` or ask the operator when moving it
   could lose important intent.
7. If a root directory is not one of the reserved directories, ask before moving
   it. Directories have more hidden context than single files.

Use `ask` rather than forcing a move when the file's purpose depends on context
not visible in the filename, modified time, or first-page content. Common `ask`
cases include generated outputs without a clear task ID, partial copies of root
identity files, unknown root directories, and anything that may be an active
operator workspace.

## Hard Cases

- A half-finished draft at the root that was modified recently belongs in
  `drafts/<topic>-<YYYY-MM-DD>.md`; do not archive recent active work.
- A half-finished draft at the root that has been untouched beyond the draft TTL
  should be archived under `archive/YYYY-MM-DD/<original-path>`.
- A generated output without a clear task ID should be an `ask`, because the
  correct `outputs/<task-id>/...` parent cannot be guessed safely.
- A random root `.txt` file named like a note may move to `notes/` if the
  content is clearly personal or reference material; otherwise put it in
  `inbox/`.
- Memory-shaped markdown belongs in `memory/YYYY-MM-DD.md` only when the date is
  present in the file or otherwise explicit. If no date can be inferred, put it
  in `inbox/`.
- A scratch script at the root, such as `tmp.py` or `test.sh`, belongs in
  `drafts/` only when the operator is visibly mid-task. If it is stale, archive
  it. If its role is unclear, ask.
- A markdown file that looks like a partial copy or revision of `IDENTITY.md`,
  `SOUL.md`, `USER.md`, `MEMORY.md`, or `AGENTS.md` should be an `ask`; root
  identity and instruction files are high-context.
- A root directory outside the reserved list should be an `ask`, not an
  automatic move to `inbox/` or `archive/`.

## TTL Hints

TTL guidance is operational judgment, not automatic deletion:

- `drafts/` older than 30 days should be archived or promoted if still useful.
- `outputs/` older than 90 days should be archived when the task is complete and
  the artifact is no longer active.
- `inbox/` items older than 7 days should be surfaced to the operator for
  triage.
- `memory/`, `notes/`, `archive/`, `skills/`, and the root bootstrap files do
  not have default expiration. Review them when they become stale, duplicative,
  or misleading.

## Inbox Contract

`inbox/` is the workspace safety valve. The LLM may put any ambiguous item there
without asking first, and doing so is preferable to inventing a category,
misfiling user data, or mixing raw intake with durable memory. Placement in
`inbox/` means "needs triage," not "unimportant." When the operator later
clarifies intent, move the item to the appropriate active directory or archive
it with its original path preserved.
