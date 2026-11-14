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

test('a per-session read or append leaves a legacy wire log untouched', async () => {
  const sessionId = 'session.test';
  const legacy = path.join(dataDir, 'audit', 'session_test');
  fs.mkdirSync(legacy, { recursive: true });
  const wire = path.join(legacy, 'wire.jsonl');
  const bytes = JSON.stringify({ sessionId }) + '\n';
  fs.writeFileSync(wire, bytes);
  expect(audit.verifyAuditSessionChain(sessionId).ok).toBe(false);
  for (const id of [sessionId, 'session_test']) {
    await audit.appendAuditEvent({ sessionId: id, runId: 'run-a', event: { type: 'test' } });
    expect(audit.verifyAuditSessionChain(id)).toMatchObject({ ok: true, checkedRecords: 1 });
  }
  expect(fs.readFileSync(wire, 'utf8')).toBe(bytes);
});

test('leak scanning resolves the exact session ID in a hashed directory', async () => {
  await audit.appendAuditEvent({ sessionId: 'session.test', runId: 'run-a', event: { type: 'test' } });
  const { scanAuditSessionForLeaks, listAuditedSessions, scanAllAuditSessionsForLeaks } = await import('../src/audit/leak-scanner.js');
  const { parseConfidentialYaml } = await import('../src/security/confidential-rules.js');
  const rules = parseConfidentialYaml('clients: []');
  const report = scanAuditSessionForLeaks('session.test', rules, dataDir);
  expect(report.errors).toEqual([]);
  expect(listAuditedSessions(dataDir)).toEqual([{ sessionId: 'session.test', filePath: report.filePath }]);
  expect(scanAllAuditSessionsForLeaks(rules, dataDir).map((item) => item.filePath)).toEqual([report.filePath]);
});
