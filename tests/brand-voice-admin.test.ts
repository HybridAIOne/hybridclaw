import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';

async function importBrandVoiceAdmin(config: RuntimeConfig) {
  let currentConfig = structuredClone(config);
  const saveRuntimeConfig = vi.fn((next: RuntimeConfig) => {
    currentConfig = structuredClone(next);
    return structuredClone(next);
  });
  const reloadPluginRuntime = vi.fn(async () => ({
    ok: true,
    message: 'Plugin runtime reloaded.',
  }));

  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => structuredClone(currentConfig),
    runtimeConfigPath: () => '/tmp/hybridclaw/config.json',
    saveRuntimeConfig,
  }));
  vi.doMock('../src/config/runtime-config-revisions.js', () => ({
    listRuntimeConfigRevisions: () => [
      {
        id: 7,
        createdAt: '2026-05-21T10:00:00.000Z',
        actor: 'operator',
        route: 'api.admin.brand-voice.profile',
        source: 'admin-console',
        md5: 'abc123',
        byteLength: 120,
        assetType: 'config',
        replacedByMd5: null,
      },
      {
        id: 6,
        createdAt: '2026-05-21T09:00:00.000Z',
        actor: 'operator',
        route: 'api.admin.config',
        source: 'admin-console',
        md5: 'def456',
        byteLength: 100,
        assetType: 'config',
        replacedByMd5: null,
      },
    ],
  }));
  vi.doMock('../src/gateway/gateway-plugin-service.js', () => ({
    reloadPluginRuntime,
  }));

  const mod = await import('../src/gateway/brand-voice-admin.ts');
  return { ...mod, getCurrentConfig: () => currentConfig, reloadPluginRuntime };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/runtime-config.js');
  vi.doUnmock('../src/config/runtime-config-revisions.js');
  vi.doUnmock('../src/gateway/gateway-plugin-service.js');
  vi.resetModules();
});

describe('brand voice admin API helpers', () => {
  test('reads and updates the brand-voice profile in runtime plugin config', async () => {
    const config = {
      plugins: {
        list: [
          {
            id: 'brand-voice',
            enabled: true,
            config: {
              classifier: { provider: 'none' },
              voice: 'Plainspoken.',
              bannedPhrases: ['synergy'],
            },
          },
        ],
      },
    } as RuntimeConfig;
    const admin = await importBrandVoiceAdmin(config);

    expect(admin.getGatewayAdminBrandVoiceProfile()).toMatchObject({
      configPath: '/tmp/hybridclaw/config.json',
      profile: {
        enabled: true,
        mode: 'rewrite',
        voice: 'Plainspoken.',
        bannedPhrases: ['synergy'],
      },
      revisions: [{ id: 7 }],
    });

    await expect(
      admin.updateGatewayAdminBrandVoiceProfile({
        profile: {
          enabled: false,
          mode: 'block',
          voice: 'Direct.',
          doList: ['Use facts'],
          dontList: ['Use hype'],
          bannedPhrases: ['game changing'],
          bannedPatterns: ['/\\bguarantee[sd]?\\b/i'],
          requirePhrases: ['Best regards'],
        },
      }),
    ).resolves.toMatchObject({
      changed: true,
      reloadMessage: 'Plugin runtime reloaded.',
      profile: {
        enabled: false,
        mode: 'block',
        voice: 'Direct.',
        doList: ['Use facts'],
      },
    });
    expect(admin.reloadPluginRuntime).toHaveBeenCalledTimes(1);
    expect(admin.getCurrentConfig().plugins.list[0]).toMatchObject({
      id: 'brand-voice',
      enabled: false,
      config: {
        classifier: { provider: 'none' },
        voice: 'Direct.',
        doList: ['Use facts'],
        bannedPhrases: ['game changing'],
      },
    });
  });

  test('scores pasted output against the edited profile', async () => {
    const admin = await importBrandVoiceAdmin({
      plugins: { list: [] },
    } as RuntimeConfig);

    expect(
      admin.previewGatewayAdminBrandVoiceProfile({
        sample: 'This is game changing and guaranteed.',
        profile: {
          enabled: true,
          mode: 'rewrite',
          voice: '',
          doList: [],
          dontList: ['game changing'],
          bannedPhrases: [],
          bannedPatterns: ['/\\bguarantee[sd]?\\b/i'],
          requirePhrases: ['Best regards'],
        },
      }),
    ).toMatchObject({
      score: 58,
      verdict: 'off_brand',
      violations: [
        { kind: 'banned_pattern', detail: '/\\bguarantee[sd]?\\b/i' },
        { kind: 'missing_required', detail: 'Best regards' },
      ],
    });
  });

  test('rejects invalid banned regex patterns', async () => {
    const admin = await importBrandVoiceAdmin({
      plugins: { list: [] },
    } as RuntimeConfig);

    await expect(
      admin.updateGatewayAdminBrandVoiceProfile({
        profile: {
          enabled: true,
          mode: 'rewrite',
          voice: '',
          doList: [],
          dontList: [],
          bannedPhrases: [],
          bannedPatterns: ['/[unterminated/'],
          requirePhrases: [],
        },
      }),
    ).rejects.toThrow('Invalid banned pattern');
  });
});
