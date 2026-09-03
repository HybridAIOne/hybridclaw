import { describe, expect, test } from 'vitest';

import {
  hasMessageSendToolExecution,
  normalizePendingApprovalReply,
  normalizePlaceholderToolReply,
  normalizeSilentMessageSendReply,
} from '../src/gateway/chat-result.js';
import type { GatewayChatResult } from '../src/gateway/gateway-types.js';

function makeResult(
  overrides: Partial<GatewayChatResult> = {},
): GatewayChatResult {
  return {
    status: 'success',
    result: 'Done.',
    toolsUsed: ['vision_analyze'],
    artifacts: [],
    toolExecutions: [],
    ...overrides,
  };
}

describe('normalizePlaceholderToolReply', () => {
  test('uses the last successful vision analysis instead of a Done placeholder', () => {
    const result = makeResult({
      toolExecutions: [
        {
          name: 'vision_analyze',
          arguments: '{"file_path":"/tmp/image.jpg"}',
          result: JSON.stringify({
            success: true,
            analysis: 'A basil plant in a terracotta pot.',
          }),
          durationMs: 43800,
        },
      ],
    });

    expect(normalizePlaceholderToolReply(result)).toMatchObject({
      result: 'A basil plant in a terracotta pot.',
    });
  });

  test('normalizes legacy image analysis tool executions', () => {
    const result = makeResult({
      toolExecutions: [
        {
          name: 'image',
          arguments: '{"file_path":"/tmp/image.jpg"}',
          result: JSON.stringify({
            success: true,
            analysis: 'A basil plant in a terracotta pot.',
          }),
          durationMs: 43800,
        },
      ],
    });

    expect(normalizePlaceholderToolReply(result)).toMatchObject({
      result: 'A basil plant in a terracotta pot.',
    });
  });

  test('leaves non-placeholder replies unchanged', () => {
    const result = makeResult({
      result: 'Direct model answer',
      toolExecutions: [
        {
          name: 'vision_analyze',
          arguments: '{}',
          result: JSON.stringify({
            success: true,
            analysis: 'Should not replace a real answer.',
          }),
          durationMs: 12,
        },
      ],
    });

    expect(normalizePlaceholderToolReply(result)).toBe(result);
  });

  test('uses failed vision tool results as a fallback instead of Done', () => {
    const result = makeResult({
      toolExecutions: [
        {
          name: 'vision_analyze',
          arguments: '{}',
          result: JSON.stringify({
            success: false,
            error: 'model failed',
          }),
          durationMs: 12,
          isError: true,
        },
      ],
    });

    expect(normalizePlaceholderToolReply(result)).toMatchObject({
      result: 'vision_analyze failed: model failed.',
    });
  });

  test('uses a concise tool failure summary instead of a Done placeholder', () => {
    const result = makeResult({
      toolsUsed: ['browser_navigate', 'browser_snapshot'],
      toolExecutions: [
        {
          name: 'browser_navigate',
          arguments: '{"url":"https://astroviewer.net/iss/"}',
          result: JSON.stringify({
            success: false,
            error:
              'browser command failed: npm warn deprecated glob@10.5.0: Old versions are not supported',
          }),
          durationMs: 8882,
          isError: true,
        },
        {
          name: 'browser_snapshot',
          arguments: '{"mode":"full"}',
          result: JSON.stringify({
            success: false,
            error:
              "browserType.launchPersistentContext: Executable doesn't exist at /tmp/chromium",
          }),
          durationMs: 5789,
          isError: true,
        },
      ],
    });

    expect(normalizePlaceholderToolReply(result)).toMatchObject({
      result:
        'Tool calls failed: browser_navigate, browser_snapshot. Last error: browser runtime is not installed.',
    });
  });
});

describe('normalizeSilentMessageSendReply', () => {
  const silentToken = '__MESSAGE_SEND_HANDLED__';

  test('renders "Message sent." only when a message send actually succeeded', () => {
    const result = normalizeSilentMessageSendReply(
      makeResult({
        result: silentToken,
        toolsUsed: ['message'],
        toolExecutions: [
          {
            name: 'message',
            arguments: '{"action":"send","to":"+491234567890","content":"hi"}',
            result: JSON.stringify({ ok: true, action: 'send' }),
            isError: false,
          },
        ],
      }),
    );
    expect(result.result).toBe('Message sent.');
  });

  test('surfaces the failure when the send failed and the model went silent', () => {
    const failed = makeResult({
      result: silentToken,
      toolsUsed: ['message'],
      toolExecutions: [
        {
          name: 'message',
          arguments: '{"action":"send","to":"+491234567890","content":"hi"}',
          result: 'Error: WhatsApp is not linked.',
          isError: true,
        },
      ],
    });
    expect(hasMessageSendToolExecution(failed)).toBe(false);
    const result = normalizeSilentMessageSendReply(failed);
    expect(result.result).not.toBe('Message sent.');
    expect(result.result).toContain('message failed');
    expect(result.result).toContain('WhatsApp is not linked');
  });

  test('treats ok:false send results as failures', () => {
    const failed = makeResult({
      result: silentToken,
      toolsUsed: ['message'],
      toolExecutions: [
        {
          name: 'message',
          arguments: '{"action":"send","to":"+491234567890","content":"hi"}',
          result: JSON.stringify({ ok: false, error: 'rate limited' }),
          isError: false,
        },
      ],
    });
    expect(hasMessageSendToolExecution(failed)).toBe(false);
    expect(normalizeSilentMessageSendReply(failed).result).not.toBe(
      'Message sent.',
    );
  });
});

describe('normalizePendingApprovalReply', () => {
  test('replaces raw approval prose with a compact approval summary', () => {
    const result = makeResult({
      result:
        'I need your approval before I run script `bash skills/apple-music/scripts/play-url.sh "https://music.apple.com/us/artist/phil-collins/127837"`.',
      toolsUsed: ['bash'],
      pendingApproval: {
        approvalId: '24959489',
        prompt:
          'I need your approval before I run script `bash skills/apple-music/scripts/play-url.sh "https://music.apple.com/us/artist/phil-collins/127837"`.\nWhy: script execution is treated as high risk\nApproval ID: 24959489',
        intent:
          'run script `bash skills/apple-music/scripts/play-url.sh "https://music.apple.com/us/artist/phil-collins/127837"`',
        reason: 'script execution is treated as high risk',
        allowSession: true,
        allowAgent: true,
        expiresAt: null,
      },
    });

    expect(normalizePendingApprovalReply(result)).toMatchObject({
      result:
        'Approval needed for: run script `bash skills/apple-music/scripts/play-url.sh "https://music.apple.com/us/artist/phil-collins/127837"`\nWhy: script execution is treated as high risk\nApproval ID: 24959489',
    });
  });
});
