import { expect, test } from 'vitest';
import { sniffImageMimeType } from '@hybridclaw/shared/image-mime';

test.each([
  ['89504e470d0a1a0a0000000d', 'image/png'],
  ['ffd8ffe000104a464946', 'image/jpeg'],
  [Buffer.from('GIF87a').toString('hex'), 'image/gif'],
  [Buffer.from('GIF89a').toString('hex'), 'image/gif'],
  [Buffer.from('RIFF0000WEBP').toString('hex'), 'image/webp'],
  ['', null],
  ['89504e47', null],
  ['ffd8', null],
  [Buffer.from('GIF89').toString('hex'), null],
  [Buffer.from('RIFF0000WAVE').toString('hex'), null],
  [Buffer.from('<html>not an image</html>').toString('hex'), null],
] as const)('classifies the bounded signature %s', (hex, expected) => {
  expect(sniffImageMimeType(Buffer.from(hex, 'hex'))).toBe(expected);
});

test('uses the byte view offset without mutating the source', () => {
  const bytes = Buffer.from('0000ffd8ffe000', 'hex');
  const before = Buffer.from(bytes);
  expect(sniffImageMimeType(bytes.subarray(2))).toBe('image/jpeg');
  expect(bytes).toEqual(before);
});
