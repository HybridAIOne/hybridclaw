import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { changeNotes, listNotes, readNote } from '../src/gateway/notes-store.js';
import { handleNotesRoute } from '../src/gateway/notes.js';
import { OWNER_DEVICE_TOKEN_ACTIONS, DEVICE_TOKEN_ACTIONS } from '../src/gateway/device-grants.js';
import { resolveAdminRbacAction } from '../src/security/admin-rbac.js';
import { useTempDir } from './test-utils.js';
const homes = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/agents/agent-registry.js', () => ({ getAgentById: (id: string) => homes.has(id) ? { id, archived: id === 'archived' } : null }));
vi.mock('../src/infra/ipc.js', () => ({ agentWorkspaceDir: (id: string) => homes.get(id) }));
const temp = useTempDir('notes-');
function create(root: string, title = 'Groceries', parentId: string | null = null) {
  const before = listNotes(root);
  changeNotes(root, { operation: 'create', revision: before.revision, title, parentId, content: '- [ ] Milk\n- [ ] Bread\n' });
  return listNotes(root).pages.at(-1)!;
}
describe('shared notebook', () => {
  it('keeps stable IDs and content through renames and nested moves', () => {
    const root = temp(); const trip = create(root, 'Trip'); const packing = create(root, 'Packing', trip.id);
    changeNotes(root, { operation: 'rename', id: trip.id, title: 'Holiday', revision: listNotes(root).revision });
    changeNotes(root, { operation: 'move', id: packing.id, parentId: null, position: 0, revision: listNotes(root).revision });
    expect(listNotes(root).pages[0]).toEqual({ ...packing, parentId: null });
    expect(readNote(root, packing.id).content).toContain('Milk');
    expect(readNote(root, trip.id).page.title).toBe('Holiday');
  });
  it('rejects stale tree and page writes without losing the other edit', () => {
    const root = temp(); const original = listNotes(root); const page = create(root);
    expect(() => changeNotes(root, { operation: 'create', title: 'Stale', revision: original.revision })).toThrow('changed');
    const note = readNote(root, page.id);
    changeNotes(root, { operation: 'save', id: page.id, revision: note.revision, content: '- [x] Milk\n' });
    expect(() => changeNotes(root, { operation: 'save', id: page.id, revision: note.revision, content: 'Lost update' })).toThrow('changed');
    expect(readNote(root, page.id).content).toBe('- [x] Milk\n');
    expect(readNote(root, page.id).history).toHaveLength(1);
    expect(readNote(root, page.id, note.revision).content).toBe(note.content);
  });
  it('restores a version through an ordinary revision-checked save', () => {
    const root = temp(); const page = create(root); const first = readNote(root, page.id);
    changeNotes(root, { operation: 'save', id: page.id, revision: first.revision, content: 'New' });
    const next = readNote(root, page.id);
    changeNotes(root, { operation: 'save', id: page.id, revision: next.revision, content: readNote(root, page.id, first.revision).content });
    expect(readNote(root, page.id).content).toBe(first.content);
    expect(readNote(root, page.id).history).toHaveLength(2);
  });
  it('prevents cycles and missing parents; archives and restores a subtree', () => {
    const root = temp(); const parent = create(root, 'Parent'); const child = create(root, 'Child', parent.id);
    expect(() => changeNotes(root, { operation: 'move', id: parent.id, parentId: child.id, position: 0, revision: listNotes(root).revision })).toThrow('contain itself');
    expect(() => create(root, 'Missing', '00000000-0000-4000-8000-000000000000')).toThrow('not found');
    changeNotes(root, { operation: 'archive', id: parent.id, revision: listNotes(root).revision });
    expect(listNotes(root).pages.every(p => p.archived)).toBe(true);
    expect(() => changeNotes(root, { operation: 'unarchive', id: child.id, revision: listNotes(root).revision })).toThrow('parent');
    changeNotes(root, { operation: 'unarchive', id: parent.id, revision: listNotes(root).revision });
    expect(listNotes(root).pages.every(p => !p.archived)).toBe(true);
    expect(readNote(root, child.id).content).toContain('Milk');
  });
  it('creates one scratchpad without replacing existing content', () => {
    const root = temp();
    for (const title of ['Our scratchpad', 'Other title']) changeNotes(root, { operation: 'scratchpad', title, revision: listNotes(root).revision });
    expect(listNotes(root).pages).toHaveLength(1);
    expect(readNote(root, 'scratchpad').page.title).toBe('Our scratchpad');
  });
  it.each(['../outside', '/etc/passwd', '', 'main', 'scratchpad/../../secret'])('rejects unsafe page ID %s', id => {
    expect(() => readNote(temp(), id)).toThrow('page ID');
  });
  it('excludes symlinked indexes, content, history and folders', () => {
    const outside = temp(); fs.writeFileSync(path.join(outside, 'private.md'), 'private');
    for (const target of ['notes', 'notes/index.json', 'notes/pages', 'notes/history']) {
      const root = temp(); const page = create(root);
      const full = path.join(root, target); fs.rmSync(full, { recursive: true, force: true }); fs.symlinkSync(outside, full);
      expect(() => changeNotes(root, { operation: 'save', id: page.id, revision: '0'.repeat(64), content: '' })).toThrow();
      expect(() => target === 'notes/history' ? readNote(root, page.id) : create(root)).toThrow();
    }
    const root = temp(); const page = create(root); fs.unlinkSync(path.join(root, `notes/pages/${page.id}.md`)); fs.symlinkSync(path.join(outside, 'private.md'), path.join(root, `notes/pages/${page.id}.md`));
    expect(() => readNote(root, page.id)).toThrow();
  });
  it('refuses a held lock, oversized content and a corrupted index', () => {
    const root = temp(); const page = create(root); fs.mkdirSync(path.join(root, 'notes/index.json.lock'));
    expect(() => create(root)).toThrow('busy'); fs.rmdirSync(path.join(root, 'notes/index.json.lock'));
    expect(() => changeNotes(root, { operation: 'save', id: page.id, revision: readNote(root, page.id).revision, content: 'x'.repeat(1024 * 1024 + 1) })).toThrow('1 MB');
    fs.writeFileSync(path.join(root, 'notes/index.json'), JSON.stringify({ version: 1, pages: [{ ...page, parentId: page.id }] }));
    expect(() => listNotes(root)).toThrow('cycle');
  });
  it('uses separate read/write capabilities granted only to owner phones', () => {
    expect(resolveAdminRbacAction('/api/notes', 'GET')).toBe('notes.read');
    expect(resolveAdminRbacAction('/api/notes', 'POST')).toBe('notes.write');
    expect(resolveAdminRbacAction('/api/notes', 'DELETE')).toBe(null);
    expect(OWNER_DEVICE_TOKEN_ACTIONS).toEqual(expect.arrayContaining(['notes.read', 'notes.write']));
    expect(DEVICE_TOKEN_ACTIONS).not.toEqual(expect.arrayContaining(['notes.write']));
  });
  it('scopes HTTP responses to the requested registered workspace', async () => {
    const root = temp(); homes.set('notes-test', root); create(root);
    const req = Readable.from([]) as IncomingMessage; let status = 0; let result = '';
    const res = { setHeader: vi.fn(), writeHead: (code: number) => { status = code; }, end: (value: string) => { result = value; } } as unknown as ServerResponse;
    await handleNotesRoute(req, res, 'GET', new URL('http://localhost/api/notes?agentId=notes-test'));
    expect(status).toBe(200); expect(JSON.parse(result)).toMatchObject({ scope: 'agent-notes', agentId: 'notes-test', pages: [{ title: 'Groceries' }] });
    await handleNotesRoute(req, res, 'GET', new URL('http://localhost/api/notes?agentId=unknown'));
    expect(status).toBe(404); expect(result).not.toContain('Groceries'); homes.clear();
  });
});
