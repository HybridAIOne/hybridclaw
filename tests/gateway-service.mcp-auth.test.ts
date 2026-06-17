import { expect, test } from 'vitest';

import { parseMcpServerConfig } from '../src/gateway/gateway-service.js';

test('accepts oauth auth for remote transports and normalizes the transport', () => {
  const parsed = parseMcpServerConfig(
    JSON.stringify({
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      auth: 'oauth',
    }),
  );
  expect(parsed.error).toBeUndefined();
  expect(parsed.config?.transport).toBe('http');
  expect(parsed.config?.auth).toBe('oauth');
});

test('drops auth: none from the stored config', () => {
  const parsed = parseMcpServerConfig(
    JSON.stringify({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      auth: 'none',
    }),
  );
  expect(parsed.config?.auth).toBeUndefined();
});

test('rejects oauth auth for stdio servers', () => {
  const parsed = parseMcpServerConfig(
    JSON.stringify({ transport: 'stdio', command: 'echo', auth: 'oauth' }),
  );
  expect(parsed.error).toContain('OAuth is only supported');
});

test('rejects unknown auth values', () => {
  const parsed = parseMcpServerConfig(
    JSON.stringify({
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      auth: 'basic',
    }),
  );
  expect(parsed.error).toContain('`auth` must be `oauth`');
});
