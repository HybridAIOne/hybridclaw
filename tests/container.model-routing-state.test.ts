import { afterEach, describe, expect, test } from 'vitest';

import {
  clearModelRoutingStateForTests,
  createPrimaryModelRoutingSession,
} from '../container/src/model-routing.js';
import { ProviderRequestError } from '../container/src/providers/shared.js';

afterEach(() => {
  clearModelRoutingStateForTests();
});

describe('container primary model routing session', () => {
  test('prefers the least-used credential when a fresh session is created', () => {
    const firstSession = createPrimaryModelRoutingSession({
      sessionId: 'session-1',
      messages: [],
      chatbotId: 'bot_123',
      enableRag: false,
      apiKey: 'fallback-key',
      baseUrl: 'https://hybridai.one',
      provider: 'hybridai',
      requestHeaders: {},
      model: 'gpt-5-nano',
      channelId: 'channel-1',
      modelRouting: {
        routes: [
          {
            provider: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'or-active',
            model: 'openrouter/openai/gpt-5',
            chatbotId: '',
            enableRag: false,
            credentialPool: {
              rotation: 'least_used',
              entries: [
                {
                  id: 'pool-a',
                  label: 'primary',
                  apiKey: 'or-active',
                },
                {
                  id: 'pool-b',
                  label: 'secondary',
                  apiKey: 'or-secondary',
                },
              ],
            },
          },
        ],
      },
    });

    expect(firstSession.current()).toMatchObject({
      credentialId: 'pool-a',
      credentialLabel: 'primary',
      apiKey: 'or-active',
    });

    firstSession.noteSuccess();

    const secondSession = createPrimaryModelRoutingSession({
      sessionId: 'session-2',
      messages: [],
      chatbotId: 'bot_123',
      enableRag: false,
      apiKey: 'fallback-key',
      baseUrl: 'https://hybridai.one',
      provider: 'hybridai',
      requestHeaders: {},
      model: 'gpt-5-nano',
      channelId: 'channel-1',
      modelRouting: {
        routes: [
          {
            provider: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'or-active',
            model: 'openrouter/openai/gpt-5',
            chatbotId: '',
            enableRag: false,
            credentialPool: {
              rotation: 'least_used',
              entries: [
                {
                  id: 'pool-a',
                  label: 'primary',
                  apiKey: 'or-active',
                },
                {
                  id: 'pool-b',
                  label: 'secondary',
                  apiKey: 'or-secondary',
                },
              ],
            },
          },
        ],
      },
    });

    expect(secondSession.current()).toMatchObject({
      credentialId: 'pool-b',
      credentialLabel: 'secondary',
      apiKey: 'or-secondary',
    });
  });

  test('rotates credentials on authentication failures before failing over providers', () => {
    const session = createPrimaryModelRoutingSession({
      sessionId: 'session-1',
      messages: [],
      chatbotId: 'bot_123',
      enableRag: false,
      apiKey: 'fallback-key',
      baseUrl: 'https://hybridai.one',
      provider: 'hybridai',
      requestHeaders: {},
      model: 'gpt-5-nano',
      channelId: 'channel-1',
      modelRouting: {
        routes: [
          {
            provider: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'or-active',
            model: 'openrouter/openai/gpt-5',
            chatbotId: '',
            enableRag: false,
            credentialPool: {
              rotation: 'least_used',
              entries: [
                {
                  id: 'pool-a',
                  label: 'primary',
                  apiKey: 'or-active',
                },
                {
                  id: 'pool-b',
                  label: 'secondary',
                  apiKey: 'or-secondary',
                },
              ],
            },
          },
          {
            provider: 'mistral',
            baseUrl: 'https://api.mistral.ai/v1',
            apiKey: 'mistral-key',
            model: 'mistral/mistral-large-latest',
            chatbotId: '',
            enableRag: false,
          },
        ],
      },
    });

    expect(
      session.recover(new ProviderRequestError(401, '{"error":"unauthorized"}'), {
        canRetrySameRoute: true,
      }),
    ).toEqual({
      type: 'route_changed',
      reason: 'credential_auth',
    });
    expect(session.current()).toMatchObject({
      provider: 'openrouter',
      credentialId: 'pool-b',
      apiKey: 'or-secondary',
    });
  });

  test('downgrades the context tier on 429 before trying pool rotation or failover', () => {
    const session = createPrimaryModelRoutingSession({
      sessionId: 'session-1',
      messages: [],
      chatbotId: 'bot_123',
      enableRag: false,
      apiKey: 'fallback-key',
      baseUrl: 'https://hybridai.one',
      provider: 'hybridai',
      requestHeaders: {},
      model: 'gpt-5-nano',
      channelId: 'channel-1',
      contextWindow: 512_000,
      modelRouting: {
        routes: [
          {
            provider: 'hybridai',
            baseUrl: 'https://hybridai.one',
            apiKey: 'hai-active',
            model: 'gpt-5-nano',
            chatbotId: 'bot_123',
            enableRag: false,
            contextWindow: 512_000,
          },
        ],
        adaptiveContextTierDowngradeOn429: true,
      },
    });

    expect(
      session.recover(new ProviderRequestError(429, '{"error":"rate_limited"}'), {
        canRetrySameRoute: true,
      }),
    ).toEqual({
      type: 'context_downgraded',
      reason: 'rate_limit',
      previousContextWindow: 512_000,
      nextContextWindow: 256_000,
    });
    expect(session.current().contextWindow).toBe(256_000);
  });

  test('fails over to the next provider after rate-limit retry and pool exhaustion', () => {
    const session = createPrimaryModelRoutingSession({
      sessionId: 'session-1',
      messages: [],
      chatbotId: 'bot_123',
      enableRag: false,
      apiKey: 'fallback-key',
      baseUrl: 'https://hybridai.one',
      provider: 'hybridai',
      requestHeaders: {},
      model: 'gpt-5-nano',
      channelId: 'channel-1',
      contextWindow: 4096,
      modelRouting: {
        routes: [
          {
            provider: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'or-active',
            model: 'openrouter/openai/gpt-5',
            chatbotId: '',
            enableRag: false,
            contextWindow: 4096,
            credentialPool: {
              rotation: 'least_used',
              entries: [
                {
                  id: 'pool-a',
                  label: 'primary',
                  apiKey: 'or-active',
                },
              ],
            },
          },
          {
            provider: 'mistral',
            baseUrl: 'https://api.mistral.ai/v1',
            apiKey: 'mistral-key',
            model: 'mistral/mistral-large-latest',
            chatbotId: '',
            enableRag: false,
          },
        ],
        adaptiveContextTierDowngradeOn429: true,
      },
    });

    expect(
      session.recover(new ProviderRequestError(429, '{"error":"rate_limited"}'), {
        canRetrySameRoute: true,
      }),
    ).toEqual({
      type: 'none',
      reason: 'rate_limit_retry',
    });
    expect(session.current()).toMatchObject({
      provider: 'openrouter',
      model: 'openrouter/openai/gpt-5',
    });

    expect(
      session.recover(new ProviderRequestError(429, '{"error":"rate_limited"}'), {
        canRetrySameRoute: false,
      }),
    ).toEqual({
      type: 'route_changed',
      reason: 'provider_rate_limit',
    });
    expect(session.current()).toMatchObject({
      provider: 'mistral',
      model: 'mistral/mistral-large-latest',
      apiKey: 'mistral-key',
    });
  });
});
