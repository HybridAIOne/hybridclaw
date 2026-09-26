import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'execute'
  | 'search'
  | 'fetch'
  | 'other';

const SEARCH_HINTS = ['search', 'find', 'query', 'lookup', 'discover'];
const FETCH_HINTS = [
  'fetch',
  'download',
  'request',
  'http',
  'api',
  'url',
  'browse',
  'scrape',
];
const EXECUTE_HINTS = [
  'exec',
  'execute',
  'run',
  'bash',
  'shell',
  'command',
  'terminal',
  'spawn',
  'process',
];
const DELETE_HINTS = ['delete', 'remove', 'unlink', 'destroy', 'drop', 'erase'];
const EDIT_HINTS = [
  'write',
  'edit',
  'update',
  'patch',
  'append',
  'insert',
  'create',
  'set',
  'save',
  'modify',
];
const READ_HINTS = [
  'read',
  'get',
  'list',
  'view',
  'show',
  'open',
  'cat',
  'stat',
  'info',
  'describe',
];

function matchesHint(name: string, hints: readonly string[]): boolean {
  return hints.some((hint) => name.includes(hint));
}

const LOOKUP_KINDS: ReadonlySet<ToolKind> = new Set([
  'read',
  'search',
  'fetch',
]);

/**
 * Whether a call that may already have reached the server can be sent again.
 * Only a tool the server says writes, without calling it idempotent, is not.
 */
export function isResendSafe(
  annotations: ToolAnnotations | undefined,
): boolean {
  if (annotations?.readOnlyHint === true) return true;
  if (annotations?.idempotentHint === true) return true;
  return (
    annotations?.readOnlyHint !== false &&
    annotations?.destructiveHint === undefined
  );
}

/**
 * Hints the server states beat guessing from the name ("execute_sql" may only
 * ever run SELECTs); hints it leaves out fall back to the name.
 */
export function classifyMcpTool(
  toolName: string,
  annotations?: ToolAnnotations,
): ToolKind {
  if (annotations?.readOnlyHint === true) return 'read';
  if (annotations?.destructiveHint === true) return 'delete';
  if (annotations?.destructiveHint === false) return 'edit';
  const kind = classifyMcpToolName(toolName);
  // A tool the server says writes never passes as a lookup by its name.
  if (annotations?.readOnlyHint === false && LOOKUP_KINDS.has(kind)) {
    return 'other';
  }
  return kind;
}

function classifyMcpToolName(toolName: string): ToolKind {
  const lower = toolName
    .toLowerCase()
    .split('__')
    .at(-1)
    ?.replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (!lower) return 'other';
  if (matchesHint(lower, SEARCH_HINTS)) return 'search';
  if (matchesHint(lower, FETCH_HINTS)) return 'fetch';
  if (matchesHint(lower, EXECUTE_HINTS)) return 'execute';
  if (matchesHint(lower, DELETE_HINTS)) return 'delete';
  if (matchesHint(lower, EDIT_HINTS)) return 'edit';
  if (matchesHint(lower, READ_HINTS)) return 'read';
  return 'other';
}
