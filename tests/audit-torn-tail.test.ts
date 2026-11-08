import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';
const temp = useTempDir();
useCleanMocks({
  cleanup: async () => {
    await (await import('../src/audit/audit-trail.js')).flushAuditTrail();
  },
  resetModules: true,
  unstubAllEnvs: true,
});
test.each([false, true])(
  'a torn tail cannot absorb the next acknowledged record (cold=%s)',
  async (cold) => {
    vi.stubEnv('HYBRIDCLAW_DATA_DIR', temp());
    const audit = await import('../src/audit/audit-trail.js');
    const first = await audit.appendAuditEvent({
      sessionId: 'test-session',
      runId: 'test-run',
      event: { type: 'before' },
    });
    const file = audit.getAuditWirePath('test-session');
    fs.appendFileSync(file, '{"version":');
    const before = fs.readFileSync(file, 'utf8');
    if (cold) audit.forgetAuditSessionState(['test-session']);
    const next = await audit.appendAuditEvent({
      sessionId: 'test-session',
      runId: 'test-run',
      event: { type: 'after' },
    });
    const content = fs.readFileSync(file, 'utf8');
    expect(content.startsWith(before)).toBe(true);
    expect(JSON.parse(content.trimEnd().split('\n').at(-1)!)).toEqual(next);
    expect(next._prevHash).toBe(first._hash);
    expect(audit.verifyAuditSessionChain('test-session')).toMatchObject({
      ok: false,
      checkedRecords: 2,
    });
  },
);
test('a complete record without its newline is separated without changing its hash', async () => {
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', temp());
  const audit = await import('../src/audit/audit-trail.js');
  const first = await audit.appendAuditEvent({
    sessionId: 'test-session',
    runId: 'test-run',
    event: { type: 'before' },
  });
  const file = audit.getAuditWirePath('test-session');
  fs.truncateSync(file, fs.statSync(file).size - 1);
  const next = await audit.appendAuditEvent({
    sessionId: 'test-session',
    runId: 'test-run',
    event: { type: 'after' },
  });
  expect(next._prevHash).toBe(first._hash);
  expect(audit.verifyAuditSessionChain('test-session')).toMatchObject({
    ok: true,
    checkedRecords: 2,
  });
});
