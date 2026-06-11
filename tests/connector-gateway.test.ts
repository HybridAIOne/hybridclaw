import { describe, expect, test } from 'vitest';

import {
  CONNECTOR_GATEWAY_SERVER_NAME,
  injectHybridAIConnectorGateway,
  withConnectorGatewayAuth,
} from '../src/config/connector-gateway.ts';
import type { McpServerConfig } from '../src/types/models.ts';

const BASE = 'https://hybridai.one';
const KEY = 'hai-secret-key';
const GATEWAY_URL = 'https://hybridai.one/api/v1/connectors/mcp';

describe('injectHybridAIConnectorGateway', () => {
  test('injects the connector gateway without embedding the API key', () => {
    const result = injectHybridAIConnectorGateway({}, BASE, KEY);
    expect(result[CONNECTOR_GATEWAY_SERVER_NAME]).toEqual({
      transport: 'http',
      url: GATEWAY_URL,
      enabled: true,
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  test('strips trailing slashes from the base URL', () => {
    const result = injectHybridAIConnectorGateway(
      {},
      'https://hybridai.one///',
      KEY,
    );
    expect(result[CONNECTOR_GATEWAY_SERVER_NAME]?.url).toBe(GATEWAY_URL);
  });

  test('does not inject when the API key is missing or blank', () => {
    expect(injectHybridAIConnectorGateway({}, BASE, '')).toEqual({});
    expect(injectHybridAIConnectorGateway({}, BASE, '   ')).toEqual({});
  });

  test('does not inject when the base URL is missing or blank', () => {
    expect(injectHybridAIConnectorGateway({}, '', KEY)).toEqual({});
    expect(injectHybridAIConnectorGateway({}, '   ', KEY)).toEqual({});
  });

  test('does not inject when connectors are disabled', () => {
    expect(injectHybridAIConnectorGateway({}, BASE, KEY, false)).toEqual({});
  });

  test('injects when connectors are explicitly enabled', () => {
    const result = injectHybridAIConnectorGateway({}, BASE, KEY, true);
    expect(result[CONNECTOR_GATEWAY_SERVER_NAME]?.url).toBe(GATEWAY_URL);
  });

  test('a user-defined server of the same name always wins', () => {
    const existing: Record<string, McpServerConfig> = {
      [CONNECTOR_GATEWAY_SERVER_NAME]: {
        transport: 'http',
        url: 'https://example.test/custom',
        enabled: true,
      },
    };
    const result = injectHybridAIConnectorGateway(existing, BASE, KEY);
    expect(result[CONNECTOR_GATEWAY_SERVER_NAME]?.url).toBe(
      'https://example.test/custom',
    );
  });

  test('preserves other configured servers', () => {
    const existing: Record<string, McpServerConfig> = {
      other: { transport: 'stdio', command: 'node', enabled: true },
    };
    const result = injectHybridAIConnectorGateway(existing, BASE, KEY);
    expect(result.other).toEqual(existing.other);
    expect(result[CONNECTOR_GATEWAY_SERVER_NAME]).toBeDefined();
  });
});

describe('withConnectorGatewayAuth', () => {
  function injected(): Record<string, McpServerConfig> {
    return injectHybridAIConnectorGateway({}, BASE, KEY);
  }

  test('attaches the bearer to the injected entry without mutating the input', () => {
    const servers = injected();
    const result = withConnectorGatewayAuth(servers, BASE, KEY);
    expect(result[CONNECTOR_GATEWAY_SERVER_NAME]?.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
    });
    // The long-lived map stays credential-free.
    expect(servers[CONNECTOR_GATEWAY_SERVER_NAME]?.headers).toBeUndefined();
  });

  test('trims the key and tolerates trailing slashes on the base URL', () => {
    const result = withConnectorGatewayAuth(
      injected(),
      'https://hybridai.one///',
      '  hai-spaced  ',
    );
    expect(result[CONNECTOR_GATEWAY_SERVER_NAME]?.headers).toEqual({
      Authorization: 'Bearer hai-spaced',
    });
  });

  test('never attaches the key to an entry pointing at a foreign URL', () => {
    const servers: Record<string, McpServerConfig> = {
      [CONNECTOR_GATEWAY_SERVER_NAME]: {
        transport: 'http',
        url: 'https://evil.test/connectors/mcp',
        enabled: true,
      },
    };
    const result = withConnectorGatewayAuth(servers, BASE, KEY);
    expect(result[CONNECTOR_GATEWAY_SERVER_NAME]?.headers).toBeUndefined();
  });

  test('leaves a user-supplied Authorization header untouched', () => {
    const servers: Record<string, McpServerConfig> = {
      [CONNECTOR_GATEWAY_SERVER_NAME]: {
        transport: 'http',
        url: GATEWAY_URL,
        headers: { Authorization: 'Bearer user-token' },
        enabled: true,
      },
    };
    const result = withConnectorGatewayAuth(servers, BASE, KEY);
    expect(result[CONNECTOR_GATEWAY_SERVER_NAME]?.headers).toEqual({
      Authorization: 'Bearer user-token',
    });
  });

  test('is a no-op when the key or base URL is blank or the entry is absent', () => {
    expect(withConnectorGatewayAuth({}, BASE, KEY)).toEqual({});
    const servers = injected();
    expect(withConnectorGatewayAuth(servers, BASE, '')).toBe(servers);
    expect(withConnectorGatewayAuth(servers, '', KEY)).toBe(servers);
  });
});
