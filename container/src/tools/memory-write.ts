/**
 * Daily-note intake enforces the cap; removal can shrink oversized external notes.
 * Mutations share a lock, and rejected payload hashes survive worker replacement.
 * Unlike dream consolidation, this never summarizes or discards notes itself.
 * Callers enforce the today-only path boundary and approval policy.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DAILY_MEMORY_MAX_CHARS } from '@hybridclaw/shared/daily-memory';
import {
  waitForMemoryFileLock,
  writeMemoryFileAtomic,
} from '@hybridclaw/shared/memory-file';
import { SessionStateSet } from '../session-state.js';
import type { ToolRunResult } from '../types.js';
import { assertTextPayload } from './text-payload.js';

function capacity(content: string) {
  const trimmed = content.trimEnd();
  return {
    current_chars: content.length,
    limit_chars: DAILY_MEMORY_MAX_CHARS,
    remaining_chars: Math.max(0, DAILY_MEMORY_MAX_CHARS - content.length),
    append_capacity_chars: Math.max(
      0,
      DAILY_MEMORY_MAX_CHARS - trimmed.length - (trimmed ? 3 : 1),
    ),
  };
}

export function formatMemoryCapacity(content: string): string {
  return `Capacity: ${JSON.stringify(capacity(content))}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function capacityFailure(
  filePath: string,
  relativePath: string,
  sessionId: string,
  existing: string,
  action: string,
  payload: unknown,
  attemptedChars: number,
): Promise<ToolRunResult> {
  const rejected = new SessionStateSet(
    `memory-capacity-${digest(filePath)}.json`,
    true,
  );
  const revision = `${digest(existing)}:`;
  const fingerprint = `${revision}${digest([action, payload])}`;
  let repeated = false;
  await rejected.updateLockedSession(sessionId || 'default', (values) => {
    if ([...values].some((value) => !value.startsWith(revision)))
      values.clear();
    repeated = values.has(fingerprint);
    values.add(fingerprint);
  });
  return {
    isError: true,
    // Session maintenance recognizes this prefix as a rejected append.
    output: `Error: ${relativePath} would exceed ${DAILY_MEMORY_MAX_CHARS} chars.\n${JSON.stringify(
      {
        code: repeated ? 'MEMORY_RETRY_BLOCKED' : 'MEMORY_CAPACITY_EXCEEDED',
        file_path: relativePath,
        ...capacity(existing),
        attempted_chars: attemptedChars,
        overflow_chars: attemptedChars - DAILY_MEMORY_MAX_CHARS,
        next_actions: ['read', 'replace'],
        recovery:
          'Do not repeat this unchanged write. Read this daily note, then use replace with exact old_text to condense duplicate or verbose entries while preserving every unique fact. Append only new durable facts that fit append_capacity_chars. Do not truncate the note, overwrite it blindly, bypass the limit with other tools, or write another date. Dream consolidation does not free daily-note space. If safe condensation is not possible, report that memory was not saved and continue the user task.',
      },
    )}`,
  };
}

export async function runMemoryWrite(
  action: string,
  relativePath: string,
  filePath: string,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<ToolRunResult> {
  const fail = (output: string): ToolRunResult => ({ output, isError: true });
  const release = await waitForMemoryFileLock(filePath);
  try {
    const exists = fs.existsSync(filePath);
    const existing = exists ? fs.readFileSync(filePath, 'utf8') : '';
    let next: string;
    let result: string;
    let payload: unknown;
    switch (action) {
      case 'append': {
        const content =
          typeof args.content === 'string' ? args.content.trim() : '';
        if (!content)
          return fail('Error: content is required for memory append');
        const trimmed = existing.trimEnd();
        next = `${trimmed}${trimmed ? '\n\n' : ''}${content}\n`;
        payload = content;
        result = `Appended ${content.length} chars to ${relativePath}`;
        break;
      }
      case 'write':
        if (args.confirm_overwrite !== true) {
          return fail(
            'Error: memory write replaces the entire daily note. Set confirm_overwrite=true only to intentionally overwrite it; use append to save additional notes.',
          );
        }
        assertTextPayload(args.content, 'content');
        next = args.content;
        payload = next;
        result = `Wrote ${next.length} chars to ${relativePath}`;
        break;
      case 'replace':
      case 'remove': {
        const oldText = typeof args.old_text === 'string' ? args.old_text : '';
        const newText = action === 'remove' ? '' : args.new_text;
        assertTextPayload(newText, 'new_text');
        if (!oldText)
          return fail(`Error: old_text is required for memory ${action}`);
        if (!exists) return fail(`Error: File not found: ${relativePath}`);
        if (!existing.includes(oldText))
          return fail(`Error: old_text not found in ${relativePath}`);
        next = existing.replace(oldText, () => newText);
        payload = [oldText, newText];
        result =
          action === 'remove'
            ? `Removed matching text from ${relativePath}`
            : `Updated ${relativePath}`;
        break;
      }
      default:
        return fail(
          `Error: unknown memory action "${action}". Use read, append, write, replace, remove, list, or search.`,
        );
    }
    if (action !== 'remove' && next.length > DAILY_MEMORY_MAX_CHARS) {
      return await capacityFailure(
        filePath,
        relativePath,
        sessionId,
        existing,
        action,
        payload,
        next.length,
      );
    }
    writeMemoryFileAtomic(filePath, next);
    return {
      output: `${result}\n${formatMemoryCapacity(next)}`,
      isError: false,
    };
  } finally {
    release();
  }
}
