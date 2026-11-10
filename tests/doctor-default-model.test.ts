import { afterEach, expect, test, vi } from 'vitest';

import type { ModelLifecycle } from '../src/providers/model-status.js';

const state = vi.hoisted(() => ({
  config: { hybridai: { defaultModel: '' } },
  lifecycle: { status: 'current', replacement: null } as ModelLifecycle,
}));

vi.mock('../src/config/runtime-config.js', () => ({
  getRuntimeConfig: () => state.config,
  updateRuntimeConfig: (mutate: (draft: typeof state.config) => void) =>
    mutate(state.config),
}));
vi.mock('../src/providers/model-catalog.js', () => ({
  refreshAvailableModelCatalogs: vi.fn(async () => undefined),
  getModelLifecycle: () => state.lifecycle,
}));

const { checkDefaultModel } = await import(
  '../src/doctor/checks/default-model.js'
);

afterEach(() => {
  state.config.hybridai.defaultModel = '';
  state.lifecycle = { status: 'current', replacement: null };
});

test.each([
  {
    name: 'passes a current default',
    lifecycle: { status: 'current', replacement: null },
    severity: 'ok',
    fixable: false,
  },
  {
    name: 'warns about a legacy default without a named successor',
    lifecycle: { status: 'legacy', replacement: null },
    severity: 'warn',
    fixable: false,
  },
  {
    name: 'offers the named successor for a legacy default',
    lifecycle: { status: 'legacy', replacement: 'hybridai/model-b' },
    severity: 'warn',
    fixable: true,
  },
] as const)('$name', async ({ lifecycle, severity, fixable }) => {
  state.config.hybridai.defaultModel = 'hybridai/model-a';
  state.lifecycle = lifecycle;

  const [result] = await checkDefaultModel();

  expect(result.severity).toBe(severity);
  expect(Boolean(result.fix)).toBe(fixable);
});

test('switches to the successor and rolls back to the old default', async () => {
  state.config.hybridai.defaultModel = 'hybridai/model-a';
  state.lifecycle = { status: 'legacy', replacement: 'hybridai/model-b' };

  const [result] = await checkDefaultModel();
  await result.fix?.apply();
  expect(state.config.hybridai.defaultModel).toBe('hybridai/model-b');

  await result.fix?.rollback?.();
  expect(state.config.hybridai.defaultModel).toBe('hybridai/model-a');
});
