export interface AtomicWriteOptions {
  /** Exact mode of the written file (applied with chmod, so umask is ignored). */
  mode?: number;
  /** Mode for parent directories this write creates. */
  dirMode?: number;
}

/** Creates or replaces `targetPath`. */
export function writeFileAtomic(
  targetPath: string,
  content: string | Uint8Array,
  options?: AtomicWriteOptions,
): void;
export function writeFileAtomicAsync(
  targetPath: string,
  content: string | Uint8Array,
  options?: AtomicWriteOptions,
): Promise<void>;
/** Creates `targetPath`; throws `EEXIST` instead of replacing an existing file. */
export function writeFileAtomicExclusive(
  targetPath: string,
  content: string | Uint8Array,
  options?: AtomicWriteOptions,
): void;
