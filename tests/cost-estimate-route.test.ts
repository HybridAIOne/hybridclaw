import { describe, expect, test } from 'vitest';
import {
  costEstimateText,
  runCostEstimateToolAction,
} from '../src/gateway/cost-estimate.js';

describe('estimate_cost on the gateway', () => {
  test('tells the agent the figures and to wait for the user', () => {
    const text = costEstimateText({
      low: 0.3,
      high: 0.82,
      free: false,
      requests: 20,
    });
    expect(text).toContain('€0.30–€0.82, about 20 model requests');
    expect(text).toContain('wait for their answer');
    expect(
      costEstimateText({ low: 0, high: 0, free: true, requests: 12 }),
    ).toContain('free model, so no charge');
  });

  test('refuses a number of steps it cannot use', async () => {
    for (const steps of [0, 1.5, 501, 'many']) {
      await expect(
        runCostEstimateToolAction({ steps, sessionId: 'any' }),
      ).rejects.toThrow('Give `steps`');
    }
  });
});
