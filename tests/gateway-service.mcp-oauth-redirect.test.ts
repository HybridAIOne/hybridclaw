import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-mcp-oauth-redirect-',
});

test('MCP OAuth redirect prefers deployment public URL over private admin request origin', async () => {
  setupHome();
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  updateRuntimeConfig((draft) => {
    draft.deployment.mode = 'cloud';
    draft.deployment.public_url = 'https://cloud.hybridclaw.example.com';
    draft.ops.gatewayBaseUrl = 'http://127.0.0.1:9090';
  });

  const { resolveMcpOAuthRedirectUri } = await import(
    '../src/gateway/gateway-service.ts'
  );

  expect(resolveMcpOAuthRedirectUri('http://172.19.0.21:9090')).toBe(
    'https://cloud.hybridclaw.example.com/api/mcp/oauth/callback',
  );
});

test('MCP OAuth redirect prefers public gateway base URL over private admin request origin', async () => {
  setupHome();
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  updateRuntimeConfig((draft) => {
    draft.deployment.public_url = '';
    draft.ops.gatewayBaseUrl = 'https://gateway.hybridclaw.example.com';
  });

  const { resolveMcpOAuthRedirectUri } = await import(
    '../src/gateway/gateway-service.ts'
  );

  expect(resolveMcpOAuthRedirectUri('http://172.19.0.21:9090')).toBe(
    'https://gateway.hybridclaw.example.com/api/mcp/oauth/callback',
  );
});

test('MCP OAuth redirect keeps public request origin when configured gateway base is local', async () => {
  setupHome();
  const { resolveMcpOAuthRedirectUri } = await import(
    '../src/gateway/gateway-service.ts'
  );

  expect(resolveMcpOAuthRedirectUri('https://admin.hybridclaw.example.com')).toBe(
    'https://admin.hybridclaw.example.com/api/mcp/oauth/callback',
  );
});

test('MCP OAuth redirect falls back to configured local base URL without request origin', async () => {
  setupHome();
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  updateRuntimeConfig((draft) => {
    draft.ops.gatewayBaseUrl = 'http://127.0.0.1:9090';
  });

  const { resolveMcpOAuthRedirectUri } = await import(
    '../src/gateway/gateway-service.ts'
  );

  expect(resolveMcpOAuthRedirectUri()).toBe(
    'http://127.0.0.1:9090/api/mcp/oauth/callback',
  );
});
