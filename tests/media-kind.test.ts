import {
  isAudioMediaItem,
  isImageMediaItem,
  normalizeMimeType,
} from '@hybridclaw/shared/media-kind';
import { expect, test } from 'vitest';

test.each([
  [' audio/ogg; codecs=opus ', 'audio/ogg'],
  ['IMAGE/PNG', 'image/png'],
  ['', null],
  [undefined, null],
])('normalizeMimeType(%j) is %j', (raw, expected) => {
  expect(normalizeMimeType(raw)).toBe(expected);
});

test.each([
  [{ mimeType: 'image/heic', filename: 'photo' }, 'image'],
  [{ mimeType: null, filename: 'photo.HEIC' }, 'image'],
  [{ mimeType: null, filename: 'scan.tiff' }, 'image'],
  [{ mimeType: 'audio/ogg; codecs=opus', filename: 'note' }, 'audio'],
  [{ mimeType: null, filename: 'recording.MP3' }, 'audio'],
  [{ mimeType: '', filename: 'clip.webm' }, 'audio'],
  [{ mimeType: 'application/pdf', filename: 'report.pdf' }, 'document'],
  [{ mimeType: null, filename: 'photo.png.txt' }, 'document'],
])('%j is classified as %s', (item, kind) => {
  expect(isImageMediaItem(item)).toBe(kind === 'image');
  expect(isAudioMediaItem(item)).toBe(kind === 'audio');
});
