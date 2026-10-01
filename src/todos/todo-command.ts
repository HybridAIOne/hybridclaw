/**
 * `/todo` and the gateway side of the `todo` tool — two doors to one list.
 * A check-off through the command is the user's (an app tap), one through the
 * tool is the agent's, so apps can show who did it. `--json` answers in one
 * line that survives a chat relay (`chatSafeJson`).
 *
 * NOT the store (`todo-store.ts`, which owns dates, streaks and reminders);
 * this module parses, re-arms the scheduler and formats.
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
  addTodo,
  describeTodo,
  editTodo,
  listTodos,
  markTodo,
  parseDue,
  parseRemind,
  parseRepeat,
  removeTodo,
  type Todo,
  TodoError,
  type TodoFields,
  todoView,
} from './todo-store.js';

const USAGE =
  'Usage: `todo add [--repeat daily|weekdays|mon,wed,…] [--due YYYY-MM-DD] [--remind HH:MM] [--tz <zone>] <title>`, `todo edit <id> [same options, --repeat none, --remind off] [<title>]`, `todo done <id> [--date YYYY-MM-DD]`, `todo undo <id> [--date YYYY-MM-DD]`, `todo remove <id>`, `todo list`. Add `--json` for a machine-readable answer.';
const VALUE_FLAGS = new Set([
  '--repeat',
  '--due',
  '--remind',
  '--tz',
  '--date',
]);

/** Options come before the title, so a title may contain anything. */
function readOptions(args: string[]): {
  json: boolean;
  values: Map<string, string>;
  title: string;
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
        throw new TodoError(`\`${arg}\` needs a value.`);
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
  return { json, values, title: rest.join(' ').trim() };
}

function fieldsFrom(values: Map<string, string>, title: string): TodoFields {
  const fields: TodoFields = {};
  if (title) fields.title = title;
  const repeat = values.get('--repeat');
  if (repeat !== undefined) fields.repeat = parseRepeat(repeat);
  const due = values.get('--due');
  if (due !== undefined) fields.due = parseDue(due);
  const remind = values.get('--remind');
  if (remind !== undefined) fields.remind = parseRemind(remind);
  const tz = values.get('--tz');
  if (tz !== undefined) fields.tz = tz;
  return fields;
}

function todoAnswer(todo: Todo, json: boolean, verb: string) {
  return json
    ? plainCommand(chatSafeJson({ version: 1, todo: todoView(todo) }))
    : plainCommand(`${verb}: ${describeTodo(todo)}`);
}

function runCommand(
  req: GatewayCommandRequest,
  session: Session,
): GatewayCommandResult {
  const sub = parseLowerArg(req.args, 1);
  const rest = req.args.slice(2).map(String);

  if (sub === 'list') {
    const { json } = readOptions(rest);
    const todos = listTodos(session);
    if (json) {
      return plainCommand(
        chatSafeJson({
          version: 1,
          todos: todos.map((todo) => todoView(todo)),
        }),
      );
    }
    if (todos.length === 0) return plainCommand('No todos.');
    return infoCommand(
      'Todos',
      todos.map((todo) => describeTodo(todo)).join('\n'),
    );
  }

  if (sub === 'add') {
    const { json, values, title } = readOptions(rest);
    const todo = addTodo(session, { ...fieldsFrom(values, title), title });
    if (todo.reminderTaskId) rearmScheduler();
    return todoAnswer(todo, json, 'Added');
  }

  // `#3`, as the list shows it, or `3`.
  const id = Number.parseInt((rest[0] ?? '').replace(/^#/, ''), 10);
  if (!(id > 0)) return badCommand('Usage', USAGE);
  const { json, values, title } = readOptions(rest.slice(1));

  if (sub === 'edit') {
    const todo = editTodo(session, id, fieldsFrom(values, title));
    if (todo.reminderTaskId) rearmScheduler();
    return todoAnswer(todo, json, 'Updated');
  }
  if (sub === 'done' || sub === 'undo') {
    const todo = markTodo(
      session,
      id,
      sub === 'done',
      'user',
      values.get('--date') ?? null,
    );
    return todoAnswer(todo, json, sub === 'done' ? 'Done' : 'Reopened');
  }
  if (sub === 'remove') {
    const todo = removeTodo(session, id);
    return json
      ? plainCommand(chatSafeJson({ version: 1, removed: todo.id }))
      : plainCommand(`Removed todo #${todo.id}.`);
  }
  return badCommand('Usage', USAGE);
}

export function handleTodoCommand(
  req: GatewayCommandRequest,
  session: Session,
): GatewayCommandResult {
  try {
    return runCommand(req, session);
  } catch (error) {
    if (error instanceof TodoError) return badCommand('Todo', error.message);
    throw error;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toolFields(body: Record<string, unknown>): TodoFields {
  const fields: TodoFields = {};
  const title = optionalString(body.title);
  if (title) fields.title = title;
  const repeat = optionalString(body.repeat);
  if (repeat) fields.repeat = parseRepeat(repeat);
  const due = optionalString(body.due);
  if (due) fields.due = parseDue(due);
  const remind = optionalString(body.remind);
  if (remind) fields.remind = parseRemind(remind);
  return fields;
}

const TOOL_ACTIONS: Record<
  string,
  (session: Session, body: Record<string, unknown>, id: number) => string
> = {
  list: (session) => {
    const todos = listTodos(session);
    return todos.length === 0
      ? 'The user has no todos.'
      : todos.map((todo) => describeTodo(todo)).join('\n');
  },
  add: (session, body) => {
    const todo = addTodo(session, toolFields(body));
    if (todo.reminderTaskId) rearmScheduler();
    return `Added ${describeTodo(todo)}`;
  },
  edit: (session, body, id) => {
    const todo = editTodo(session, id, toolFields(body));
    if (todo.reminderTaskId) rearmScheduler();
    return `Updated ${describeTodo(todo)}`;
  },
  done: (session, body, id) =>
    `Checked off ${describeTodo(markTodo(session, id, true, 'agent', optionalString(body.date) ?? null))}`,
  undo: (session, body, id) =>
    `Reopened ${describeTodo(markTodo(session, id, false, 'agent', optionalString(body.date) ?? null))}`,
  remove: (session, _body, id) =>
    `Removed todo #${removeTodo(session, id).id}.`,
};

/** `POST /api/todo`: the container's `todo` tool, on the calling session. */
export function runTodoToolAction(body: unknown): {
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
    throw new GatewayRequestError(400, 'Give the todo `id`.');
  }
  try {
    return { ok: true, result: run(session, body, id) };
  } catch (error) {
    if (error instanceof TodoError) {
      throw new GatewayRequestError(400, error.message);
    }
    throw error;
  }
}
