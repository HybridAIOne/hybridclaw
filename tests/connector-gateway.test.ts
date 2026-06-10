import { describe, expect, test } from 'vitest';

import {
  CONNECTOR_GATEWAY_SERVER_NAME,
  injectHybridAIConnectorGateway,
} from '../src/config/connector-gateway.ts';
import type { McpServerConfig } from '../src/types/models.ts';

const BASE = 'https://hybridai.one';
const KEY = 'hai-secret-key';

describe('injectHybridAIConnectorGateway', () => {
  test('injects the connector gateway when base URL and key are present', () => {
    const result = injectHybridAIConnectorGateway({}, BASE, KEY);
    expect(result[CONNECTOR_GATEWAY_SERVER_NAME]).toEqual({
      transport: 'http',
      url: 'https://hybridai.one/connectors/mcp',
      headers: { Authorization: `Bearer ${KEY}` },
      enabled: true,
    });
  });

  test('strips trailing slashes from the base URL and trims the key', () => {
    const result = injectHybridAIConnectorGateway(
      {},
      'https://hybridai.one///',
      '  hai-spaced  ',
    );
    const entry = result[CONNECTOR_GATEWAY_SERVER_NAME];
    expect(entry?.url).toBe('https://hybridai.one/connectors/mcp');
    expect(entry?.headers).toEqual({ Authorization: 'Bearer hai-spaced' });
  });

  test('does not inject when the API key is missing or blank', () => {
    expect(injectHybridAIConnectorGateway({}, BASE, '')).toEqual({});
    expect(injectHybridAIConnectorGateway({}, BASE, '   ')).toEqual({});
  });

  test('does not inject when the base URL is missing or blank', () => {
    expect(injectHybridAIConnectorGateway({}, '', KEY)).toEqual({});
    expect(injectHybridAIConnectorGateway({}, '   ', KEY)).toEqual({});
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
