import { describe, expect, test } from 'vitest';
import { appendHatchingChannelSetupLinks } from '../src/gateway/hatching-completion.js';

describe('appendHatchingChannelSetupLinks', () => {
  test('appends channel setup links after welcome message hatching completion', () => {
    const result = appendHatchingChannelSetupLinks({
      resultText: 'I sent the welcome email.',
      hatchingCompletion: {
        completed: true,
        updated: true,
        reason: 'message sent',
      },
    });

    expect(result).toContain('I sent the welcome email.');
    expect(result).toContain('Optional channel setup:');
    expect(result).toContain('[Set up WhatsApp](/admin/channels#whatsapp)');
    expect(result).toContain('[Set up Discord](/admin/channels#discord)');
    expect(result).toContain('[Set up Telegram](/admin/channels#telegram)');
    expect(result).not.toContain('`/admin/channels#whatsapp`');
  });

  test('does not duplicate channel setup links already in the response', () => {
    const resultText = [
      'I sent the welcome email.',
      '',
      'Optional channel setup:',
      '- [Set up WhatsApp](/admin/channels#whatsapp)',
      '- [Set up Discord](/admin/channels#discord)',
      '- [Set up Telegram](/admin/channels#telegram)',
    ].join('\n');

    const result = appendHatchingChannelSetupLinks({
      resultText,
      hatchingCompletion: {
        completed: true,
        updated: true,
        reason: 'message sent',
      },
    });

    expect(result).toBe(resultText);
  });

  test('does not append channel setup links for fallback hatching completion', () => {
    const result = appendHatchingChannelSetupLinks({
      resultText: 'Still learning.',
      hatchingCompletion: {
        completed: true,
        updated: true,
        reason: 'no message sent after 3 hatching turns',
        turnsWithoutMessage: 3,
      },
    });

    expect(result).toBe('Still learning.');
  });
});
