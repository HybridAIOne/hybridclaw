import { describe, expect, it, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ resetModules: true, unmock: ['../src/config/config.js'] });

const PUBLIC_URL = 'https://public.example.com';

async function loadTwilioManager(params: {
  gatewayBaseUrl: string;
  mode: 'local' | 'cloud';
  publicUrl: string;
}) {
  vi.doMock('../src/config/config.js', () => ({
    GATEWAY_BASE_URL: params.gatewayBaseUrl,
    getConfigSnapshot: () => ({
      deployment: { mode: params.mode, public_url: params.publicUrl },
      voice: { webhookPath: '/voice' },
    }),
  }));
  return import('../src/channels/voice/twilio-manager.js');
}

describe('resolvePublicBaseUrl', () => {
  it.each([
    {
      case: 'a public ops.gatewayBaseUrl wins over deployment.public_url',
      gatewayBaseUrl: 'https://gateway.example.com/',
      mode: 'cloud',
      publicUrl: PUBLIC_URL,
      expected: 'https://gateway.example.com',
    },
    {
      case: 'cloud mode replaces the loopback default',
      gatewayBaseUrl: 'http://127.0.0.1:9090',
      mode: 'cloud',
      publicUrl: `${PUBLIC_URL}/`,
      expected: PUBLIC_URL,
    },
    {
      case: 'cloud mode replaces a private-network base',
      gatewayBaseUrl: 'http://10.0.0.5:9090',
      mode: 'cloud',
      publicUrl: PUBLIC_URL,
      expected: PUBLIC_URL,
    },
    {
      case: 'cloud mode fills an unset base',
      gatewayBaseUrl: '',
      mode: 'cloud',
      publicUrl: PUBLIC_URL,
      expected: PUBLIC_URL,
    },
    {
      case: 'local mode keeps the loopback base',
      gatewayBaseUrl: 'http://127.0.0.1:9090',
      mode: 'local',
      publicUrl: PUBLIC_URL,
      expected: 'http://127.0.0.1:9090',
    },
    {
      case: 'cloud mode without a public URL keeps the loopback base',
      gatewayBaseUrl: 'http://127.0.0.1:9090',
      mode: 'cloud',
      publicUrl: '',
      expected: 'http://127.0.0.1:9090',
    },
    {
      case: 'a non-HTTP public URL is ignored',
      gatewayBaseUrl: 'http://127.0.0.1:9090',
      mode: 'cloud',
      publicUrl: 'ftp://public.example.com',
      expected: 'http://127.0.0.1:9090',
    },
    {
      case: 'no configured base falls back to forwarded request headers',
      gatewayBaseUrl: '',
      mode: 'local',
      publicUrl: '',
      expected: 'https://forwarded.example.com',
    },
  ] as const)('$case', async ({ expected, ...config }) => {
    const { resolvePublicBaseUrl } = await loadTwilioManager(config);
    const req = {
      headers: {
        host: '127.0.0.1:9090',
        'x-forwarded-host': 'forwarded.example.com',
        'x-forwarded-proto': 'https',
      },
    };

    expect(resolvePublicBaseUrl(req as never)).toBe(expected);
  });
});

describe('resolveVoiceCallWebhookUrl', () => {
  it.each([
    {
      case: 'uses deployment.public_url in cloud mode',
      gatewayBaseUrl: 'http://127.0.0.1:9090',
      mode: 'cloud',
      expected: { url: `${PUBLIC_URL}/telephony/webhook` },
    },
    {
      case: 'refuses a loopback base in local mode',
      gatewayBaseUrl: 'http://127.0.0.1:9090',
      mode: 'local',
      expected: { error: expect.stringContaining('deployment.public_url') },
    },
    {
      case: 'refuses a private-network base',
      gatewayBaseUrl: 'http://192.168.1.10:9090',
      mode: 'local',
      expected: { error: expect.stringContaining('private-network') },
    },
    {
      case: 'refuses a non-HTTP base',
      gatewayBaseUrl: 'ftp://gateway.example.com',
      mode: 'local',
      expected: { error: expect.stringContaining('`http` or `https`') },
    },
  ] as const)('$case', async ({ expected, ...config }) => {
    const { resolveVoiceCallWebhookUrl } = await loadTwilioManager({
      ...config,
      publicUrl: PUBLIC_URL,
    });

    expect(resolveVoiceCallWebhookUrl('/telephony')).toEqual(expected);
  });
});
