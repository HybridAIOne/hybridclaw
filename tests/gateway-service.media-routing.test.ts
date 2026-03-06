import { expect, test } from 'vitest';

import { resolveMediaToolPolicy } from '../src/gateway/gateway-service.js';
import type { MediaContextItem } from '../src/types.js';

const SAMPLE_MEDIA: MediaContextItem[] = [
  {
    path: '/discord-media-cache/2026-03-04/sample.png',
    url: 'https://cdn.discordapp.com/attachments/1/2/sample.png',
    originalUrl: 'https://cdn.discordapp.com/attachments/1/2/sample.png',
    mimeType: 'image/png',
    sizeBytes: 1234,
    filename: 'sample.png',
  },
];

test('Discord image question blocks browser_vision and prioritizes vision_analyze', () => {
  const policy = resolveMediaToolPolicy(
    'Was steht auf dem Bild?',
    SAMPLE_MEDIA,
  );
  expect(policy.prioritizeVisionTool).toBe(true);
  expect(policy.blockedTools).toEqual(['browser_vision']);
});

test('Explicit browser-tab question does not block browser_vision', () => {
  const policy = resolveMediaToolPolicy(
    'What is on the current browser tab?',
    SAMPLE_MEDIA,
  );
  expect(policy.prioritizeVisionTool).toBe(false);
  expect(policy.blockedTools).toBeUndefined();
});

test('No media context leaves tool policy unchanged', () => {
  const policy = resolveMediaToolPolicy('Was steht auf dem Bild?', []);
  expect(policy.prioritizeVisionTool).toBe(false);
  expect(policy.blockedTools).toBeUndefined();
});
