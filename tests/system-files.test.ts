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

const temp = useTempDir('system-files-');

describe('runtime system files', () => {
  it('lists folders first, includes hidden files and reads nested and empty files', () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'agents'));
    fs.writeFileSync(path.join(root, 'agents', 'Hy März.md'), 'Hello');
    fs.writeFileSync(path.join(root, '.hidden'), '');
    expect(
      listSystemFiles(root, '', 0).entries.map((entry) => entry.name),
    ).toEqual(['agents', '.hidden']);
    expect(listSystemFiles(root, 'agents', 0).entries[0].path).toBe(
      'agents/Hy März.md',
    );
    expect(readSystemFile(root, 'agents/Hy März.md').toString()).toBe('Hello');
    expect(readSystemFile(root, '.hidden').length).toBe(0);
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
  it('lists symlinks but refuses opening a link or walking through one', () => {
    const root = temp();
    const outside = temp();
    fs.writeFileSync(path.join(outside, 'private'), 'not exposed');
    fs.symlinkSync(outside, path.join(root, 'link'));
    expect(listSystemFiles(root, '', 0).entries[0].kind).toBe('symlink');
    expect(() => listSystemFiles(root, 'link', 0)).toThrow();
    expect(() => readSystemFile(root, 'link/private')).toThrow();
  });
  it('bounds downloads and refuses folders as files', () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'folder'));
    const large = path.join(root, 'large');
    const fd = fs.openSync(large, 'w');
    fs.ftruncateSync(fd, 25 * 1024 * 1024 + 1);
    fs.closeSync(fd);
    expect(() => readSystemFile(root, 'large')).toThrow('25 MB');
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
  useCleanMocks({
    resetModules: true,
    unmock: ['../src/config/runtime-paths.js'],
  });
  it('returns fresh pages, raw empty files, missing paths and rejects writes', async () => {
    vi.resetModules();
    const root = temp();
    fs.writeFileSync(path.join(root, 'empty.md'), '');
    vi.doMock('../src/config/runtime-paths.js', () => ({
      DEFAULT_RUNTIME_HOME_DIR: root,
    }));
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
    expect(listed.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(listed.body.toString()).entries[0].name).toBe('empty.md');
    expect(call('GET', 'path=empty.md&download=true').body.length).toBe(0);
    expect(call('GET', 'path=missing&download=true').status).toBe(404);
    expect(call('GET', 'path=%2Fetc%2Fpasswd').status).toBe(400);
    expect(call('PUT', '').status).toBe(405);
    expect(fs.readFileSync(path.join(root, 'empty.md')).length).toBe(0);
  });
});
