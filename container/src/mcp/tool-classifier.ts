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

export function classifyMcpTool(toolName: string): ToolKind {
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
