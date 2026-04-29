import { expect, test, vi } from 'vitest';
import { createWarmSessionId } from '../src/infra/warm-runner-utils.js';

test('creates warm session IDs with sanitized agents and crypto entropy', () => {
  const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

  const first = createWarmSessionId('agent/a:b');
  const second = createWarmSessionId('agent/a:b');
  nowSpy.mockRestore();

  expect(first).toMatch(/^warm_agent_a_b_1700000000000_[0-9a-f]{12}$/);
  expect(second).toMatch(/^warm_agent_a_b_1700000000000_[0-9a-f]{12}$/);
  expect(first).not.toBe(second);
});
