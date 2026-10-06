import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { readWorkspaceTemplate } from '../src/workspace-templates.js';
import { describe, expect, it, vi } from 'vitest';
import {
  listSystemFiles,
  readSystemFile,
  readSystemMarkdown,
  updateSystemMarkdown,
  MAX_MARKDOWN_BYTES,
  handleSystemFilesRoute,
} from '../src/gateway/system-files.js';
import {
  DEVICE_TOKEN_ACTIONS,
  OWNER_DEVICE_TOKEN_ACTIONS,
} from '../src/gateway/device-grants.js';
import {
  resolveAdminRbacAction,
  isAdminActionAllowed,
  ADMIN_RBAC_ROLE_ACTIONS,
} from '../src/security/admin-rbac.js';
import { useTempDir, useCleanMocks } from './test-utils.js';

const homes = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/agents/agent-registry.js', () => ({
  getAgentById: (id: string) =>
    homes.has(id) ? { id, archived: id === 'archived' } : null,
}));
vi.mock('../src/infra/ipc.js', () => ({
  agentWorkspaceDir: (id: string) => homes.get(id),
}));

const temp = useTempDir('system-files-');

describe('runtime system files', () => {
  it('lists folders first, hides dotfiles and reads nested and empty files', () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'agents'));
    fs.writeFileSync(path.join(root, 'agents', 'Hy März.md'), 'Hello');
    fs.writeFileSync(path.join(root, '.hidden'), '');
    expect(
      listSystemFiles(root, '', 0).entries.map((entry) => entry.name),
    ).toEqual(['agents']);
    expect(listSystemFiles(root, 'agents', 0).entries[0].path).toBe(
      'agents/Hy März.md',
    );
    expect(readSystemFile(root, 'agents/Hy März.md').toString()).toBe('Hello');
    fs.writeFileSync(path.join(root, 'empty.md'), '');
    expect(readSystemFile(root, 'empty.md').length).toBe(0);
    expect(() => readSystemFile(root, '.hidden')).toThrow();
  });
  it.each([
    '../outside',
    '/etc/passwd',
    'agents/../outside',
    'a//b',
    '.',
    'a\0',
  ])('refuses traversal %s', (relative) => {
    const root = temp();
    expect(() => listSystemFiles(root, relative, 0)).toThrow();
    expect(() => readSystemFile(root, relative)).toThrow();
  });
  it('hides symlinks and refuses opening a link or walking through one', () => {
    const root = temp();
    const outside = temp();
    fs.writeFileSync(path.join(outside, 'private'), 'not exposed');
    fs.symlinkSync(outside, path.join(root, 'link'));
    expect(listSystemFiles(root, '', 0).entries).toEqual([]);
    expect(() => listSystemFiles(root, 'link', 0)).toThrow();
    expect(() => readSystemFile(root, 'link/private')).toThrow();
  });
  it('bounds downloads and refuses folders as files', () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'folder'));
    const large = path.join(root, 'large.txt');
    const fd = fs.openSync(large, 'w');
    fs.ftruncateSync(fd, 25 * 1024 * 1024 + 1);
    fs.closeSync(fd);
    expect(() => readSystemFile(root, 'large.txt')).toThrow('25 MB');
    expect(() => readSystemFile(root, 'folder')).toThrow();
  });
  it('paginates without omitting entries and validates offsets', () => {
    const root = temp();
    for (let i = 0; i < 502; i++)
      fs.writeFileSync(path.join(root, `${i}.md`), '');
    const first = listSystemFiles(root, '', 0);
    const last = listSystemFiles(root, '', first.nextOffset!);
    expect(first.entries.length).toBe(500);
    expect(last.entries.length).toBe(2);
    expect(last.nextOffset).toBeNull();
    expect(
      new Set([...first.entries, ...last.entries].map((entry) => entry.path))
        .size,
    ).toBe(502);
    for (const offset of [-1, NaN, 1.5])
      expect(() => listSystemFiles(root, '', offset)).toThrow();
  });
  it.each([
    '.env',
    '.env.local',
    '.ssh',
    'id_rsa',
    'id_ed25519',
    'credentials.json',
    'oauth-token.json',
    'secrets.yaml',
    'service-account.json',
    'backup.PEM',
    'key.pem.txt',
    'cert.p12',
    'signing.key',
    'notes.tmp',
    'notes.tmp.md',
    'notes.md~',
    '~$report.docx',
    'notes.bak',
    'app.exe',
    'library.dylib',
    'model.bin',
    'archive.zip',
    'state.sqlite',
    'cache.db',
    'unknown.xyz',
  ])('hides and refuses excluded file %s', (name) => {
    const root = temp();
    fs.writeFileSync(path.join(root, name), 'excluded');
    expect(listSystemFiles(root, '', 0).entries).toEqual([]);
    expect(() => readSystemFile(root, name)).toThrow();
  });
  it.each([
    'tmp',
    'temp',
    'cache',
    'node_modules',
    '.git',
    '.aws',
    '__pycache__',
    'build',
    'dist',
  ])('hides excluded directory %s and denies its descendants', (name) => {
    const root = temp();
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'notes.md'), 'excluded');
    expect(listSystemFiles(root, '', 0).entries).toEqual([]);
    expect(() => listSystemFiles(root, name, 0)).toThrow();
    expect(() => readSystemFile(root, `${name}/notes.md`)).toThrow();
  });
  it('retains documents, media and source and filters before pagination', () => {
    const root = temp();
    for (const name of [
      'SOUL.md',
      'MEMORY.md',
      'report.PDF',
      'photo.jpg',
      'table.xlsx',
      'script.py',
      'README',
    ]) {
      fs.writeFileSync(path.join(root, name), 'document');
      expect(readSystemFile(root, name).toString()).toBe('document');
    }
    for (let i = 0; i < 510; i++)
      fs.writeFileSync(path.join(root, `${i}.tmp`), 'excluded');
    const page = listSystemFiles(root, '', 0);
    expect(page.entries).toHaveLength(7);
    expect(page.nextOffset).toBeNull();
  });
  it('requires a distinct capability, grants owners and keeps paired chat tokens narrow', () => {
    expect(resolveAdminRbacAction('/api/system/files', 'GET')).toBe(
      'system_files.read',
    );
    expect(resolveAdminRbacAction('/api/system/files', 'PUT')).toBe(
      'system_files.write',
    );
    expect(resolveAdminRbacAction('/api/system/files', 'POST')).toBe(
      'system_files.write',
    );
    expect(resolveAdminRbacAction('/api/system/files', 'DELETE')).toBeNull();
    expect(OWNER_DEVICE_TOKEN_ACTIONS).toContain('system_files.write');
    expect(DEVICE_TOKEN_ACTIONS).not.toContain('system_files.write');
    expect(
      isAdminActionAllowed(
        { actions: ['system_files.read'] },
        'system_files.write',
      ),
    ).toBe(false);
    expect(OWNER_DEVICE_TOKEN_ACTIONS).toContain('system_files.read');
    expect(DEVICE_TOKEN_ACTIONS).not.toContain('system_files.read');
    expect(ADMIN_RBAC_ROLE_ACTIONS['admin.viewer']).not.toContain(
      'system_files.read',
    );
  });
});

async function call(method: string, query: string, body: unknown = {}) {
  const result = {
    status: 0,
    body: Buffer.alloc(0),
    headers: {} as Record<string, unknown>,
  };
  const res = {
    setHeader(name: string, value: unknown) {
      result.headers[name] = value;
    },
    writeHead(status: number, headers: Record<string, unknown>) {
      result.status = status;
      Object.assign(result.headers, headers);
    },
    end(bytes: string | Buffer) {
      result.body = Buffer.from(bytes);
    },
  };
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  await handleSystemFilesRoute(
    req,
    res as unknown as ServerResponse,
    method,
    new URL(`http://localhost/api/system/files?${query}`),
  );
  return result;
}

describe('system file HTTP responses', () => {
  useCleanMocks();
  it('returns scoped pages, raw files and missing homes without permitting parent access', async () => {
    const root = temp();
    fs.writeFileSync(path.join(root, 'empty.md'), '');
    homes.clear();
    homes.set('main', root);
    homes.set('archived', root);
    const custom = temp();
    homes.set('custom', custom);
    fs.writeFileSync(path.join(custom, 'custom.md'), 'Custom home');
    const listed = await call('GET', '');
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body.toString())).toMatchObject({
      scope: 'agent-home',
      agentId: 'main',
      path: '',
    });
    expect(
      JSON.parse((await call('GET', 'agentId=custom')).body.toString())
        .entries[0].name,
    ).toBe('custom.md');
    expect((await call('GET', 'agentId=unknown')).status).toBe(404);
    expect((await call('GET', 'agentId=archived')).status).toBe(404);
    expect(
      (await call('GET', 'path=..%2Fconfig.json&download=true')).status,
    ).toBe(400);
    expect(
      (await call('GET', 'agentId=custom&path=empty.md&download=true')).status,
    ).toBe(404);
    expect((await call('GET', 'path=..')).status).toBe(400);
    expect(
      (await call('GET', 'path=empty.md&download=true')).headers[
        'X-HybridClaw-File-Scope'
      ],
    ).toBe('agent-home');
    expect(listed.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(listed.body.toString()).entries[0].name).toBe('empty.md');
    expect((await call('GET', 'path=empty.md&download=true')).body.length).toBe(
      0,
    );
    expect((await call('GET', 'path=missing.md&download=true')).status).toBe(
      404,
    );
    expect((await call('GET', 'path=%2Fetc%2Fpasswd')).status).toBe(400);
    expect((await call('DELETE', '')).status).toBe(405);
  });
  it('allows escaped Markdown at the byte limit and rejects oversized content', async () => {
    const root = temp();
    homes.set('size-limit', root);
    fs.writeFileSync(path.join(root, 'notes.md'), 'Before');
    const revision = readSystemMarkdown(root, 'notes.md').revision;
    const query = 'agentId=size-limit&path=notes.md';
    const saved = await call('PUT', query, {
      revision,
      content: '\n'.repeat(MAX_MARKDOWN_BYTES),
    });
    expect(saved.status).toBe(200);
    const nextRevision = JSON.parse(saved.body.toString()).revision;
    expect(
      (
        await call('PUT', query, {
          revision: nextRevision,
          content: 'x'.repeat(MAX_MARKDOWN_BYTES + 1),
        })
      ).status,
    ).toBe(413);
    expect(fs.statSync(path.join(root, 'notes.md')).size).toBe(
      MAX_MARKDOWN_BYTES,
    );
  });
  it('edits and resets with revisions, validates bodies, and isolates agent homes', async () => {
    const root = temp();
    homes.set('editor', root);
    fs.writeFileSync(path.join(root, 'SOUL.md'), 'Custom personality');
    const query = 'agentId=editor&path=SOUL.md';
    const opened = JSON.parse(
      (await call('GET', `${query}&edit=true`)).body.toString(),
    );
    expect(opened).toMatchObject({
      scope: 'agent-home',
      agentId: 'editor',
      path: 'SOUL.md',
      canReset: true,
    });
    expect(
      (await call('PUT', query, { content: 'Missing revision' })).status,
    ).toBe(400);
    const saved = await call('PUT', query, {
      revision: opened.revision,
      content: 'Updated',
    });
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(path.join(root, 'SOUL.md'), 'utf8')).toBe('Updated');
    expect(
      (await call('POST', query, { revision: opened.revision })).status,
    ).toBe(409);
    const reset = await call('POST', query, {
      revision: JSON.parse(saved.body.toString()).revision,
    });
    expect(reset.status).toBe(200);
    expect(JSON.parse(reset.body.toString()).content).toBe(
      readWorkspaceTemplate('SOUL.md'),
    );
    expect(
      (
        await call('PUT', 'agentId=unknown&path=SOUL.md', {
          revision: opened.revision,
          content: 'No',
        })
      ).status,
    ).toBe(404);
    expect((await call('GET', 'agentId=editor&path=SOUL.md')).status).toBe(400);
  });
});

describe('Markdown edits', () => {
  it('saves Unicode and empty content atomically while preserving mode', () => {
    const root = temp();
    const file = path.join(root, 'notes.MARKDOWN');
    fs.writeFileSync(file, 'Before', { mode: 0o640 });
    const original = readSystemMarkdown(root, 'notes.MARKDOWN');
    const saved = updateSystemMarkdown(
      root,
      'notes.MARKDOWN',
      original.revision,
      '# Grüße 🌍',
    );
    expect(saved.content).toBe('# Grüße 🌍');
    expect(saved.revision).not.toBe(original.revision);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(
      updateSystemMarkdown(root, 'notes.MARKDOWN', saved.revision, '').content,
    ).toBe('');
    expect(fs.readdirSync(root)).toEqual(['notes.MARKDOWN']);
  });
  it('resets only root files with a shipped default', () => {
    const root = temp();
    fs.writeFileSync(path.join(root, 'SOUL.md'), 'Customized');
    const original = readSystemMarkdown(root, 'SOUL.md');
    expect(original.canReset).toBe(true);
    expect(
      updateSystemMarkdown(root, 'SOUL.md', original.revision, null).content,
    ).toBe(readWorkspaceTemplate('SOUL.md'));
    fs.mkdirSync(path.join(root, 'notes'));
    fs.writeFileSync(path.join(root, 'notes', 'SOUL.md'), 'My note');
    const note = readSystemMarkdown(root, 'notes/SOUL.md');
    expect(note.canReset).toBe(false);
    expect(() =>
      updateSystemMarkdown(root, 'notes/SOUL.md', note.revision, null),
    ).toThrow('no default');
    expect(fs.readFileSync(path.join(root, 'notes', 'SOUL.md'), 'utf8')).toBe(
      'My note',
    );
  });
  it('refuses stale edits and resets and never recreates a deleted file', () => {
    const root = temp();
    const file = path.join(root, 'SOUL.md');
    fs.writeFileSync(file, 'Before');
    const original = readSystemMarkdown(root, 'SOUL.md');
    fs.writeFileSync(file, 'Newer change');
    for (const content of ['Stale edit', null]) {
      expect(() =>
        updateSystemMarkdown(root, 'SOUL.md', original.revision, content),
      ).toThrow('File changed');
      expect(fs.readFileSync(file, 'utf8')).toBe('Newer change');
    }
    fs.unlinkSync(file);
    expect(() =>
      updateSystemMarkdown(root, 'SOUL.md', original.revision, 'Stale edit'),
    ).toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
  it.each([
    '../outside.md',
    '/etc/notes.md',
    '.private.md',
    'credentials.md',
    'notes.txt',
    'photo.png',
    'tmp/notes.md',
    'link.md',
  ])('refuses edits outside the visible Markdown boundary: %s', (relative) => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'tmp'));
    for (const name of [
      '.private.md',
      'credentials.md',
      'notes.txt',
      'photo.png',
      'tmp/notes.md',
    ])
      fs.writeFileSync(path.join(root, name), 'Do not change');
    const outside = path.join(temp(), 'outside.md');
    fs.writeFileSync(outside, 'Outside');
    fs.symlinkSync(outside, path.join(root, 'link.md'));
    expect(() =>
      updateSystemMarkdown(root, relative, 'a'.repeat(64), 'No'),
    ).toThrow();
    expect(fs.readFileSync(outside, 'utf8')).toBe('Outside');
  });
  it('preserves the original and cleans up when atomic replacement fails', () => {
    const root = temp();
    fs.writeFileSync(path.join(root, 'notes.md'), 'Before');
    const original = readSystemMarkdown(root, 'notes.md');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('Write failed');
    });
    try {
      expect(() =>
        updateSystemMarkdown(root, 'notes.md', original.revision, 'After'),
      ).toThrow('Write failed');
    } finally {
      rename.mockRestore();
    }
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('Before');
    expect(fs.readdirSync(root)).toEqual(['notes.md']);
  });
  it('refuses invalid text and oversized input without changing the file', () => {
    const root = temp();
    const file = path.join(root, 'notes.md');
    fs.writeFileSync(file, 'Before');
    const original = readSystemMarkdown(root, 'notes.md');
    for (const content of [
      'a\0b',
      '\ud800',
      'x'.repeat(MAX_MARKDOWN_BYTES + 1),
    ]) {
      expect(() =>
        updateSystemMarkdown(root, 'notes.md', original.revision, content),
      ).toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe('Before');
    }
    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from('a\0b'),
      Buffer.alloc(MAX_MARKDOWN_BYTES + 1),
    ]) {
      fs.writeFileSync(file, bytes);
      expect(() => readSystemMarkdown(root, 'notes.md')).toThrow();
    }
  });
});
