import type { ChatMessage } from '@hybridclaw/contracts/agent-io';
import { chatContentText } from '@hybridclaw/shared/message-text';
import { describe, expect, test } from 'vitest';

const IMAGE = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } };
const AUDIO = { type: 'audio_url', audio_url: { url: '/media/clip.ogg' } };
const PDF = { type: 'file', file: { filename: 'a.pdf', file_data: 'AA' } };

describe('chatContentText', () => {
  test.each([
    ['string content', 'plain', {}, 'plain'],
    ['null content', null, {}, ''],
    ['undefined content', undefined, {}, ''],
    [
      'text parts only',
      [{ type: 'text', text: 'a' }, IMAGE, { type: 'text', text: '' }, PDF],
      {},
      'a',
    ],
    [
      'media placeholders',
      [{ type: 'text', text: 'a' }, IMAGE, AUDIO, PDF],
      { mediaPlaceholders: true },
      'a\n[image]\n[audio]',
    ],
  ] as const)('%s', (_label, content, options, expected) => {
    expect(
      chatContentText(content as ChatMessage['content'], options),
    ).toBe(expected);
  });
});
