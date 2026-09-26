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

/**
 * Whether the server described the tool's behaviour. Once it has, unset
 * hints take the MCP spec defaults (a write is destructive and open-world);
 * without any, the tool is judged by its name.
 */
export function hasBehaviorHints(
  annotations: ToolAnnotations | undefined,
): annotations is ToolAnnotations {
  return (
    annotations?.readOnlyHint !== undefined ||
    annotations?.destructiveHint !== undefined ||
    annotations?.idempotentHint !== undefined ||
    annotations?.openWorldHint !== undefined
  );
}

/** Whether a call that may already have reached the server can be resent. */
export function isRetrySafe(annotations: ToolAnnotations | undefined): boolean {
  if (!hasBehaviorHints(annotations)) return true;
  return (
    annotations.readOnlyHint === true || annotations.idempotentHint === true
  );
}

export function classifyMcpTool(
  toolName: string,
  annotations?: ToolAnnotations,
): ToolKind {
  // The server's own hints beat guessing from the name ("execute_sql" may
  // only ever run SELECTs).
  if (hasBehaviorHints(annotations)) {
    if (annotations.readOnlyHint === true) return 'read';
    return annotations.destructiveHint === false ? 'edit' : 'delete';
  }
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
