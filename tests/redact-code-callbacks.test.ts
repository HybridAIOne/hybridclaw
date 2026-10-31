import { beforeEach, expect, test, vi } from 'vitest';
import { redactCredentialSecrets } from '../src/security/redact.js';
import { sanitizeToolHistory } from '../src/session/tool-history.js';
import type { ChatMessage } from '../src/types/api.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllEnvs: true });
beforeEach(() => vi.stubEnv('HYBRIDCLAW_REDACT_SECRETS', 'true'));

test.each([
  'items.sort(key=str.lower)\n',
  'ordered = sorted(records, key=lambda entry: entry.score)\n',
  'best = max(scores, key=scores.get)\n',
  "first = min(records, key=lambda entry: entry['rank'])\n",
  'ordered = sorted(fetch_records(), key=ranker.get)\n',
  'ordered = sorted(["(value)", "other"], key=str.lower)\n',
])(
  'preserves a non-secret Python sort callback in stored history: %s',
  (code) => {
    const history: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-a',
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({ path: 'example.py', contents: code }),
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-a', content: code },
    ];
    expect(redactCredentialSecrets(code)).not.toBe(code);
    const stored = sanitizeToolHistory(history);
    const input = JSON.parse(stored[0].tool_calls![0].function.arguments);
    expect(input.contents).toBe(code);
    expect(stored[1].content).toBe(code);
  },
);

test.each([
  ['KEY=ranker.get', 'ranker.get'],
  ['key=ranker.get', 'ranker.get'],
  ['Authorization: Bearer ranker.get', 'ranker.get'],
  ['https://example.com?key=ranker.get', 'ranker.get'],
  ['client.authenticate(key=ranker.get)', 'ranker.get'],
  ['sorted(records, key="ranker.get")', 'ranker.get'],
  ['max(records, key="test-key")', 'test-key'],
  ['max(records, KEY=ranker.get)', 'ranker.get'],
])('keeps credential redaction for %s', (input, value) => {
  expect(redactCredentialSecrets(input)).not.toContain(value);
  expect(redactCredentialSecrets(input, false, true)).not.toContain(value);
});

test('structured credential fields remain strict even when their values resemble code', () => {
  const history: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-a',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              headers: { Authorization: 'max(records, key=ranker.get)' },
              json: { apiKey: 'ranker.get' },
            }),
          },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call-a', content: 'Done.' },
  ];
  const stored = sanitizeToolHistory(history);
  expect(stored[0].tool_calls![0].function.arguments).not.toContain(
    'ranker.get',
  );
});

test.each([
  'max(records, key=callback_identifier_that_is_far_too_long.get)',
  'text; key=ranker.get',
  'max(records, key=lambda)',
])('uncertain callback syntax stays on the strict path: %s', (input) => {
  expect(redactCredentialSecrets(input, false, true)).not.toBe(input);
});

test('preserving a callback does not skip later credential matches', () => {
  const code =
    'ordered = sorted(records, key=lambda item: item.score)\nSERVICE_API_KEY="test-key"';
  const redacted = redactCredentialSecrets(code, false, true);
  expect(redacted).toContain('key=lambda item: item.score');
  expect(redacted).not.toContain('test-key');
});
