import { expect, test } from 'vitest';
import { resolvePublicGatewayBaseUrl } from '../src/gateway/gateway-url-utils.js';

const PUBLIC_URL = 'https://public.example.com';

test.each([
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
    case: 'local mode never reports a loopback base as public',
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    mode: 'local',
    publicUrl: PUBLIC_URL,
    expected: null,
  },
  {
    case: 'cloud mode without a public URL has none',
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    mode: 'cloud',
    publicUrl: '',
    expected: null,
  },
  {
    case: 'a non-HTTP public URL is ignored',
    gatewayBaseUrl: 'http://127.0.0.1:9090',
    mode: 'cloud',
    publicUrl: 'ftp://public.example.com',
    expected: null,
  },
  {
    case: 'a private public_url is not public',
    gatewayBaseUrl: '',
    mode: 'cloud',
    publicUrl: 'http://192.168.1.10:9090',
    expected: null,
  },
] as const)('$case', ({ gatewayBaseUrl, mode, publicUrl, expected }) => {
  expect(
    resolvePublicGatewayBaseUrl({
      ops: { gatewayBaseUrl },
      deployment: { mode, public_url: publicUrl },
    } as never),
  ).toBe(expected);
});
