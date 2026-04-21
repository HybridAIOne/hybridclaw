import fs from 'node:fs';
import path from 'node:path';

import { SkillImportError } from './skill-errors.js';

export { ensureText } from '../utils/shared-utils.js';

export const MAX_IMPORT_FILE_COUNT = 256;
export const MAX_IMPORT_TOTAL_BYTES = 5 * 1024 * 1024;

export interface ImportState {
  fileCount: number;
  totalBytes: number;
}

function createImportBudgetError(): SkillImportError {
  return new SkillImportError(
    `Remote skill exceeds the ${MAX_IMPORT_TOTAL_BYTES} byte import limit.`,
  );
}

function concatByteChunks(
  chunks: Uint8Array[],
  totalBytes: number,
): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function normalizeImportedSkillRelativePath(
  relativePath: string,
): string {
  return relativePath.toLowerCase() === 'skill.md' ? 'SKILL.md' : relativePath;
}

export function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

export function normalizeRepoPath(value: string): string {
  return trimSlashes(value).replace(/\/+/g, '/');
}

export function assertSafeRelativePath(relativePath: string): void {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/')) {
    throw new SkillImportError(`Unsafe skill file path: ${relativePath}`);
  }

  const parts = normalized.split('/');
  if (
    parts.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw new SkillImportError(`Unsafe skill file path: ${relativePath}`);
  }
}

export function assertImportBudget(state: ImportState, bytes: number): void {
  if (state.fileCount + 1 > MAX_IMPORT_FILE_COUNT) {
    throw new SkillImportError(
      `Remote skill exceeds the ${MAX_IMPORT_FILE_COUNT}-file import limit.`,
    );
  }
  if (state.totalBytes + bytes > MAX_IMPORT_TOTAL_BYTES) {
    throw new SkillImportError(
      `Remote skill exceeds the ${MAX_IMPORT_TOTAL_BYTES} byte import limit.`,
    );
  }
}

export function recordImportedFile(state: ImportState, bytes: number): void {
  assertImportBudget(state, bytes);
  state.fileCount += 1;
  state.totalBytes += bytes;
}

export async function readResponseBytesWithinImportBudget(
  response: Response,
  state: ImportState,
): Promise<Uint8Array> {
  assertImportBudget(state, 0);
  const remainingBytes = MAX_IMPORT_TOTAL_BYTES - state.totalBytes;
  if (remainingBytes < 0) {
    throw createImportBudgetError();
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertImportBudget(state, bytes.byteLength);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > remainingBytes) {
        await reader.cancel().catch(() => undefined);
        throw createImportBudgetError();
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return concatByteChunks(chunks, totalBytes);
}

export function writeImportedFile(
  rootDir: string,
  relativePath: string,
  bytes: Uint8Array,
  state: ImportState,
): void {
  const normalizedRelativePath =
    normalizeImportedSkillRelativePath(relativePath);
  assertSafeRelativePath(normalizedRelativePath);
  recordImportedFile(state, bytes.byteLength);
  const targetPath = path.join(rootDir, normalizedRelativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(bytes));
}
