/**
 * Session storage names preserve exact identity, including case and punctuation.
 * Unlike display/filename sanitizers, these names must not alias another session.
 * This only names gateway IPC and audit directories; it does not migrate data.
 */
import { hash } from 'node:crypto';

export function sessionDirectoryName(sessionId: string): string {
  return `~${hash('sha256', JSON.stringify(sessionId))}`;
}
