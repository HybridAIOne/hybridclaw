/**
 * Phone browsing is rooted in one registered agent's workspace. Runtime state,
 * hidden/credential files and non-document binaries are excluded from both
 * listings, downloads and Markdown edits. Revisions prevent stale saves; reset
 * uses shipped defaults. This is not the chat artifact delivery API.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { getAgentById } from '../agents/agent-registry.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { isRecord } from '../utils/type-guards.js';
import { readWorkspaceTemplate } from '../workspace-templates.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';

export { SYSTEM_FILES_PATH } from '../security/admin-rbac.js';

const PAGE_SIZE = 500;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MARKDOWN_BYTES = 1024 * 1024;

// Owner request, 2026-10-04: show working documents, not secrets, scratch files
// or executable/runtime data. Unknown formats stay hidden; archives are excluded
// because their contents cannot be filtered without unpacking them.
const EXCLUDED_DIRECTORIES = new Set([
  'tmp',
  'temp',
  'cache',
  'caches',
  'node_modules',
  'vendor',
  'venv',
  '__pycache__',
  'build',
  'dist',
  'target',
  'bin',
  'obj',
  'logs',
]);
const DOCUMENT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.rst',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.swift',
  '.kt',
  '.kts',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.r',
  '.tex',
  '.bib',
  '.ipynb',
  '.pdf',
  '.rtf',
  '.doc',
  '.docx',
  '.odt',
  '.xls',
  '.xlsx',
  '.ods',
  '.ppt',
  '.pptx',
  '.odp',
  '.pages',
  '.numbers',
  '.keynote',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.heic',
  '.tif',
  '.tiff',
  '.svg',
  '.mp3',
  '.m4a',
  '.wav',
  '.aac',
  '.ogg',
  '.flac',
  '.mp4',
  '.mov',
  '.webm',
]);
const TEXT_FILENAMES = new Set([
  'readme',
  'license',
  'licence',
  'makefile',
  'dockerfile',
]);

function visibleName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    !lower.startsWith('.') &&
    !lower.startsWith('~') &&
    !lower.endsWith('~') &&
    !/(^|[._-])(credentials?|keys?|secrets?|tokens?|passwords?|private[._-]?key|auth|oauth|env)([._-]|$)/.test(
      lower,
    ) &&
    !/^id_(rsa|dsa|ecdsa|ed25519)([._-]|$)/.test(lower) &&
    !/(^|[._-])service[._-]?account([._-]|$)/.test(lower) &&
    !/\.(key|pem|p12|pfx|p8|der|crt|cer|pub|jks|keystore|gpg|pgp|asc|tmp|temp|swp|swo|bak|backup|old|part|partial|crdownload|lock)([.-]|$)/.test(
      lower,
    )
  );
}

function visibleEntry(name: string, stats: fs.Stats | fs.Dirent): boolean {
  if (!visibleName(name)) return false;
  if (stats.isDirectory()) return !EXCLUDED_DIRECTORIES.has(name.toLowerCase());
  return (
    stats.isFile() &&
    (DOCUMENT_EXTENSIONS.has(path.extname(name).toLowerCase()) ||
      TEXT_FILENAMES.has(name.toLowerCase()))
  );
}

function resolveFile(root: string, relative: string): string {
  const parts = relative === '' ? [] : relative.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.includes('\0') ||
        part.includes('\\'),
    ) ||
    path.isAbsolute(relative)
  ) {
    throw new GatewayRequestError(400, 'Expected a relative runtime path.');
  }
  let target = fs.realpathSync(root);
  for (const part of parts) {
    target = path.join(target, part);
    if (!visibleEntry(part, fs.lstatSync(target))) {
      throw new GatewayRequestError(
        403,
        'This file or folder is excluded from browsing.',
      );
    }
  }
  return target;
}

export function listSystemFiles(
  root: string,
  relative: string,
  offset: number,
) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new GatewayRequestError(400, 'Invalid directory offset.');
  }
  const target = resolveFile(root, relative);
  if (!fs.statSync(target).isDirectory())
    throw new GatewayRequestError(400, 'Expected a folder.');
  const children = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((entry) => visibleEntry(entry.name, entry))
    .sort((a, b) => {
      return (
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name)
      );
    });
  const entries = children.slice(offset, offset + PAGE_SIZE).map((entry) => {
    const stats = fs.lstatSync(path.join(target, entry.name));
    const kind = stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : stats.isSymbolicLink()
          ? 'symlink'
          : 'other';
    return {
      name: entry.name,
      path: relative ? `${relative}/${entry.name}` : entry.name,
      kind,
      size: stats.isFile() ? stats.size : null,
    };
  });
  return {
    path: relative,
    entries,
    nextOffset:
      offset + PAGE_SIZE < children.length ? offset + PAGE_SIZE : null,
  };
}

export function readSystemFile(
  root: string,
  relative: string,
  limit = MAX_FILE_BYTES,
): Buffer {
  const target = resolveFile(root, relative);
  const fd = fs.openSync(
    target,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stats = fs.fstatSync(fd);
    const current = fs.statSync(resolveFile(root, relative));
    if (stats.ino !== current.ino || stats.dev !== current.dev) {
      throw new GatewayRequestError(409, 'File changed while opening.');
    }
    if (!stats.isFile())
      throw new GatewayRequestError(400, 'Expected a regular file.');
    if (stats.size > limit)
      throw new GatewayRequestError(
        413,
        limit === MAX_FILE_BYTES
          ? 'File exceeds 25 MB.'
          : 'Markdown exceeds 1 MB.',
      );
    const buffer = Buffer.alloc(Math.min(stats.size + 1, limit + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(
        fd,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!count) break;
      length += count;
    }
    if (length > stats.size)
      throw new GatewayRequestError(409, 'File changed while reading.');
    return buffer.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}

// Only existing visible Markdown files can be changed. Reset never means delete
// or empty: files without a shipped template have no reset operation.
export function readSystemMarkdown(root: string, relative: string) {
  if (!['.md', '.markdown'].includes(path.extname(relative).toLowerCase())) {
    throw new GatewayRequestError(415, 'Only Markdown files can be edited.');
  }
  const bytes = readSystemFile(root, relative, MAX_MARKDOWN_BYTES);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new GatewayRequestError(415, 'Expected UTF-8 Markdown.');
  }
  if (content.includes('\0')) {
    throw new GatewayRequestError(415, 'Expected text Markdown.');
  }
  return {
    content,
    revision: createHash('sha256').update(bytes).digest('hex'),
    canReset: readWorkspaceTemplate(relative) !== null,
  };
}

export function updateSystemMarkdown(
  root: string,
  relative: string,
  revision: string,
  content: string | null,
) {
  if (!/^[a-f0-9]{64}$/.test(revision)) {
    throw new GatewayRequestError(400, 'Expected a file revision.');
  }
  const current = readSystemMarkdown(root, relative);
  if (current.revision !== revision) {
    throw new GatewayRequestError(409, 'File changed. Reload before saving.');
  }
  const next = content === null ? readWorkspaceTemplate(relative) : content;
  if (next === null) {
    throw new GatewayRequestError(422, 'This file has no default.');
  }
  if (
    next.includes('\0') ||
    Buffer.from(next, 'utf8').toString('utf8') !== next
  ) {
    throw new GatewayRequestError(415, 'Expected UTF-8 Markdown.');
  }
  if (Buffer.byteLength(next, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw new GatewayRequestError(413, 'Markdown exceeds 1 MB.');
  }
  const target = resolveFile(root, relative);
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.hy-markdown-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, next, {
      flag: 'wx',
      mode: fs.statSync(target).mode & 0o777,
    });
    // Revalidate after preparing the replacement. A deleted, moved or changed
    // file must never be recreated or overwritten by a stale editor.
    if (
      resolveFile(root, relative) !== target ||
      fs.realpathSync(parent) !== parent ||
      readSystemMarkdown(root, relative).revision !== revision
    ) {
      throw new GatewayRequestError(409, 'File changed. Reload before saving.');
    }
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return readSystemMarkdown(root, relative);
}

export async function handleSystemFilesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-HybridClaw-File-Scope', 'agent-home');
  if (!['GET', 'PUT', 'POST'].includes(method)) {
    res.setHeader('Allow', 'GET, PUT, POST');
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  try {
    const agentId = url.searchParams.get('agentId') ?? DEFAULT_AGENT_ID;
    const agent = getAgentById(agentId);
    if (!agent || agent.archived) {
      throw new GatewayRequestError(404, 'Agent home is unavailable.');
    }
    const root = agentWorkspaceDir(agent.id);
    const relative = url.searchParams.get('path') ?? '';
    if (method !== 'GET' || url.searchParams.get('edit') === 'true') {
      let file: ReturnType<typeof readSystemMarkdown>;
      if (method === 'GET') {
        file = readSystemMarkdown(root, relative);
      } else {
        // JSON escaping can expand one content byte to six bytes.
        const body = await readJsonBody(req, 6 * MAX_MARKDOWN_BYTES + 1024);
        if (
          !isRecord(body) ||
          typeof body.revision !== 'string' ||
          (method === 'PUT' && typeof body.content !== 'string')
        ) {
          throw new GatewayRequestError(
            400,
            'Expected revision and Markdown content.',
          );
        }
        file = updateSystemMarkdown(
          root,
          relative,
          body.revision,
          method === 'POST' ? null : (body.content as string),
        );
      }
      sendJson(res, 200, {
        ...file,
        path: relative,
        scope: 'agent-home',
        agentId: agent.id,
      });
    } else if (url.searchParams.get('download') === 'true') {
      const bytes = readSystemFile(root, relative);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': bytes.length,
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(bytes);
    } else {
      sendJson(res, 200, {
        ...listSystemFiles(
          root,
          relative,
          Number(url.searchParams.get('offset') ?? '0'),
        ),
        scope: 'agent-home',
        agentId: agent.id,
      });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const status =
      error instanceof GatewayRequestError
        ? error.statusCode
        : code === 'ENOENT'
          ? 404
          : ['EACCES', 'EPERM', 'ELOOP'].includes(code ?? '')
            ? 403
            : 500;
    sendJson(res, status, {
      error:
        error instanceof GatewayRequestError
          ? error.message
          : 'Could not read this runtime path.',
    });
  }
}
