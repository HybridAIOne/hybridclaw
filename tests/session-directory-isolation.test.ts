import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { sessionDirectoryName } from '../src/utils/session-directory.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-session-dirs-');
useCleanMocks({ restoreAllMocks: true, resetModules: true, unstubAllEnvs: true });
let dataDir: string;
let audit: typeof import('../src/audit/audit-trail.js');
let ipc: typeof import('../src/infra/ipc.js');

beforeEach(async () => {
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', makeTempDir());
  audit = await import('../src/audit/audit-trail.js');
  ipc = await import('../src/infra/ipc.js');
  dataDir = (await import('../src/config/config.js')).DATA_DIR;
});

const ids = ['session.test', 'session_test', 'Session_test', ' session_test ', '../session_test', '', 'session', 'a'.repeat(1000), '\ud800', '\ud801', '\ufffd'];

test('storage names remain distinct on case-insensitive filesystems and fit one path component', () => {
  const names = ids.map(sessionDirectoryName);
  expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(ids.length);
  for (const name of names) expect(name).toMatch(/^~[a-f0-9]{64}$/);
});

test('colliding legacy names have independent IPC files and audit chains', async () => {
  for (const sessionId of ids) {
    ipc.ensureSessionDirs(sessionId);
    fs.writeFileSync(path.join(ipc.getSessionPaths(sessionId, 'main').ipcPath, 'input.json'), JSON.stringify(sessionId));
    await audit.appendAuditEvent({ sessionId, runId: 'run-a', event: { type: 'test', owner: sessionId } });
  }
  expect(fs.readdirSync(path.join(dataDir, 'sessions'))).toHaveLength(ids.length);
  for (const sessionId of ids) {
    expect(JSON.parse(fs.readFileSync(path.join(ipc.getSessionPaths(sessionId, 'main').ipcPath, 'input.json'), 'utf8'))).toBe(sessionId);
  }
  ipc.cleanupIpc(ids[0]);
  expect(fs.existsSync(path.join(ipc.getSessionPaths(ids[1], 'main').ipcPath, 'input.json'))).toBe(true);
  for (const sessionId of ids) {
    const wire = fs.readFileSync(audit.getAuditWirePath(sessionId), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(wire.every((record) => record.sessionId === sessionId)).toBe(true);
    expect(audit.verifyAuditSessionChain(sessionId).ok).toBe(true);
  }
});

async function legacyLog(sessionId: string) {
  await audit.appendAuditEvent({ sessionId, runId: 'run-a', event: { type: 'test' } });
  audit.forgetAuditSessionState([sessionId]);
  const current = audit.getAuditSessionDir(sessionId);
  const legacy = path.join(dataDir, 'audit', sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '_'));
  fs.renameSync(current, legacy);
  return legacy;
}

test('moves an owned legacy log without changing its bytes or chain', async () => {
  const legacy = await legacyLog('session.test');
  const before = fs.readFileSync(path.join(legacy, 'wire.jsonl'), 'utf8');
  expect(fs.readFileSync(audit.getAuditWirePath('session.test'), 'utf8')).toBe(before);
  expect(fs.existsSync(legacy)).toBe(false);
  await audit.appendAuditEvent({ sessionId: 'session.test', runId: 'run-b', event: { type: 'test' } });
  expect(audit.verifyAuditSessionChain('session.test')).toMatchObject({ ok: true, checkedRecords: 2 });
});

test('a colliding session cannot claim another session’s legacy log', async () => {
  const legacy = await legacyLog('session.test');
  await audit.appendAuditEvent({ sessionId: 'session_test', runId: 'run-b', event: { type: 'test' } });
  expect(fs.existsSync(legacy)).toBe(true);
  expect(audit.verifyAuditSessionChain('session_test')).toMatchObject({ ok: true, checkedRecords: 1 });
  expect(audit.verifyAuditSessionChain('session.test')).toMatchObject({ ok: true, checkedRecords: 1 });
});

test('leaves an already mixed legacy log untouched and fails closed', async () => {
  const legacy = await legacyLog('session.test');
  const wire = path.join(legacy, 'wire.jsonl');
  fs.appendFileSync(wire, `${JSON.stringify({ sessionId: 'session_test' })}\n`);
  const before = fs.readFileSync(wire, 'utf8');
  for (const sessionId of ['session.test', 'session_test']) {
    expect(() => audit.getAuditWirePath(sessionId)).toThrow('multiple sessions');
  }
  expect(fs.readFileSync(wire, 'utf8')).toBe(before);
});

test('leak scanning resolves the exact session ID after migration', async () => {
  await legacyLog('session.test');
  const { scanAuditSessionForLeaks, listAuditedSessions, scanAllAuditSessionsForLeaks } = await import('../src/audit/leak-scanner.js');
  const { parseConfidentialYaml } = await import('../src/security/confidential-rules.js');
  const rules = parseConfidentialYaml('clients: []');
  const report = scanAuditSessionForLeaks('session.test', rules, dataDir);
  expect(report.errors).toEqual([]);
  expect(listAuditedSessions(dataDir)).toEqual([{ sessionId: 'session.test', filePath: report.filePath }]);
  expect(scanAllAuditSessionsForLeaks(rules, dataDir).map((item) => item.filePath)).toEqual([report.filePath]);
});

test.each(['{', 'null', '{}', ''])(
  'does not migrate a legacy log with malformed or missing identity: %j',
  async (raw) => {
    const legacy = await legacyLog('session.test');
    const wire = path.join(legacy, 'wire.jsonl');
    fs.writeFileSync(wire, raw);
    expect(() => audit.getAuditWirePath('session.test')).toThrow(/Legacy audit log/);
    expect(fs.readFileSync(wire, 'utf8')).toBe(raw);
  },
);
