import { expect, test } from 'vitest';
import {
  guessWhatsAppExtensionFromMimeType,
  resolveWhatsAppMimeTypeFromPath,
} from '../plugins/whatsapp/src/mime-utils.js';
import { createWhatsAppTestHost } from './whatsapp-test-host.js';

const host = createWhatsAppTestHost();

test('maps WhatsApp MIME types to canonical extensions', () => {
  expect(guessWhatsAppExtensionFromMimeType(host, 'image/jpeg')).toBe('.jpg');
  expect(guessWhatsAppExtensionFromMimeType(host, 'audio/ogg; codecs=opus')).toBe(
    '.ogg',
  );
  expect(guessWhatsAppExtensionFromMimeType(host, 'video/quicktime')).toBe('.mov');
  expect(guessWhatsAppExtensionFromMimeType(host, 'application/unknown')).toBe('');
});

test('resolves WhatsApp MIME types from file paths', () => {
  expect(resolveWhatsAppMimeTypeFromPath(host, '/tmp/picture.jpeg')).toBe(
    'image/jpeg',
  );
  expect(resolveWhatsAppMimeTypeFromPath(host, '/tmp/voice.ogg')).toBe('audio/ogg');
  expect(resolveWhatsAppMimeTypeFromPath(host, '/tmp/movie.mov')).toBe(
    'video/quicktime',
  );
  expect(resolveWhatsAppMimeTypeFromPath(host, '/tmp/archive.bin')).toBe(
    'application/octet-stream',
  );
});
