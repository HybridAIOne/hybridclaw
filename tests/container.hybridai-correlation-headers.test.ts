import { expect, test } from 'vitest';
import { withHybridAICorrelationHeaders } from '../container/src/providers/shared.js';

const BASE = { 'User-Agent': 'hybridclaw-test' };

test('hybridai calls carry session, run, agent, and channel correlation headers', () => {
  expect(
    withHybridAICorrelationHeaders({
      provider: 'hybridai',
      sessionId: 'discord:guild:1:channel:2',
      runId: 'turn_1725000000000_abcd1234',
      agentId: 'main',
      channelId: 'discord',
      requestHeaders: BASE,
    }),
  ).toEqual({
    'User-Agent': 'hybridclaw-test',
    'X-HybridClaw-Session-Id': 'discord:guild:1:channel:2',
    'X-HybridClaw-Run-Id': 'turn_1725000000000_abcd1234',
    'X-HybridClaw-Agent-Id': 'main',
    'X-HybridClaw-Channel-Id': 'discord',
  });
});

test('correlation headers are provider-scoped to hybridai', () => {
  expect(
    withHybridAICorrelationHeaders({
      provider: 'openai',
      sessionId: 'session-1',
      runId: 'turn_1',
      agentId: 'main',
      channelId: 'console',
      requestHeaders: BASE,
    }),
  ).toBe(BASE);
  expect(
    withHybridAICorrelationHeaders({
      provider: 'anthropic',
      sessionId: 'session-1',
    }),
  ).toBeUndefined();
});

test('missing or unsafe correlation values are omitted or sanitized', () => {
  expect(
    withHybridAICorrelationHeaders({
      provider: 'hybridai',
      sessionId: 'session-1',
      runId: undefined,
      agentId: '',
      channelId: 'bad\r\nX-Injected: 1',
      requestHeaders: BASE,
    }),
  ).toEqual({
    'User-Agent': 'hybridclaw-test',
    'X-HybridClaw-Session-Id': 'session-1',
    'X-HybridClaw-Channel-Id': 'badX-Injected: 1',
  });
});
