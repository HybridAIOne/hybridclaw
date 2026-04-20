import { SkillImportError } from './skill-errors.js';

export const MAX_IMPORT_FILE_COUNT = 256;
export const MAX_IMPORT_TOTAL_BYTES = 5 * 1024 * 1024;

export interface ImportState {
  fileCount: number;
  totalBytes: number;
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
