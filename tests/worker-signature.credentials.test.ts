import { expect, test } from 'vitest';
import {
  computeWorkerSignature,
  type WorkerSignatureInput,
} from '../src/infra/worker-signature.js';
const base = {
  agentId: 'main',
  provider: 'hybridai',
  baseUrl: 'https://example.com',
  apiKey: 'test-key',
  requestHeaders: {},
};
test.each(['gatewayApiToken', 'webSearch'] as const)(
  'worker identity changes with %s',
  (field) => {
    const first = {
      ...base,
      gatewayApiToken: 'test-old',
      webSearch: {
        provider: 'brave',
        fallbackProviders: [],
        defaultCount: 5,
        cacheTtlMinutes: 5,
        searxngBaseUrl: '',
        tavilySearchDepth: 'basic',
        braveApiKey: 'test-old',
      },
    } as WorkerSignatureInput;
    const second = {
      ...first,
      [field]:
        field === 'gatewayApiToken'
          ? 'test-new'
          : { ...first.webSearch, braveApiKey: 'test-new' },
    };
    expect(computeWorkerSignature(first)).not.toBe(
      computeWorkerSignature(second),
    );
  },
);
