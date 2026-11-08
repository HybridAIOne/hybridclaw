import { expect, test, vi } from 'vitest';

vi.mock('../src/providers/model-catalog.js', () => ({
  getModelLifecycle: (model: string) =>
    model.includes('legacy')
      ? {
          status: 'legacy',
          replacement: model.endsWith('-a') ? 'hybridai/current-b' : null,
        }
      : { status: 'current', replacement: null },
  isAvailableModelFree: () => false,
}));

const { buildModelListResult } = await import(
  '../src/gateway/model-list-command.js'
);

const MODELS = [
  'hybridai/current-a',
  'hybridai/legacy-a',
  'hybridai/current-b',
  'hybridai/legacy-b',
];

test.each([
  {
    name: 'hides legacy models by default',
    includeLegacy: false,
    currentModel: 'hybridai/current-a',
    values: ['hybridai/current-a', 'hybridai/current-b'],
    footer: '2 models · 2 legacy hidden (`model list all`)',
  },
  {
    name: 'keeps a legacy session model visible',
    includeLegacy: false,
    currentModel: 'hybridai/legacy-b',
    values: ['hybridai/current-a', 'hybridai/current-b', 'hybridai/legacy-b'],
    footer: '3 models · 1 legacy hidden (`model list all`)',
  },
  {
    name: 'lists legacy models last when all are requested',
    includeLegacy: true,
    currentModel: 'hybridai/current-a',
    values: [
      'hybridai/current-a',
      'hybridai/current-b',
      'hybridai/legacy-a',
      'hybridai/legacy-b',
    ],
    footer: '4 models',
  },
])('$name', ({ includeLegacy, currentModel, values, footer }) => {
  const result = buildModelListResult({
    models: MODELS,
    currentModel,
    providerFilter: undefined,
    includeLegacy,
  });

  expect(result.modelCatalog?.map((entry) => entry.value)).toEqual(values);
  expect(result.text.split('\n').at(-1)).toBe(footer);
});

test('marks legacy entries and names their replacement', () => {
  const result = buildModelListResult({
    models: MODELS,
    currentModel: 'hybridai/current-a',
    providerFilter: 'hybridai',
    includeLegacy: true,
  });

  expect(
    result.modelCatalog?.find((entry) => entry.value === 'hybridai/legacy-a'),
  ).toMatchObject({
    legacy: true,
    label: 'hybridai/legacy-a (legacy, use hybridai/current-b)',
  });
  expect(result.title).toBe('Available Models (hybridai)');
});

test('lists legacy models when no current model is left to show', () => {
  const result = buildModelListResult({
    models: ['hybridai/legacy-a', 'hybridai/legacy-b'],
    currentModel: '',
    providerFilter: 'hybridai',
    includeLegacy: false,
  });

  expect(result.modelCatalog?.map((entry) => entry.value)).toEqual([
    'hybridai/legacy-a',
    'hybridai/legacy-b',
  ]);
  expect(result.text.split('\n').at(-1)).toBe('2 models');
});

test('points at the provider-scoped command when legacy models are hidden', () => {
  const result = buildModelListResult({
    models: ['hybridai/current-a', 'hybridai/legacy-a'],
    currentModel: '',
    providerFilter: 'hybridai',
    includeLegacy: false,
  });

  expect(result.text.split('\n').at(-1)).toBe(
    '1 model · 1 legacy hidden (`model list hybridai all`)',
  );
});
