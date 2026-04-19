import { afterEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_HYBRIDAI_API_KEYS = process.env.HYBRIDAI_API_KEYS;
const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_OPENROUTER_API_KEYS = process.env.OPENROUTER_API_KEYS;
const ORIGINAL_OPENROUTER_API_KEY_2 = process.env.OPENROUTER_API_KEY_2;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function importFreshModelRouting(params?: {
  runtimeConfig?: {
    hybridai?: { defaultModel?: string };
    routing?: {
      primaryModel?: {
        fallbackModels?: string[];
        adaptiveContextTierDowngradeOn429?: boolean;
      };
    };
  };
  storedSecrets?: Record<string, string>;
  resolveModelRuntimeCredentials?: ReturnType<typeof vi.fn>;
}) {
  vi.resetModules();

  class MissingRequiredEnvVarError extends Error {
    envVar: string;

    constructor(envVar: string) {
      super(`Missing required env var: ${envVar}`);
      this.name = 'MissingRequiredEnvVarError';
      this.envVar = envVar;
    }
  }

  const loggerWarn = vi.fn();
  const resolveModelRuntimeCredentials =
    params?.resolveModelRuntimeCredentials ??
    vi.fn(async ({ model }: { model: string }) => ({
      provider: 'hybridai',
      apiKey: 'hai-key',
      baseUrl: 'https://hybridai.one',
      requestHeaders: {},
      model,
      chatbotId: 'bot_123',
      enableRag: false,
      maxTokens: 4321,
    }));
  const resolveProviderRequestMaxTokens = vi.fn(
    ({
      discoveredMaxTokens,
    }: {
      model: string;
      discoveredMaxTokens?: number;
    }) => discoveredMaxTokens,
  );

  vi.doMock('../src/config/config.js', () => ({
    MissingRequiredEnvVarError,
  }));
  vi.doMock('../src/config/runtime-config.js', () => ({
    getRuntimeConfig: () => ({
      hybridai: {
        defaultModel: 'gpt-5-nano',
        ...(params?.runtimeConfig?.hybridai || {}),
      },
      routing: {
        primaryModel: {
          fallbackModels: [],
          adaptiveContextTierDowngradeOn429: true,
          ...(params?.runtimeConfig?.routing?.primaryModel || {}),
        },
      },
    }),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: loggerWarn,
    },
  }));
  vi.doMock('../src/security/runtime-secrets.js', () => ({
    readStoredRuntimeSecrets: () => params?.storedSecrets || {},
  }));
  vi.doMock('../src/providers/request-max-tokens.js', () => ({
    resolveProviderRequestMaxTokens,
  }));
  vi.doMock('../src/providers/factory.js', () => ({
    resolveModelRuntimeCredentials,
  }));

  const modelRouting = await import('../src/providers/model-routing.ts');
  return {
    ...modelRouting,
    MissingRequiredEnvVarError,
    loggerWarn,
    resolveModelRuntimeCredentials,
    resolveProviderRequestMaxTokens,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/config/runtime-config.js');
  vi.doUnmock('../src/logger.js');
  vi.doUnmock('../src/security/runtime-secrets.js');
  vi.doUnmock('../src/providers/request-max-tokens.js');
  vi.doUnmock('../src/providers/factory.js');
  vi.resetModules();
  restoreEnvVar('HYBRIDAI_API_KEYS', ORIGINAL_HYBRIDAI_API_KEYS);
  restoreEnvVar('OPENROUTER_API_KEY', ORIGINAL_OPENROUTER_API_KEY);
  restoreEnvVar('OPENROUTER_API_KEYS', ORIGINAL_OPENROUTER_API_KEYS);
  restoreEnvVar('OPENROUTER_API_KEY_2', ORIGINAL_OPENROUTER_API_KEY_2);
});

describe('provider model routing', () => {
  test('discovers pooled provider credentials from env and stored secrets', async () => {
    process.env.OPENROUTER_API_KEY = 'or-active';
    process.env.OPENROUTER_API_KEYS = 'or-active, or-pooled-a';
    process.env.OPENROUTER_API_KEY_2 = 'or-pooled-b';
    const { resolveProviderCredentialPool } = await importFreshModelRouting({
      storedSecrets: {
        OPENROUTER_API_KEY_3: 'or-pooled-c',
      },
    });

    expect(
      resolveProviderCredentialPool('openrouter', 'or-active'),
    ).toMatchObject({
      rotation: 'least_used',
      entries: [
        {
          label: 'active',
          apiKey: 'or-active',
        },
        {
          label: 'OPENROUTER_API_KEYS[2]',
          apiKey: 'or-pooled-a',
        },
        {
          label: 'OPENROUTER_API_KEY_2',
          apiKey: 'or-pooled-b',
        },
        {
          label: 'OPENROUTER_API_KEY_3',
          apiKey: 'or-pooled-c',
        },
      ],
    });
  });

  test('builds an ordered primary-model route plan and skips unresolved fallbacks', async () => {
    process.env.HYBRIDAI_API_KEYS = 'hai-pooled-a, hai-pooled-b';
    process.env.OPENROUTER_API_KEYS = 'or-pooled-a, or-pooled-b';
    const {
      MissingRequiredEnvVarError,
      loggerWarn,
      resolveModelRuntimeCredentials,
      resolvePrimaryModelRoutingPlan,
    } = await importFreshModelRouting({
      runtimeConfig: {
        routing: {
          primaryModel: {
            fallbackModels: [
              'openrouter/anthropic/claude-sonnet-4',
              'mistral/mistral-large-latest',
            ],
            adaptiveContextTierDowngradeOn429: false,
          },
        },
      },
      resolveModelRuntimeCredentials: vi.fn(
        async ({ model }: { model: string }) => {
          if (model === 'gpt-5-nano') {
            return {
              provider: 'hybridai',
              apiKey: 'hai-active',
              baseUrl: 'https://hybridai.one',
              requestHeaders: {},
              chatbotId: 'bot_123',
              enableRag: false,
              contextWindow: 1_000_000,
              maxTokens: 8192,
            };
          }
          if (model === 'openrouter/anthropic/claude-sonnet-4') {
            return {
              provider: 'openrouter',
              apiKey: 'or-active',
              baseUrl: 'https://openrouter.ai/api/v1',
              requestHeaders: {
                'HTTP-Referer': 'https://example.com',
              },
              chatbotId: '',
              enableRag: false,
              contextWindow: 256_000,
              maxTokens: 4096,
            };
          }
          throw new MissingRequiredEnvVarError('MISTRAL_API_KEY');
        },
      ),
    });

    const plan = await resolvePrimaryModelRoutingPlan({
      model: 'gpt-5-nano',
      chatbotId: 'bot_123',
      enableRag: false,
      agentId: 'main',
    });

    expect(resolveModelRuntimeCredentials).toHaveBeenCalledTimes(3);
    expect(plan.adaptiveContextTierDowngradeOn429).toBe(false);
    expect(plan.routes.map((route) => route.model)).toEqual([
      'gpt-5-nano',
      'openrouter/anthropic/claude-sonnet-4',
    ]);
    expect(plan.routes[0]).toMatchObject({
      provider: 'hybridai',
      apiKey: 'hai-active',
      credentialPool: {
        rotation: 'least_used',
        entries: [
          {
            label: 'active',
            apiKey: 'hai-active',
          },
          {
            label: 'HYBRIDAI_API_KEYS[1]',
            apiKey: 'hai-pooled-a',
          },
          {
            label: 'HYBRIDAI_API_KEYS[2]',
            apiKey: 'hai-pooled-b',
          },
        ],
      },
    });
    expect(plan.routes[1]).toMatchObject({
      provider: 'openrouter',
      apiKey: 'or-active',
      credentialPool: {
        rotation: 'least_used',
        entries: [
          {
            label: 'active',
            apiKey: 'or-active',
          },
          {
            label: 'OPENROUTER_API_KEYS[1]',
            apiKey: 'or-pooled-a',
          },
          {
            label: 'OPENROUTER_API_KEYS[2]',
            apiKey: 'or-pooled-b',
          },
        ],
      },
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'mistral/mistral-large-latest',
        error: 'Missing required env var: MISTRAL_API_KEY',
      }),
      'Skipping primary-model fallback route because credentials are unavailable',
    );
  });
});
