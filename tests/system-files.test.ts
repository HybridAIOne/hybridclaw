import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  listSystemFiles,
  readSystemFile,
} from '../src/gateway/system-files.js';
import {
  DEVICE_TOKEN_ACTIONS,
  OWNER_DEVICE_TOKEN_ACTIONS,
} from '../src/gateway/device-grants.js';
import {
  resolveAdminRbacAction,
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
    expect(resolveAdminRbacAction('/api/system/files', 'PUT')).toBeNull();
    expect(OWNER_DEVICE_TOKEN_ACTIONS).toContain('system_files.read');
    expect(DEVICE_TOKEN_ACTIONS).not.toContain('system_files.read');
    expect(ADMIN_RBAC_ROLE_ACTIONS['admin.viewer']).not.toContain(
      'system_files.read',
    );
  });
});

describe('system file HTTP responses', () => {
  useCleanMocks();
  it('returns fresh pages, raw empty files, missing paths and rejects writes', async () => {
    const root = temp();
    fs.writeFileSync(path.join(root, 'empty.md'), '');
    homes.clear();
    homes.set('main', root);
    homes.set('archived', root);
    const custom = temp();
    homes.set('custom', custom);
    fs.writeFileSync(path.join(custom, 'custom.md'), 'Custom home');
    const { handleSystemFilesRoute } = await import(
      '../src/gateway/system-files.js'
    );
    const call = (method: string, query: string) => {
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
      handleSystemFilesRoute(
        res as unknown as ServerResponse,
        method,
        new URL(`http://localhost/api/system/files?${query}`),
      );
      return result;
    };
    const listed = call('GET', '');
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body.toString())).toMatchObject({
      scope: 'agent-home',
      agentId: 'main',
      path: '',
    });
    expect(
      JSON.parse(call('GET', 'agentId=custom').body.toString()).entries[0].name,
    ).toBe('custom.md');
    expect(call('GET', 'agentId=unknown').status).toBe(404);
    expect(call('GET', 'agentId=archived').status).toBe(404);
    expect(call('GET', 'path=..%2Fconfig.json&download=true').status).toBe(400);
    expect(
      call('GET', 'agentId=custom&path=empty.md&download=true').status,
    ).toBe(404);
    expect(call('GET', 'path=..').status).toBe(400);
    expect(
      call('GET', 'path=empty.md&download=true').headers[
        'X-HybridClaw-File-Scope'
      ],
    ).toBe('agent-home');
    expect(listed.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(listed.body.toString()).entries[0].name).toBe('empty.md');
    expect(call('GET', 'path=empty.md&download=true').body.length).toBe(0);
    expect(call('GET', 'path=missing.md&download=true').status).toBe(404);
    expect(call('GET', 'path=%2Fetc%2Fpasswd').status).toBe(400);
    expect(call('PUT', '').status).toBe(405);
    expect(fs.readFileSync(path.join(root, 'empty.md')).length).toBe(0);
  });
});
