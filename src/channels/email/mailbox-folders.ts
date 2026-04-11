import type { ImapFlow, ListOptions, ListResponse } from 'imapflow';

const NOSELECT_FLAG = '\\Noselect';
const TRASH_FOLDER_PATTERNS = [
  'trash',
  'bin',
  'deleted',
  'deleted messages',
  'papierkorb',
  'gelöscht',
] as const;
const SENT_FOLDER_PATTERNS = [
  'sent',
  'sent mail',
  'sent messages',
  'sent items',
  'gesendet',
  'gesendete',
] as const;

function normalizeFolderPath(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

export function isSelectableFolder(entry: {
  flags: Set<string>;
}): boolean {
  return !entry.flags.has(NOSELECT_FLAG);
}

export function isTrashFolderCandidate(entry: {
  path?: string;
  name?: string;
  specialUse?: string | null;
}): boolean {
  if (normalizeFolderPath(entry.specialUse) === '\\trash') {
    return true;
  }
  const haystack = [
    normalizeFolderPath(entry.path),
    normalizeFolderPath(entry.name),
  ].join(' ');
  return TRASH_FOLDER_PATTERNS.some((pattern) => haystack.includes(pattern));
}

export function isSentFolderCandidate(entry: {
  path?: string;
  name?: string;
  specialUse?: string | null;
}): boolean {
  if (normalizeFolderPath(entry.specialUse) === '\\sent') {
    return true;
  }
  const haystack = [
    normalizeFolderPath(entry.path),
    normalizeFolderPath(entry.name),
  ].join(' ');
  return SENT_FOLDER_PATTERNS.some((pattern) => haystack.includes(pattern));
}

export async function listSelectableFolders(
  client: ImapFlow,
  options?: ListOptions,
): Promise<ListResponse[]> {
  return (await client.list(options)).filter(isSelectableFolder);
}

export async function resolveTrashFolderPath(
  client: ImapFlow,
): Promise<string | null> {
  return (await listSelectableFolders(client)).find(isTrashFolderCandidate)?.path || null;
}

export async function resolveSentFolderPath(
  client: ImapFlow,
): Promise<string | null> {
  return (await listSelectableFolders(client)).find(isSentFolderCandidate)?.path || null;
}
