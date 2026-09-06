import { expect, test, vi } from 'vitest';
import { processSideEffects } from '../src/agent/side-effects.ts';

test('processSideEffects hands every delegation to the handler', () => {
  const onDelegation = vi.fn();

  processSideEffects(
    {
      status: 'success',
      result: 'ok',
      toolsUsed: [],
      sideEffects: {
        delegations: [
          { action: 'delegate', prompt: 'summarize inbox' },
          { action: 'delegate', mode: 'chain', chain: [{ prompt: 'a' }] },
        ],
      },
    },
    'session-1',
    'tui',
    { onDelegation },
  );

  expect(onDelegation).toHaveBeenCalledTimes(2);
  expect(onDelegation).toHaveBeenNthCalledWith(1, {
    action: 'delegate',
    prompt: 'summarize inbox',
  });
});

test('processSideEffects keeps processing after a handler throws', () => {
  const onDelegation = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('boom');
    })
    .mockImplementation(() => undefined);

  expect(() =>
    processSideEffects(
      {
        status: 'success',
        result: 'ok',
        toolsUsed: [],
        sideEffects: {
          delegations: [
            { action: 'delegate', prompt: 'first' },
            { action: 'delegate', prompt: 'second' },
          ],
        },
      },
      'session-1',
      'tui',
      { onDelegation },
    ),
  ).not.toThrow();

  expect(onDelegation).toHaveBeenCalledTimes(2);
});
