/**
 * `/track` and the gateway side of the `track` tool — two doors to one list
 * of goals and tracked items. A change through the command is the user's (an
 * app tap), one through the tool is the agent's, so apps can show who wrote a
 * status. `--json` answers in one line that survives a chat relay
 * (`chatSafeJson`).
 *
 * NOT the store (`track-store.ts`, which owns check-ins and limits); this
 * module parses, re-arms the scheduler and formats.
 */
import { parseLowerArg } from '../command-parsing.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import {
  badCommand,
  infoCommand,
  plainCommand,
} from '../gateway/gateway-command-results.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from '../gateway/gateway-types.js';
import { chatSafeJson } from '../gateway/schedule-command.js';
import { getSessionById } from '../memory/db.js';
import { rearmScheduler } from '../scheduler/scheduler.js';
import type { Session } from '../types/session.js';
import { isRecord } from '../utils/type-guards.js';
import {
  addStep,
  addTracked,
  changeStep,
  describeTracked,
  editTracked,
  listTracked,
  markTracked,
  noteTracked,
  parseAt,
  parseEvery,
  parseKind,
  removeTracked,
  type TrackActor,
  TrackError,
  type Tracked,
  type TrackFields,
  trackedView,
} from './track-store.js';

const USAGE =
  'Usage: `track add [--kind goal|tracking] [--every daily|weekdays|mon,thu,…] [--at HH:MM] [--tz <zone>] <title>`, `track edit <id> [same options, --every none] [<title>]`, `track outcome <id> [<text>]`, `track status <id> <text>`, `track step <id> add <title>`, `track step <id> done|undo|remove <step>`, `track done|undo|remove <id>`, `track list`. Add `--json` for a machine-readable answer.';
const VALUE_FLAGS = new Set(['--kind', '--every', '--at', '--tz']);

/** Options come before the text, so a title may contain anything. */
function readOptions(args: string[]): {
  json: boolean;
  values: Map<string, string>;
  text: string;
} {
  const values = new Map<string, string>();
  let json = false;
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new TrackError(`\`${arg}\` needs a value.`);
      }
      values.set(arg, value);
      index += 1;
    } else {
      break;
    }
  }
  const rest = args.slice(index);
  if (rest.at(-1) === '--json') {
    json = true;
    rest.pop();
  }
  return { json, values, text: rest.join(' ').trim() };
}

function fieldsFrom(values: Map<string, string>, title: string): TrackFields {
  const fields: TrackFields = {};
  if (title) fields.title = title;
  const kind = values.get('--kind');
  if (kind !== undefined) fields.kind = parseKind(kind);
  const every = values.get('--every');
  if (every !== undefined) fields.every = parseEvery(every);
  const at = values.get('--at');
  if (at !== undefined) fields.at = parseAt(at);
  const tz = values.get('--tz');
  if (tz !== undefined) fields.tz = tz;
  return fields;
}

/** Re-arms the scheduler when the item has a check-in it may have moved. */
function armed(item: Tracked): Tracked {
  if (item.checkTaskId) rearmScheduler();
  return item;
}

function itemAnswer(item: Tracked, json: boolean, verb: string) {
  return json
    ? plainCommand(chatSafeJson({ version: 1, item: trackedView(item) }))
    : plainCommand(`${verb}: ${describeTracked(item)}`);
}

function parseId(raw: string | undefined): number {
  // `#3`, as the list shows it, or `3`.
  const id = Number.parseInt((raw ?? '').replace(/^#/, ''), 10);
  return id > 0 ? id : 0;
}

function runCommand(
  req: GatewayCommandRequest,
  session: Session,
): GatewayCommandResult {
  const sub = parseLowerArg(req.args, 1);
  const rest = req.args.slice(2).map(String);

  if (sub === 'list') {
    const { json } = readOptions(rest);
    const items = listTracked(session);
    if (json) {
      return plainCommand(
        chatSafeJson({ version: 1, items: items.map(trackedView) }),
      );
    }
    if (items.length === 0) return plainCommand('No goals.');
    return infoCommand('Goals', items.map(describeTracked).join('\n'));
  }

  if (sub === 'add') {
    const { json, values, text } = readOptions(rest);
    const item = addTracked(
      session,
      { ...fieldsFrom(values, text), title: text },
      'user',
    );
    return itemAnswer(armed(item), json, 'Added');
  }

  const id = parseId(rest[0]);
  if (!id) return badCommand('Usage', USAGE);

  if (sub === 'step') {
    const action = (rest[1] ?? '').toLowerCase();
    if (action === 'add') {
      const { json, text } = readOptions(rest.slice(2));
      return itemAnswer(addStep(session, id, text), json, 'Updated');
    }
    const stepId = parseId(rest[2]);
    const to = action === 'done' ? true : action === 'undo' ? false : action;
    if (!stepId || (to !== true && to !== false && to !== 'remove')) {
      return badCommand('Usage', USAGE);
    }
    const { json } = readOptions(rest.slice(3));
    return itemAnswer(changeStep(session, id, stepId, to), json, 'Updated');
  }

  const { json, values, text } = readOptions(rest.slice(1));
  switch (sub) {
    case 'edit':
      return itemAnswer(
        armed(editTracked(session, id, fieldsFrom(values, text))),
        json,
        'Updated',
      );
    case 'outcome':
      return itemAnswer(
        armed(editTracked(session, id, { outcome: text || null })),
        json,
        'Updated',
      );
    case 'status':
      return itemAnswer(noteTracked(session, id, text, 'user'), json, 'Noted');
    case 'done':
    case 'undo':
      return itemAnswer(
        armed(markTracked(session, id, sub === 'done', 'user')),
        json,
        sub === 'done' ? 'Done' : 'Reopened',
      );
    case 'remove': {
      const item = removeTracked(session, id);
      return json
        ? plainCommand(chatSafeJson({ version: 1, removed: item.id }))
        : plainCommand(`Removed goal #${item.id}.`);
    }
    default:
      return badCommand('Usage', USAGE);
  }
}

export function handleTrackCommand(
  req: GatewayCommandRequest,
  session: Session,
): GatewayCommandResult {
  try {
    return runCommand(req, session);
  } catch (error) {
    if (error instanceof TrackError) return badCommand('Goals', error.message);
    throw error;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toolFields(body: Record<string, unknown>): TrackFields {
  const fields: TrackFields = {};
  const title = optionalString(body.title);
  if (title) fields.title = title;
  if (typeof body.outcome === 'string') fields.outcome = body.outcome;
  const kind = optionalString(body.kind);
  if (kind) fields.kind = parseKind(kind);
  const every = optionalString(body.every);
  if (every) fields.every = parseEvery(every);
  const at = optionalString(body.at);
  if (at) fields.at = parseAt(at);
  return fields;
}

const AGENT: TrackActor = 'agent';

const TOOL_ACTIONS: Record<
  string,
  (session: Session, body: Record<string, unknown>, id: number) => string
> = {
  list: (session) => {
    const items = listTracked(session);
    return items.length === 0
      ? 'The user has no goals or tracked items.'
      : items.map(describeTracked).join('\n');
  },
  add: (session, body) => {
    let item = armed(addTracked(session, toolFields(body), AGENT));
    const status = optionalString(body.status);
    if (status) item = noteTracked(session, item.id, status, AGENT);
    return `Added ${describeTracked(item)}`;
  },
  edit: (session, body, id) =>
    `Updated ${describeTracked(armed(editTracked(session, id, toolFields(body))))}`,
  status: (session, body, id) =>
    `Noted ${describeTracked(noteTracked(session, id, optionalString(body.status) ?? '', AGENT))}`,
  add_step: (session, body, id) =>
    `Updated ${describeTracked(addStep(session, id, optionalString(body.step) ?? ''))}`,
  step_done: (session, body, id) =>
    `Updated ${describeTracked(changeStep(session, id, Number(body.step_id), true))}`,
  step_undo: (session, body, id) =>
    `Updated ${describeTracked(changeStep(session, id, Number(body.step_id), false))}`,
  remove_step: (session, body, id) =>
    `Updated ${describeTracked(changeStep(session, id, Number(body.step_id), 'remove'))}`,
  done: (session, _body, id) =>
    `Done ${describeTracked(armed(markTracked(session, id, true, AGENT)))}`,
  undo: (session, _body, id) =>
    `Reopened ${describeTracked(armed(markTracked(session, id, false, AGENT)))}`,
  remove: (session, _body, id) =>
    `Removed goal #${removeTracked(session, id).id}.`,
};

/** `POST /api/track`: the container's `track` tool, on the calling session. */
export function runTrackToolAction(body: unknown): {
  ok: true;
  result: string;
} {
  if (!isRecord(body)) {
    throw new GatewayRequestError(400, 'Request body must be a JSON object.');
  }
  const action = optionalString(body.action) ?? '';
  const run = TOOL_ACTIONS[action];
  if (!run) {
    throw new GatewayRequestError(
      400,
      `Invalid \`action\`. Allowed: ${Object.keys(TOOL_ACTIONS).join(', ')}.`,
    );
  }
  const session = getSessionById(optionalString(body.sessionId) ?? '');
  if (!session) throw new GatewayRequestError(404, 'Unknown session.');
  const id = Number(body.id);
  if (action !== 'list' && action !== 'add' && !Number.isInteger(id)) {
    throw new GatewayRequestError(400, 'Give the goal `id`.');
  }
  try {
    return { ok: true, result: run(session, body, id) };
  } catch (error) {
    if (error instanceof TrackError) {
      throw new GatewayRequestError(400, error.message);
    }
    throw error;
  }
}
