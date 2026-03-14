import { describe, expect, test } from 'vitest';
import { isLoopGuardedToolName } from '../container/src/tool-loop-detection.js';
import {
  getToolExecutionMode,
  mapConcurrentInOrder,
  takeCachedValue,
} from '../container/src/tool-parallelism.js';

describe('getToolExecutionMode', () => {
  test.each([
    ['read', '{"path":"src/index.ts"}'],
    ['glob', '{"pattern":"src/**/*.ts"}'],
    ['grep', '{"pattern":"TODO"}'],
    ['session_search', '{"query":"parallel tools"}'],
    ['vision_analyze', '{"image_url":"x.png","question":"what is this?"}'],
    ['image', '{"image_url":"x.png","question":"what is this?"}'],
    ['message', '{"action":"read","channelId":"123"}'],
    ['message', '{"action":"member-info","userId":"123","guildId":"456"}'],
    ['message', '{"action":"channel-info","channelId":"123"}'],
    ['message', '{"action":"send","content":"hi"}'],
    ['web_fetch', '{"url":"https://example.com"}'],
    ['web_search', '{"query":"hybridclaw"}'],
    ['write', '{"path":"x.txt","contents":"hello"}'],
    ['edit', '{"path":"x.txt","old":"a","new":"b"}'],
    ['bash', '{"command":"git status"}'],
    ['browser_navigate', '{"url":"https://example.com"}'],
    ['delegate', '{"prompt":"check the logs"}'],
  ])('defaults %s to the concurrent path when it is not explicitly never-parallel', (toolName, argsJson) => {
    expect(getToolExecutionMode(toolName, argsJson)).toBe('parallel');
  });

  test('keeps clarify on the sequential path', () => {
    expect(getToolExecutionMode('clarify', '{"question":"ok?"}')).toBe(
      'sequential',
    );
  });
});

describe('isLoopGuardedToolName', () => {
  test.each([
    'read',
    'glob',
    'grep',
    'bash',
  ])('marks %s as loop-guarded', (toolName) => {
    expect(isLoopGuardedToolName(toolName)).toBe(true);
  });

  test.each([
    'session_search',
    'vision_analyze',
    'message',
    'web_fetch',
  ])('does not mark %s as loop-guarded', (toolName) => {
    expect(isLoopGuardedToolName(toolName)).toBe(false);
  });
});

describe('mapConcurrentInOrder', () => {
  test('returns results in input order', async () => {
    const items = [30, 5, 15, 0];

    const results = await mapConcurrentInOrder(items, async (delayMs) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return `result-${delayMs}`;
    });

    expect(results).toEqual(['result-30', 'result-5', 'result-15', 'result-0']);
  });

  test('handles empty input', async () => {
    await expect(
      mapConcurrentInOrder([], async () => 'unused'),
    ).resolves.toEqual([]);
  });
});

describe('takeCachedValue', () => {
  test('returns and removes a cached value', () => {
    const cache = new Map<string, string>([['call-1', 'cached']]);

    expect(takeCachedValue(cache, 'call-1')).toBe('cached');
    expect(takeCachedValue(cache, 'call-1')).toBeNull();
    expect(cache.size).toBe(0);
  });

  test('returns null when no cached value exists', () => {
    expect(takeCachedValue(new Map<string, string>(), 'missing')).toBeNull();
  });
});
