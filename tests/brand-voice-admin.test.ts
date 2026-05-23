import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';

type ReloadResult = { ok: boolean; message: string };
type AuxiliaryResult = { content: string; model: string; provider: string };

async function importBrandVoiceAdmin(
  config: RuntimeConfig,
  options: {
    reloadResults?: ReloadResult[];
    auxiliaryResult?: AuxiliaryResult;
  } = {},
) {
  let currentConfig = structuredClone(config);
  const saveRuntimeConfig = vi.fn((next: RuntimeConfig) => {
    currentConfig = structuredClone(next);
    return structuredClone(next);
  });
  const reloadResults = [...(options.reloadResults ?? [])];
  const reloadPluginRuntime = vi.fn(
    async () =>
      reloadResults.shift() ??
      ({
        ok: true,
        message: 'Plugin runtime reloaded.',
      } satisfies ReloadResult),
  );
  const loggerWarn = vi.fn();
  const loggerError = vi.fn();
  const callAuxiliaryModel = vi.fn(
    async () =>
      options.auxiliaryResult ??
      ({
        content: '',
        model: 'test-aux-model',
        provider: 'hybridai',
      } satisfies AuxiliaryResult),
  );

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
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: loggerWarn,
      error: loggerError,
    },
  }));
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel,
  }));

  const mod = await import('../src/gateway/brand-voice-admin.ts');
  return {
    ...mod,
    getCurrentConfig: () => currentConfig,
    loggerError,
    loggerWarn,
    callAuxiliaryModel,
    reloadPluginRuntime,
    saveRuntimeConfig,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/config/runtime-config.js');
  vi.doUnmock('../src/config/runtime-config-revisions.js');
  vi.doUnmock('../src/gateway/gateway-plugin-service.js');
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/providers/auxiliary.js');
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
              classifier: { provider: 'rules' },
              voice: 'Plainspoken.',
              bannedPhrases: ['synergy'],
            },
          },
        ],
      },
    } as RuntimeConfig;
    const admin = await importBrandVoiceAdmin(config);

    expect(admin.getGatewayAdminBrandVoiceProfile()).toMatchObject({
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
          classifier: {
            provider: 'default',
          },
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
        classifier: {
          provider: 'default',
        },
      },
    });
    expect(admin.reloadPluginRuntime).toHaveBeenCalledTimes(1);
    expect(admin.getCurrentConfig().plugins.list[0]).toMatchObject({
      id: 'brand-voice',
      enabled: false,
      config: {
        voice: 'Direct.',
        doList: ['Use facts'],
        bannedPhrases: ['game changing'],
        classifier: {
          provider: 'default',
        },
      },
    });
  });

  test('scores pasted output against the edited profile', async () => {
    const admin = await importBrandVoiceAdmin({
      plugins: { list: [] },
    } as RuntimeConfig);

    const preview = await admin.previewGatewayAdminBrandVoiceProfile({
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
    });

    expect(preview).toMatchObject({
      score: 58,
      ruleScore: 58,
      scoreSource: 'rules',
      verdict: 'off_brand',
      violations: [
        { kind: 'banned_pattern', detail: '/\\bguarantee[sd]?\\b/i' },
        { kind: 'missing_required', detail: 'Best regards' },
      ],
      classifier: {
        provider: 'rules',
        status: 'rules_only',
        verdict: null,
      },
    });
    expect(preview).not.toHaveProperty('reasons');
  });

  test('uses the selected model runtime classifier during preview', async () => {
    const admin = await importBrandVoiceAdmin(
      {
        hybridai: { defaultModel: 'hybridai/default-chat' },
        plugins: {
          list: [
            {
              id: 'brand-voice',
              enabled: true,
              config: {
                classifier: {
                  provider: 'auxiliary',
                },
              },
            },
          ],
        },
      } as RuntimeConfig,
      {
        auxiliaryResult: {
          provider: 'hybridai',
          model: 'hybridai/aux-judge',
          content: JSON.stringify({
            verdict: 'off_brand',
            reasons: ['Too vague for the configured voice.'],
            severity: 'high',
          }),
        },
      },
    );

    const preview = await admin.previewGatewayAdminBrandVoiceProfile({
      sample: 'We might have a solution that can help.',
      profile: {
        enabled: true,
        mode: 'rewrite',
        voice: 'Direct and concrete.',
        doList: ['Use specific claims'],
        dontList: ['Use vague hedging'],
        bannedPhrases: [],
        bannedPatterns: [],
        requirePhrases: [],
        classifier: {
          provider: 'auxiliary',
        },
      },
    });

    expect(preview).toMatchObject({
      score: 0,
      ruleScore: 100,
      scoreSource: 'classifier',
      verdict: 'off_brand',
      classifier: {
        provider: 'auxiliary',
        status: 'evaluated',
        verdict: 'off_brand',
        severity: 'high',
        reasons: ['Too vague for the configured voice.'],
        model: 'hybridai/aux-judge',
      },
    });
    expect(admin.callAuxiliaryModel).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'skills_hub',
        fallbackModel: 'hybridai/default-chat',
        model: undefined,
      }),
    );
  });

  test('routes the default model classifier through the active default model', async () => {
    const admin = await importBrandVoiceAdmin(
      {
        hybridai: { defaultModel: 'hybridai/default-chat' },
        plugins: { list: [] },
      } as RuntimeConfig,
      {
        auxiliaryResult: {
          provider: 'hybridai',
          model: 'hybridai/default-chat',
          content: JSON.stringify({
            verdict: 'on_brand',
            reasons: [],
            severity: 'low',
          }),
        },
      },
    );

    await admin.previewGatewayAdminBrandVoiceProfile({
      sample: 'Concrete and plain.',
      profile: {
        enabled: true,
        mode: 'rewrite',
        voice: 'Concrete and plain.',
        doList: [],
        dontList: [],
        bannedPhrases: [],
        bannedPatterns: [],
        requirePhrases: [],
        classifier: {
          provider: 'default',
        },
      },
    });

    expect(admin.callAuxiliaryModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'auto',
        model: 'hybridai/default-chat',
        fallbackModel: 'hybridai/default-chat',
      }),
    );
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

  test('caps preview sample size and profile list lengths', async () => {
    const admin = await importBrandVoiceAdmin({
      plugins: { list: [] },
    } as RuntimeConfig);

    await expect(
      admin.previewGatewayAdminBrandVoiceProfile({
        sample: 'x'.repeat(50_001),
        profile: {
          enabled: true,
          mode: 'rewrite',
          voice: '',
          doList: [],
          dontList: [],
          bannedPhrases: [],
          bannedPatterns: [],
          requirePhrases: [],
        },
      }),
    ).rejects.toThrow('Sample output cannot exceed 50000 characters');

    await expect(
      admin.previewGatewayAdminBrandVoiceProfile({
        sample: 'Short sample',
        profile: {
          enabled: true,
          mode: 'rewrite',
          voice: '',
          doList: Array.from({ length: 201 }, (_, index) => `Rule ${index}`),
          dontList: [],
          bannedPhrases: [],
          bannedPatterns: [],
          requirePhrases: [],
        },
      }),
    ).rejects.toThrow('Do list cannot contain more than 200 entries');
  });

  test('rolls back failed runtime reloads and logs rollback reload failures', async () => {
    const admin = await importBrandVoiceAdmin(
      {
        plugins: {
          list: [
            {
              id: 'brand-voice',
              enabled: true,
              config: { voice: 'Original.' },
            },
          ],
        },
      } as RuntimeConfig,
      {
        reloadResults: [
          { ok: false, message: 'Plugin runtime reload failed.' },
          { ok: false, message: 'Rollback reload failed.' },
        ],
      },
    );

    await expect(
      admin.updateGatewayAdminBrandVoiceProfile({
        profile: {
          enabled: true,
          mode: 'rewrite',
          voice: 'Changed.',
          doList: [],
          dontList: [],
          bannedPhrases: [],
          bannedPatterns: [],
          requirePhrases: [],
        },
      }),
    ).rejects.toThrow('Plugin runtime reload failed.');

    expect(admin.saveRuntimeConfig).toHaveBeenCalledTimes(2);
    expect(admin.reloadPluginRuntime).toHaveBeenCalledTimes(2);
    expect(admin.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        reloadMessage: 'Plugin runtime reload failed.',
        rollbackReloadMessage: 'Rollback reload failed.',
      }),
      'Brand voice runtime rollback reload failed',
    );
    expect(admin.getCurrentConfig().plugins.list[0]).toMatchObject({
      id: 'brand-voice',
      config: { voice: 'Original.' },
    });
  });
});
