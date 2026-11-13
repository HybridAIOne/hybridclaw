import { expect, test } from 'vitest';
import { localOutputRecoveryPrompt } from '../container/src/local-output-recovery.js';

const exhausted = { isLocal: true, finishReason: 'length', toolCallCount: 0, recoveryCount: 0 };
test('only a local no-call truncation with remaining budget receives recovery', () => {
  expect(localOutputRecoveryPrompt(exhausted)).toBeTypeOf('string');
  for (const change of [
    { isLocal: false }, { finishReason: 'stop' }, { finishReason: undefined },
    { toolCallCount: 1 }, { recoveryCount: 1 }, { recoveryCount: 2 },
  ]) {
    expect(localOutputRecoveryPrompt({ ...exhausted, ...change })).toBeNull();
  }
});
