# Agent Jobs and Dispatch

## Overview

HybridClaw has a persistent shared job board for human and agent work. It is a
kanban-style coordination surface backed by SQLite and exposed through:

- the admin web console board
- the gateway command surface and admin APIs
- the readline-based TUI board and edit form
- agent-side `job` tool calls that enqueue validated side effects

This is intentionally separate from scheduler tasks. Scheduler rows represent
timed prompts and runtime automations; jobs represent durable work items that
move across lanes, carry assignment metadata, and keep their own history.

## Current Model

The job system is intentionally narrow:

- one board: `main`
- fixed statuses: `backlog`, `ready`, `in_progress`, `blocked`, `done`
- fixed priorities: `low`, `normal`, `high`, `urgent`
- one assignee field: `assignee_agent_id`
- optional links to a source session and a scheduler task
- append-only history in `agent_job_events`

Important non-goals in the current version:

- there are no custom boards or custom columns
- there are no start-date or due-date fields
- the web board does not do drag-and-drop ordering yet

## Storage and Lifecycle

`src/memory/db.ts` adds the schema in migration `v16`.

### `agent_jobs`

The main row stores the durable state for a card:

- identity: `id`, `board_id`
- content: `title`, `details`
- workflow: `status`, `priority`, `lane_position`
- ownership: `assignee_agent_id`
- provenance: `created_by_kind`, `created_by_id`
- linking: `source_session_id`, `linked_task_id`
- timestamps: `created_at`, `updated_at`, `completed_at`, `archived_at`

### `agent_job_events`

Every meaningful change writes an event row with:

- `job_id`
- `actor_kind` and `actor_id`
- `action`
- `payload_json`
- `created_at`

### Helper behavior

The DB helpers in `src/memory/db.ts` are the canonical mutation layer:

- `createAgentJob()`
- `updateAgentJob()`
- `moveAgentJob()`
- `setAgentJobArchived()`
- `listAgentJobs()`
- `listAgentJobEvents()`

Key rules enforced there:

- titles must be non-empty
- archived jobs cannot be edited or moved until unarchived
- lane ordering is rewritten transactionally so positions stay contiguous
- moving to `done` sets `completed_at`; moving back out clears it
- archiving removes a job from active lane ordering; unarchiving restores it to
  the end of its lane

## End-to-End Flow

The shared control flow is:

1. A user or agent requests a job mutation.
2. Gateway or container-side validation normalizes the request.
3. The DB helper updates `agent_jobs` and appends an `agent_job_events` row.
4. Consumers fetch or receive the refreshed board snapshot.
5. The web console and TUI render the same underlying board state.

For agent mutations, the model does not write the database directly. The agent
emits queued job side effects and the gateway applies them after the turn.

## Types and Side Effects

`src/types.ts` defines the shared job model:

- `AGENT_JOB_STATUSES`
- `AGENT_JOB_PRIORITIES`
- `AgentJob`
- `AgentJobEvent`
- `JobSideEffect`

`JobSideEffect` supports these actions:

- `create`
- `move`
- `update`
- `complete`
- `archive`
- `unarchive`

That shared type is used by the container runtime, the gateway, and the
side-effect processor.

## Gateway Service and Admin APIs

The job-specific service code now lives under `src/jobs/`. The main entry points
are:

- `src/gateway/gateway-types.ts`
- `src/jobs/gateway.ts`
- `src/gateway/gateway-service.ts`
- `src/gateway/gateway-http-server.ts`

### Admin HTTP endpoints

The admin HTTP server exposes:

- `GET /api/admin/jobs`
  Returns the active board snapshot by default. Pass `?archived=true` to
  include archived jobs.
- `POST /api/admin/jobs`
  Creates a job. The request body is `{ job: { ... } }`.
- `PATCH /api/admin/jobs/:id`
  Updates title, details, priority, assignment, session link, task link, and
  archive state.
- `POST /api/admin/jobs/:id/move`
  Moves a job to a status and optional zero-based lane position.
- `GET /api/admin/jobs/:id/history`
  Returns the job plus its event history.
- `GET /api/admin/agents`
  Returns configured agents. The TUI uses this to build the assignee selector.

### SSE updates

`GET /api/events` emits a `jobs` event containing a full board snapshot. The
same stream also emits `overview` and `status`. The console listens to `jobs`
so it can refresh without polling every route separately.

### Gateway command family

`src/jobs/gateway.ts` implements the non-interactive job commands, and
`src/gateway/gateway-service.ts` dispatches the `job` command family to that
module:

```text
job list [status]
job board
job create <title>
job edit <id>
job start <id>
job move <id> <status> [position]
job done <id>
job archive <id>
job unarchive <id>
```

Notes:

- `job start <id>` is a convenience alias for moving a job to `in_progress`
- automatic dispatch is triggered for assigned `ready` jobs and for assigned
  `in_progress` jobs that have not successfully started yet
- `job board` renders a plain preformatted text board for non-TUI contexts
- `job edit <id>` is the user-facing inspect command outside the TUI
- in the TUI, `/job edit <id>` is intercepted locally and opens the form UI

## Web Console

The web surface lives in:

- `console/src/api/client.ts`
- `console/src/api/types.ts`
- `console/src/hooks/use-live-events.ts`
- `console/src/routes/jobs.tsx`

The `Jobs` route provides:

- a lane-based board with column counts
- derived dispatch/presence badges so cards read like assigned agent work, not
  generic tasks
- search filtering across title, details, status, priority, assignee, session,
  and id
- a right-hand detail/editor panel
- per-job history pulled from `/api/admin/jobs/:id/history`
- live board replacement when the SSE `jobs` event arrives

Current console behavior:

- moving a job is done through the detail form, not drag-and-drop
- the assignee field is still a free-form agent id input
- archiving removes the job from the active board

## TUI

The TUI entry points live in:

- `src/command-registry.ts`
- `src/tui.ts`
- `src/jobs/tui-board.ts`
- `src/jobs/tui-edit.ts`

### Slash and text commands

The TUI exposes the shared `job` command family and adds one local-only command:

```text
/job list [status]
/job board
/job edit <id>
/job create <title>
/job start <id>
/job move <id> <status> [position]
/job done <id>
/job archive <id>
/job unarchive <id>
```

`/job edit <id>` opens the TUI form directly and does not round-trip through the
generic gateway command handler.

### Board mode

`/job board` opens the keyboard-driven board modal:

- `←` and `→` switch columns
- `↑` and `↓` move between cards in the current lane
- `Enter` opens the edit form for the selected job
- `Esc` closes the board

The board is intentionally a focused redraw mode layered on top of readline,
not a separate curses app.

### Edit form

The job editor is a form-style modal. It fetches the job history, fetches
`/api/admin/agents`, and then lets the operator edit fields in place.

Controls:

- `↑` and `↓` move between fields
- `←` and `→` cycle `Status`, `Priority`, and `Assigned To`
- `Enter` edits text fields or activates the current action
- `s` sets status to `in_progress`
- `Esc` or `q` cancels

Save behavior:

- status changes go through `/api/admin/jobs/:id/move`
- other field edits go through `PATCH /api/admin/jobs/:id`
- after save, the TUI prints the read-only `job edit` view

## Automatic Dispatcher

The runtime dispatcher lives in `src/jobs/dispatcher.ts` and starts with the
gateway runtime after `initGatewayService()` configures its host callbacks.

Dispatcher behavior:

- polls the main board for assigned `in_progress` jobs first, then assigned
  `ready` jobs
- allows at most one automatically running job per assignee at a time
- moves a claimed `ready` job to `in_progress` as `system:job-dispatcher`
- runs the assigned agent through `handleGatewayMessage()` in a dedicated
  scheduler-style job session
- records `dispatch_started`, `dispatch_failed`, and `dispatch_succeeded` job
  events so restart recovery and retries are persisted
- derives board-facing presence state such as queued, working, retrying, and
  exhausted from those events
- retries failed or interrupted dispatch attempts up to three times
- moves the job to `done` on a successful run
- moves the job to `blocked` after the retry budget is exhausted

Finalization is conservative:

- if a human or the agent already changed the job while the dispatch run was in
  flight, the dispatcher does not overwrite that newer status
- automatic dispatch uses a dedicated job session key instead of reusing the
  source conversation session
- the `source_session_id` is still carried on the job row for provenance and
  context, but it is not where the automated run is executed

This makes the dispatcher an execution layer on top of the board, while keeping
the originating chat history and the job-run history separate.

## Agent Tooling

The agent-facing job interface lives in `container/src/tools.ts` as the `job`
tool. The tool supports:

- `list`
- `view`
- `create`
- `move`
- `update`
- `complete`
- `archive`
- `unarchive`

Read-only actions (`list`, `view`) use the injected board snapshot. Mutating
actions do not write to SQLite directly. Instead they queue entries in
`pendingJobs`, which become `sideEffects.jobs[]` on the container output.

The gateway applies those side effects in `src/agent/side-effects.ts` by calling
the same DB helpers used by user-driven mutations. This keeps model output
untrusted and preserves one write path for history, validation, and ordering.

Practical implications:

- agent-created jobs can carry `status`, `priority`, `assigneeAgentId`,
  `sourceSessionId`, and `linkedTaskId`
- `sourceSessionId` defaults to the current session when omitted
- an agent can list or view the current board before deciding how to update it
- completion is modeled as a move to `done`, not a separate terminal object

## Relationship to Scheduler Tasks

Jobs and scheduler tasks can point to each other, but they are different
systems:

- `linked_task_id` is only a reference to a scheduler task
- `source_session_id` points back to the conversation where the work originated
- a scheduler task does not automatically create a job
- a job does not automatically create or run a scheduler task

Use scheduler tasks for timed execution. Use jobs for shared workflow tracking.

## Current Gaps

These are the main limitations to keep in mind when extending the system:

- one shared board only
- fixed status model
- no due dates or start dates
- no drag-and-drop lane ordering in the web console
- no dedicated `started_at` timestamp; "started" currently means status moved to
  `in_progress`
- no persisted dispatch lease or retry state, so recovery after a process crash
  is still basic
- no dedicated run-result field on the job row; execution detail lives in the
  dispatch session transcript and audit trail

## Tests

Targeted coverage for the shipped job system lives in:

- `tests/gateway-service.jobs.test.ts`
- `tests/jobs-dispatcher.test.ts`
- `tests/gateway-http-server.test.ts`
- `tests/gateway-client.test.ts`
- `tests/tui-jobs-board.test.ts`
- `tests/tui-job-edit.test.ts`
- `tests/agent-side-effects.jobs.test.ts`

When changing job persistence or movement logic, include tests that cover lane
reordering, archived-job behavior, and history events.

### Phase 4: Agent side-effects

- add `sideEffects.jobs`
- validate and persist agent-created moves/updates
- surface actor attribution in job history

### Phase 5: Optional integrations

- link jobs to sessions/agent cards more deeply
- add "run this job" or "spawn agent from job" actions
- add drag/drop once backend ordering semantics have proven stable

## Testing Plan

For implementation work in this area, the minimum expected checks should be:

- `npm run typecheck`
- `npm run lint`
- targeted Vitest suites for DB, gateway service, HTTP server, and TUI

Add explicit tests for:

- ordering within a lane after move/reorder
- moving between lanes
- archived job write rejection
- SSE payload shape
- TUI narrow-width rendering fallback
- agent side-effect validation failures

## Risks and Open Questions

- The biggest design risk is conflating workflow jobs with scheduler jobs. Keep
  them separate and add links only where needed.
- The TUI board can interfere with streaming output if it is implemented as a
  permanent overlay. Treat it as an explicit modal/view with clean enter/exit.
- If job updates are sent over the existing overview SSE event only, the console
  will do unnecessary work. Add a dedicated event type.
- If later requirements demand multiple boards or custom columns, build that on
  top of the new job model rather than trying to retrofit scheduler entities.

## Recommended First Implementation Slice

Start with backend and console only:

1. add `agent_jobs` and `agent_job_events`
2. add `/api/admin/jobs` CRUD plus move/history routes
3. add `Jobs` console page with fixed columns and button-based moves
4. defer TUI mode and agent side-effects until the persistence model settles

That gives immediate user value, keeps scope controlled, and avoids coupling the
first milestone to terminal rendering complexity.
