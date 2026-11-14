import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { isWhatsAppLinked } from '../src/channels/whatsapp/auth.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-whatsapp-auth-');

test.each([
  [{ registered: false, me: { id: '15550100100:7@s.whatsapp.net' } }, true],
  [{ registered: true }, true],
  [{ me: { id: ' ' } }, false],
] as const)('reads pairing status from %j', (creds, linked) => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds));
  expect(isWhatsAppLinked(dir)).toBe(linked);
});

test('missing or unreadable credentials count as unlinked', () => {
  const dir = makeTempDir();
  expect(isWhatsAppLinked(dir)).toBe(false);
  fs.writeFileSync(path.join(dir, 'creds.json'), '{');
  expect(isWhatsAppLinked(dir)).toBe(false);
});
