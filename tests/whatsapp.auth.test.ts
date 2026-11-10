import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-whatsapp-auth-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

it.each([
  ['a linked device id', '{"me":{"id":"15550100100:7@s.whatsapp.net"}}', true],
  ['registered without a device id', '{"registered":true}', true],
  ['a blank device id', '{"me":{"id":"  "}}', false],
  ['an unregistered store', '{"registered":false,"me":null}', false],
  ['malformed JSON', '{not json', false],
  ['no creds file', null, false],
] as const)('isWhatsAppLinked reads %s as linked=%s', async (_name, creds, linked) => {
  const dataDir = makeTempDir();
  if (creds !== null) {
    const authDir = path.join(dataDir, 'credentials', 'whatsapp');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'creds.json'), creds);
  }
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
  vi.resetModules();
  const { isWhatsAppLinked } = await import('../src/channels/whatsapp/auth.js');
  expect(isWhatsAppLinked()).toBe(linked);
});
