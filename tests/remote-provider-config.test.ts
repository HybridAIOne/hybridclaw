import { expect, test, vi } from 'vitest';
import { OPENAI_COMPAT_REMOTE_PROVIDER_IDS } from '@hybridclaw/contracts/provider-ids';
import {
  DEFAULT_REMOTE_PROVIDER_CONFIG,
  normalizeRemoteProviderConfigs,
} from '../src/config/remote-provider-config.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ restoreAllMocks: true });

test.each(OPENAI_COMPAT_REMOTE_PROVIDER_IDS)(
  '%s retains scalar and model-list normalization',
  (id) => {
    const defaults = DEFAULT_REMOTE_PROVIDER_CONFIG;
    const result = normalizeRemoteProviderConfigs(
      {
        [id]: {
          enabled: 'true',
          baseUrl: ' https://example.com/api/// ',
          models: ' example/model-a, example/model-b ',
        },
      },
      defaults,
    );
    expect(result[id]).toEqual({
      enabled: true,
      baseUrl: 'https://example.com/api',
      models: ['example/model-a', 'example/model-b'],
    });
    expect(
      normalizeRemoteProviderConfigs(
        { [id]: { enabled: 'invalid', baseUrl: '', models: [] } },
        defaults,
      )[id],
    ).toEqual(defaults[id]);
  },
);

test('unconfigured remote providers stay disabled and unknown sections are excluded', () => {
  const result = normalizeRemoteProviderConfigs(
    { unknown: { enabled: true } },
    DEFAULT_REMOTE_PROVIDER_CONFIG,
  );
  expect(Object.keys(result)).toEqual([...OPENAI_COMPAT_REMOTE_PROVIDER_IDS]);
  expect(
    Object.values(result).every((section) => section.enabled === false),
  ).toBe(true);
});

test.each([
  ['kilo', 'https://api.kilocode.ai/v1'],
  ['kimi', 'https://api.kimi.com/coding/v1'],
] as const)('preserves the existing %s endpoint migration', (id, retired) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const result = normalizeRemoteProviderConfigs(
    { [id]: { baseUrl: retired } },
    DEFAULT_REMOTE_PROVIDER_CONFIG,
  );
  expect(result[id].baseUrl).toBe(DEFAULT_REMOTE_PROVIDER_CONFIG[id].baseUrl);
  expect(warn).toHaveBeenCalledOnce();
});
