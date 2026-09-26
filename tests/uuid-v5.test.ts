import { describe, expect, it } from 'vitest';

import { uuidV5 } from '../src/utils/uuid-v5.js';

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const TEAMS_NAMESPACE = '9aeaf9e5-ffb9-47c0-8f2f-a496047e1a26';

describe('uuidV5', () => {
  // Expected values were produced by the `uuid` package's v5(), which this
  // helper replaces; Teams manifest IDs must not change across the swap.
  it.each([
    ['www.example.com', DNS_NAMESPACE, '2ed6657d-e927-568b-95e1-2665a8aea6a2'],
    ['python.org', DNS_NAMESPACE, '886313e1-3b8a-5372-9b90-0c9aee199e5d'],
    [
      'https://example.com:teams-org-app',
      TEAMS_NAMESPACE,
      '79ca0811-5f6a-52ca-bd73-beb126d93e15',
    ],
    ['pub_123', TEAMS_NAMESPACE, '20a27d1a-24ee-5067-8263-dde242934417'],
    ['', TEAMS_NAMESPACE, '674c2853-1eef-5a3f-8885-453b2ed77d17'],
    ['ünïcødé ✓', TEAMS_NAMESPACE, 'd8047406-fc14-5d50-9fc4-5add19bf4bc8'],
  ])('matches the uuid package for %j', (name, namespace, expected) => {
    expect(uuidV5(name, namespace)).toBe(expected);
  });

  it('accepts an upper-case namespace', () => {
    expect(uuidV5('python.org', DNS_NAMESPACE.toUpperCase())).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    );
  });

  it.each(['', 'not-a-uuid', '6ba7b810-9dad-11d1-80b4-00c04fd430c'])(
    'rejects invalid namespace %j',
    (namespace) => {
      expect(() => uuidV5('x', namespace)).toThrow(/Invalid UUID namespace/);
    },
  );
});
