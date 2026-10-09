import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-proof-workspace-');
useCleanMocks({ resetModules: true, unstubAllEnvs: true });

async function proofTool() {
  const workspace = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  const tool = await import('../container/src/tools/proof.js');
  return { workspace, ...tool };
}

test('a screenshot proof is copied where the phone can open it', async () => {
  const { workspace, runProofTool } = await proofTool();
  fs.mkdirSync(path.join(workspace, '.browser-artifacts'));
  fs.writeFileSync(path.join(workspace, '.browser-artifacts', 'shot.png'), 'png');

  const result = runProofTool(
    {
      confirmed: true,
      evidence: 'screenshot',
      summary: 'Order confirmed, number 4711',
      screenshot: '.browser-artifacts/shot.png',
    },
    1000,
  );
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.text)).toMatchObject({
    recorded: true,
    path: 'receipts/proof-1000-shot.png',
  });
  expect(
    fs.readFileSync(path.join(workspace, 'receipts', 'proof-1000-shot.png'), 'utf8'),
  ).toBe('png');
});

test('a proof needs its evidence, and never copies from outside the artifacts', async () => {
  const { workspace, runProofTool } = await proofTool();
  fs.writeFileSync(path.join(workspace, 'USER.md'), 'secret');
  for (const screenshot of ['../USER.md', 'missing.png', '/etc/hosts']) {
    expect(
      runProofTool({
        confirmed: true,
        evidence: 'screenshot',
        summary: 'Done',
        screenshot,
      }).ok,
    ).toBe(false);
  }
  expect(
    runProofTool({ confirmed: true, evidence: 'email', summary: 'Booked' }).ok,
  ).toBe(false);
  expect(runProofTool({ confirmed: true, summary: 'Trust me' }).ok).toBe(false);
  expect(fs.existsSync(path.join(workspace, 'receipts'))).toBe(false);

  const unconfirmed = runProofTool({
    confirmed: false,
    summary: 'No confirmation email yet',
  });
  expect(unconfirmed.ok).toBe(true);
  expect(unconfirmed.text).toContain('could not confirm');
});
