import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.css',
  '.csv',
  '.env',
  '.go',
  '.graphql',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.log',
  '.md',
  '.mjs',
  '.mts',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
]);
const TEXT_BASENAMES = new Set([
  '.gitignore',
  '.npmrc',
  'Dockerfile',
  'LICENSE',
  'Makefile',
  'README',
]);
const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.bin',
  '.class',
  '.dll',
  '.dmg',
  '.doc',
  '.docx',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.lockb',
  '.mov',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.pyc',
  '.sqlite',
  '.tar',
  '.ttf',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.xls',
  '.xlsx',
  '.zip',
]);

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  return (
    targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`)
  );
}

export async function resolveAndValidatePath(
  cwd: string,
  target: string,
  allowedRoot = cwd,
): Promise<string> {
  const resolvedRoot = path.resolve(allowedRoot);
  const resolvedTarget = path.resolve(cwd, target);
  if (!isWithinRoot(resolvedTarget, resolvedRoot)) {
    throw new Error(`Path escapes allowed root: ${target}`);
  }

  const realRoot = await realpath(resolvedRoot).catch(() => resolvedRoot);
  const realTarget = await realpath(resolvedTarget).catch((error) => {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return null;
    }
    throw error;
  });

  if (realTarget && !isWithinRoot(realTarget, realRoot)) {
    throw new Error(`Path escapes allowed root: ${target}`);
  }

  return resolvedTarget;
}

export async function isBinaryFile(filePath: string): Promise<boolean> {
  const extension = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);
  if (TEXT_BASENAMES.has(basename) || TEXT_EXTENSIONS.has(extension)) {
    return false;
  }
  if (BINARY_EXTENSIONS.has(extension)) {
    return true;
  }

  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4_096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export function isSensitiveFile(filePath: string): boolean {
  const normalized = path
    .normalize(filePath)
    .replace(/\\/gu, '/')
    .toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  const basename = parts.at(-1) || '';

  if (basename.startsWith('.env')) return true;
  if (basename.startsWith('credentials.')) return true;
  if (basename.endsWith('.key') || basename.endsWith('.pem')) return true;
  if (parts.includes('.aws') || parts.includes('.ssh')) return true;
  return false;
}
