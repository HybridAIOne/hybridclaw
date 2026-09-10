export function lockMemoryFile(filePath: string): () => void;
export function waitForMemoryFileLock(filePath: string): Promise<() => void>;
export function writeMemoryFileAtomic(filePath: string, content: string): void;
