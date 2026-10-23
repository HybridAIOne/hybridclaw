import { beforeEach, describe, expect, test, vi } from 'vitest';
import { validateToolHistory } from '#shared/tool-history.js';
import {
  createPlaceholderMap,
  rehydrateConfidential,
} from '../src/security/confidential-redact.js';
import {
  sanitizeToolHistory,
  transformToolHistory,
} from '../src/session/tool-history.js';
import type { ChatMessage } from '../src/types/api.js';
import { useCleanMocks } from './test-utils.js';

function history(input: unknown, native: boolean): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: 'Calling tool',
      tool_calls: [
        {
          id: 'call-a',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify(input) },
        },
      ],
      ...(native
        ? {
            anthropic_content: [
              {
                type: 'thinking',
                thinking: 'opaque',
                signature: 'test-signature',
              },
              { type: 'redacted_thinking', data: 'opaque-data' },
              { type: 'text', text: 'Calling tool' },
              { type: 'tool_use', id: 'call-a', name: 'bash', input },
            ],
          }
        : {
            openai_response_items: [
              { type: 'reasoning', encrypted_content: 'opaque-data' },
            ],
          }),
    },
    { role: 'tool', tool_call_id: 'call-a', content: 'done' },
  ];
}

function expectInput(messages: ChatMessage[], expected: unknown) {
  expect(validateToolHistory(messages)).toEqual(messages);
  expect(
    JSON.parse(messages[0].tool_calls?.[0].function.arguments ?? ''),
  ).toEqual(expected);
  const block = messages[0].anthropic_content?.find(
    (block) => block.type === 'tool_use',
  );
  if (block) expect(block.input).toEqual(expected);
}

useCleanMocks({ unstubAllEnvs: true });
beforeEach(() => vi.stubEnv('HYBRIDCLAW_REDACT_SECRETS', 'true'));

describe.each([false, true])(
  'tool input transformation (native metadata: %s)',
  (native) => {
    test('redacts a quoted bearer header without corrupting JSON escaping', () => {
      const input = {
        command: 'curl -H "Authorization: Bearer test-key" https://example.com',
      };
      const original = history(input, native);
      const snapshot = structuredClone(original);
      const sanitized = sanitizeToolHistory(original);
      expectInput(sanitized, {
        command: 'curl -H "Authorization: Bearer ***" https://example.com',
      });
      expect(JSON.stringify(sanitized)).not.toContain('test-key');
      expect(original).toEqual(snapshot);
      expect(sanitized[0].anthropic_content?.slice(0, 2)).toEqual(
        original[0].anthropic_content?.slice(0, 2),
      );
      expect(sanitized[0].openai_response_items).toEqual(
        original[0].openai_response_items,
      );
    });

    test('redacts nested structured credentials while preserving other values', () => {
      const input = {
        nested: [{ api_key: 'test-key', password: 123456 }],
        count: 7,
        max_tokens: 128,
        token_count: 3,
        enabled: true,
        empty: null,
        contact: 'pat@example.com',
      };
      expectInput(sanitizeToolHistory(history(input, native)), {
        ...input,
        nested: [{ api_key: '***', password: '***' }],
      });
    });

    test.each([
      'a "quoted" value',
      'C:\\example\\report.txt',
      'first\nsecond\tline',
    ])('restores confidential value %j as data', (originalValue) => {
      const placeholder = '«CONF:CLIENT_001»';
      const mappings = createPlaceholderMap();
      mappings.byPlaceholder.set(placeholder, originalValue);
      const input = {
        nested: [placeholder, { value: placeholder }],
        count: 7,
        enabled: false,
        empty: null,
      };
      const original = history(input, native);
      const thinking = original[0].anthropic_content?.[0];
      if (thinking) {
        thinking.thinking = placeholder;
        thinking.signature = placeholder;
      }
      const redactedThinking = original[0].anthropic_content?.[1];
      if (redactedThinking) redactedThinking.data = placeholder;
      const reasoning = original[0].openai_response_items?.[0];
      if (reasoning) reasoning.encrypted_content = placeholder;
      const snapshot = structuredClone(original);
      const restored = transformToolHistory(original, (text) =>
        rehydrateConfidential(text, mappings),
      );
      expectInput(restored, {
        ...input,
        nested: [originalValue, { value: originalValue }],
      });
      expect(original).toEqual(snapshot);
      expect(restored[0].anthropic_content?.slice(0, 2)).toEqual(
        original[0].anthropic_content?.slice(0, 2),
      );
      expect(restored[0].openai_response_items).toEqual(
        original[0].openai_response_items,
      );
    });

    test('restores confidential values even when credential redaction is disabled', () => {
      vi.stubEnv('HYBRIDCLAW_REDACT_SECRETS', 'false');
      const mappings = createPlaceholderMap();
      mappings.byPlaceholder.set('«CONF:CLIENT_001»', 'a "quoted" value');
      const messages = history(
        { value: '«CONF:CLIENT_001»', api_key: 'test-key' },
        native,
      );
      expectInput(sanitizeToolHistory(messages), {
        value: '«CONF:CLIENT_001»',
        api_key: 'test-key',
      });
      expectInput(
        transformToolHistory(messages, (text) =>
          rehydrateConfidential(text, mappings),
        ),
        { value: 'a "quoted" value', api_key: 'test-key' },
      );
    });

    test('preserves special property names during redaction and restoration', () => {
      const input = JSON.parse(
        '{"__proto__":{"api_key":"test-key","value":"«CONF:CLIENT_001»"}}',
      );
      const sanitized = sanitizeToolHistory(history(input, native));
      expectInput(
        sanitized,
        JSON.parse(
          '{"__proto__":{"api_key":"***","value":"«CONF:CLIENT_001»"}}',
        ),
      );
      const mappings = createPlaceholderMap();
      mappings.byPlaceholder.set('«CONF:CLIENT_001»', 'a "quoted" value');
      expectInput(
        transformToolHistory(sanitized, (text) =>
          rehydrateConfidential(text, mappings),
        ),
        {
          ['__proto__']: { api_key: '***', value: 'a "quoted" value' },
        },
      );
    });

    test('restores confidential object keys with proper escaping', () => {
      const mappings = createPlaceholderMap();
      mappings.byPlaceholder.set('«CONF:CLIENT_001»', 'a "quoted" key');
      expectInput(
        transformToolHistory(
          history({ '«CONF:CLIENT_001»': 7 }, native),
          (text) => rehydrateConfidential(text, mappings),
        ),
        { 'a "quoted" key': 7 },
      );
    });
  },
);

test('retains malformed non-native tool arguments for replay and redacts their text', () => {
  const messages = history({}, false);
  const call = messages[0].tool_calls?.[0];
  if (!call) throw new Error('Missing fixture call');
  call.function.arguments = 'Authorization: Bearer test-key';
  const sanitized = sanitizeToolHistory(messages);
  expect(sanitized[0].tool_calls?.[0].function.arguments).toBe(
    'Authorization: Bearer ***',
  );
  expect(validateToolHistory(sanitized)).toEqual(sanitized);
});

test('does not swallow transformation failures', () => {
  expect(() =>
    transformToolHistory(
      history({}, true),
      (text) => text,
      () => {
        throw new Error('transform failed');
      },
    ),
  ).toThrow('transform failed');
});

test('rejects mismatched provider inputs before transforming them', () => {
  const messages = history({ command: 'echo safe' }, true);
  const block = messages[0].anthropic_content?.find(
    (block) => block.type === 'tool_use',
  );
  if (!block) throw new Error('Missing fixture block');
  block.input = { command: 'echo different' };
  expect(() => sanitizeToolHistory(messages)).toThrow(
    'Historical Anthropic tool metadata does not match its calls.',
  );
});
