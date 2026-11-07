import { afterEach, expect, test } from 'vitest';
import { guardCommand } from '../container/src/bash-safety.js';
import { configureSafetyRules } from '../container/src/safety-rules.js';

afterEach(() => configureSafetyRules(undefined));

test.each([
  { disabled: [], expected: ['eval', 'source-script'] },
  { disabled: ['eval'], expected: ['source-script'] },
  { disabled: ['source-script'], expected: ['eval'] },
  { disabled: ['eval', 'source-script'], expected: [] },
])('reports every enabled blocker with $disabled disabled', ({ disabled, expected }) => {
  configureSafetyRules(disabled);
  const result = guardCommand('eval "printf marker"; source ./setup.sh');
  const ids = [...(result ?? '').matchAll(/Blocked by safety rule ([\w-]+):/g)]
    .map((match) => match[1]);
  expect(ids).toEqual(expected);
  expect(result === null).toBe(expected.length === 0);
});

test('reports each matching rule once even when a command repeats a blocked operation', () => {
  const result = guardCommand('eval "printf first"; eval "printf second"; source ./setup.sh');
  expect([...(result ?? '').matchAll(/Blocked by safety rule ([\w-]+):/g)]
    .map((match) => match[1])).toEqual(['eval', 'source-script']);
});

test('unblocked commands still have no denial', () => {
  expect(guardCommand('printf marker')).toBeNull();
});
