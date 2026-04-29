export type PromptHookName =
  | 'bootstrap'
  | 'memory'
  | 'retrieval'
  | 'safety'
  | 'runtime'
  | 'session-context';
export type ExtendedPromptHookName = PromptHookName | 'proactivity';
export type WorkspacePromptPartName =
  | 'agents'
  | 'soul'
  | 'identity'
  | 'user'
  | 'tools'
  | 'memory-file'
  | 'heartbeat'
  | 'bootstrap-file'
  | 'opening'
  | 'boot';
export type PromptPartName =
  | ExtendedPromptHookName
  | WorkspacePromptPartName
  | 'skills';

export const PROMPT_PART_NAMES: PromptPartName[] = [
  'bootstrap',
  'memory',
  'retrieval',
  'safety',
  'runtime',
  'session-context',
  'proactivity',
  'skills',
  'agents',
  'soul',
  'identity',
  'user',
  'tools',
  'memory-file',
  'heartbeat',
  'bootstrap-file',
  'opening',
  'boot',
];

const PROMPT_PART_SET = new Set<PromptPartName>(PROMPT_PART_NAMES);

export function isPromptPartName(value: string): value is PromptPartName {
  return PROMPT_PART_SET.has(value as PromptPartName);
}

export function parsePromptPartList(
  raw: string,
  flagName: string,
): PromptPartName[] {
  const parts = String(raw || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Expected at least one prompt part for ${flagName}.`);
  }
  const unknown = parts.find((part) => !isPromptPartName(part));
  if (unknown) {
    throw new Error(`Unknown prompt part for ${flagName}: ${unknown}`);
  }
  return Array.from(new Set(parts as PromptPartName[]));
}
