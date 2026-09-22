import { afterEach, expect, test, vi } from 'vitest';
import {
  fetchHybridAIDestination,
  hybridAIDestinationHeaders,
  parseHybridAIDestination,
} from '../container/shared/hybridai-destination.js';

const destination = {
  protocol: 'hybridai-destination-v1',
  id: 'example-eu',
  zone: 'region',
  operator: 'Example operator',
  region: 'EU',
  retention: 'none',
  fallback: 'deny',
  apiBaseUrl: 'https://example.com',
};
afterEach(() => vi.unstubAllGlobals());
test('requires a complete contract for an explicitly advertised destination', () => {
  expect(parseHybridAIDestination(undefined, 'https://example.com')).toBeNull();
  expect(parseHybridAIDestination(destination, 'https://example.com')).toEqual(
    destination,
  );
  for (const change of [
    { region: 'US' },
    { fallback: 'allow' },
    { apiBaseUrl: 'https://other.example.com' },
    { operator: '' },
    { zone: 'local' },
  ]) {
    expect(() =>
      parseHybridAIDestination(
        { ...destination, ...change },
        'https://example.com',
      ),
    ).toThrow();
  }
});
test('sends the selected destination, disallows redirects and verifies server agreement', async () => {
  const headers = hybridAIDestinationHeaders(
    parseHybridAIDestination(destination, 'https://example.com'),
  );
  const fetch = vi.fn(async () => new Response('{}', { headers }));
  vi.stubGlobal('fetch', fetch);
  await expect(
    fetchHybridAIDestination('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers,
    }, headers),
  ).resolves.toBeInstanceOf(Response);
  expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
});
test.each([
  'X-HybridAI-Destination-ID',
  'X-HybridAI-Destination-Zone',
  'X-HybridAI-Destination-Fallback',
  'X-HybridAI-Destination-Protocol',
])('rejects a missing or changed %s acknowledgement', async (name) => {
  const headers = hybridAIDestinationHeaders(
    parseHybridAIDestination(destination, 'https://example.com'),
  );
  const reply = new Headers(headers);
  reply.set(name, 'different');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { headers: reply })),
  );
  await expect(
    fetchHybridAIDestination('https://example.com/v1/chat/completions', {
      headers,
    }, headers),
  ).rejects.toThrow('did not acknowledge');
});

test.each([
  'X-HybridAI-Destination-ID', 'X-HybridAI-Destination-Zone',
  'X-HybridAI-Destination-Fallback', 'X-HybridAI-Destination-Protocol', 'all',
])('rejects dropped request contract %s before any network call', async (name) => {
  const expected = hybridAIDestinationHeaders(parseHybridAIDestination(destination, 'https://example.com'));
  const headers = new Headers(expected);
  if (name === 'all') for (const key of Object.keys(expected)) headers.delete(key);
  else headers.delete(name);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(fetchHybridAIDestination('https://example.com/v1/chat/completions', { headers }, expected)).rejects.toThrow('request contract');
  expect(fetch).not.toHaveBeenCalled();
});

test('allows ordinary offers only when no destination contract is expected or attached', async () => {
  const fetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  await expect(fetchHybridAIDestination('https://example.com/v1/chat/completions', {}, undefined)).resolves.toBeInstanceOf(Response);
  await expect(fetchHybridAIDestination('https://example.com/v1/chat/completions', { headers: { 'X-HybridAI-Destination-Zone': 'region' } }, undefined)).rejects.toThrow('request contract');
  expect(fetch).toHaveBeenCalledOnce();
});
