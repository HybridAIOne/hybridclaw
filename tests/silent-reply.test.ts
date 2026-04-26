import { describe, expect, test } from 'vitest';
import {
  isSilentReply,
  isSilentReplyPrefix,
  SILENT_REPLY_TOKEN,
  stripSilentToken,
} from '../src/agent/silent-reply.js';
import { createSilentReplyStreamFilter } from '../src/agent/silent-reply-stream.js';
import { normalizeSilentMessageSendReply } from '../src/gateway/chat-result.js';

describe('isSilentReply', () => {
  test('returns true for exact token', () => {
    expect(isSilentReply(SILENT_REPLY_TOKEN)).toBe(true);
  });

  test('returns true for token with surrounding whitespace', () => {
    expect(isSilentReply(`\n  ${SILENT_REPLY_TOKEN}  \t`)).toBe(true);
  });

  test('returns false for undefined null and empty', () => {
    expect(isSilentReply(undefined)).toBe(false);
    expect(isSilentReply(null)).toBe(false);
    expect(isSilentReply('')).toBe(false);
  });

  test('returns false for substantive text ending with token', () => {
    expect(isSilentReply(`Done! ${SILENT_REPLY_TOKEN}`)).toBe(false);
  });

  test('returns false for substantive text starting with token', () => {
    expect(isSilentReply(`${SILENT_REPLY_TOKEN} done`)).toBe(false);
  });

  test('returns false for token embedded in text', () => {
    expect(isSilentReply(`x${SILENT_REPLY_TOKEN}y`)).toBe(false);
  });
});

describe('stripSilentToken', () => {
  test('strips token from end of text', () => {
    expect(stripSilentToken(`Done!\n\n${SILENT_REPLY_TOKEN}`)).toBe('Done!');
  });

  test('preserves text before trailing token', () => {
    expect(stripSilentToken(`Acknowledged ${SILENT_REPLY_TOKEN}`)).toBe(
      'Acknowledged',
    );
  });

  test('returns empty string when only token is present', () => {
    expect(stripSilentToken(`  ${SILENT_REPLY_TOKEN}  `)).toBe('');
  });

  test('does not strip embedded token without delimiter', () => {
    expect(stripSilentToken(`Done${SILENT_REPLY_TOKEN}`)).toBe(
      `Done${SILENT_REPLY_TOKEN}`,
    );
  });

  test('strips only trailing token occurrence', () => {
    expect(
      stripSilentToken(`One ${SILENT_REPLY_TOKEN} Two ${SILENT_REPLY_TOKEN}`),
    ).toBe(`One ${SILENT_REPLY_TOKEN} Two`);
  });

  test('handles markdown formatting before token', () => {
    expect(stripSilentToken(`Done. **${SILENT_REPLY_TOKEN}`)).toBe('Done.');
    expect(stripSilentToken(`Done. **${SILENT_REPLY_TOKEN}**`)).toBe('Done.');
  });
});

describe('isSilentReplyPrefix', () => {
  test('matches uppercase fragments of token', () => {
    expect(isSilentReplyPrefix('__M')).toBe(true);
    expect(isSilentReplyPrefix('__MES')).toBe(true);
    expect(isSilentReplyPrefix('__MESSAGE_SEND_')).toBe(true);
  });

  test('rejects single underscore and very short prefixes', () => {
    expect(isSilentReplyPrefix('_')).toBe(false);
    expect(isSilentReplyPrefix('__')).toBe(false);
  });

  test('rejects text that diverges from token', () => {
    expect(isSilentReplyPrefix('__MESSAGE_SEND_X')).toBe(false);
  });

  test('rejects mixed-case and lowercase prefixes', () => {
    expect(isSilentReplyPrefix('__message')).toBe(false);
    expect(isSilentReplyPrefix('__Message')).toBe(false);
  });
});

describe('createSilentReplyStreamFilter', () => {
  test('buffers deltas that match token prefix', () => {
    const filter = createSilentReplyStreamFilter();
    expect(filter.push('__MESS')).toBe('');
    expect(filter.push('AGE_SEND_')).toBe('');
    expect(filter.isSilent()).toBe(false);
  });

  test('flushes buffered text when stream diverges from token', () => {
    const filter = createSilentReplyStreamFilter();
    expect(filter.push('__MESS')).toBe('');
    expect(filter.push('age')).toBe('__MESSage');
    expect(filter.flush()).toBe('');
    expect(filter.isSilent()).toBe(false);
  });

  test('marks stream as silent when complete token is accumulated', () => {
    const filter = createSilentReplyStreamFilter();
    expect(filter.push('__MESSAGE_')).toBe('');
    expect(filter.push('SEND_HANDLED__')).toBe('');
    expect(filter.flush()).toBe('');
    expect(filter.isSilent()).toBe(true);
  });

  test('handles token split across many tiny deltas', () => {
    const filter = createSilentReplyStreamFilter();
    for (const char of SILENT_REPLY_TOKEN) {
      expect(filter.push(char)).toBe('');
    }
    expect(filter.flush()).toBe('');
    expect(filter.isSilent()).toBe(true);
  });

  test('handles leading whitespace before token', () => {
    const filter = createSilentReplyStreamFilter();
    expect(filter.push('\n')).toBe('');
    expect(filter.push(SILENT_REPLY_TOKEN)).toBe('');
    expect(filter.flush()).toBe('');
    expect(filter.isSilent()).toBe(true);
  });

  test('passes through non-token text that starts similarly', () => {
    const filter = createSilentReplyStreamFilter();
    expect(filter.push('__MESSAGE_SEND_HANDLED__?')).toBe(
      '__MESSAGE_SEND_HANDLED__?',
    );
    expect(filter.flush()).toBe('');
    expect(filter.isSilent()).toBe(false);
  });
});

describe('normalizeSilentMessageSendReply', () => {
  test('strips trailing silent token from visible message send text', () => {
    const result = normalizeSilentMessageSendReply({
      status: 'success',
      result: `Sent.\n\n${SILENT_REPLY_TOKEN}`,
      toolExecutions: [
        {
          name: 'message',
          arguments: JSON.stringify({ action: 'send' }),
          result: JSON.stringify({ ok: true, action: 'send' }),
        },
      ],
    });

    expect(result.result).toBe('Sent.');
  });

  test('replaces exact silent token after message send', () => {
    const result = normalizeSilentMessageSendReply({
      status: 'success',
      result: SILENT_REPLY_TOKEN,
      toolExecutions: [
        {
          name: 'message',
          arguments: JSON.stringify({ action: 'send' }),
          result: JSON.stringify({ ok: true, action: 'send' }),
        },
      ],
    });

    expect(result.result).toBe('Message sent.');
  });
});
