import { beforeEach, expect, test, vi } from 'vitest';
import { connectMlxModel, isMlxConnected } from '../src/inference/mlx-connection.js';

const mocks = vi.hoisted(() => ({ configure: vi.fn(), ensure: vi.fn(), config: vi.fn(), reload: vi.fn(), secrets: vi.fn(), credentials: vi.fn() }));
vi.mock('../src/config/runtime-config.js', () => ({ configureRuntimeLocalEndpoint: mocks.configure, ensureRuntimeConfigFile: mocks.ensure, getRuntimeConfig: mocks.config, reloadRuntimeConfig: mocks.reload }));
vi.mock('../src/security/runtime-secrets.js', () => ({ saveNamedRuntimeSecrets: mocks.secrets }));
vi.mock('../src/inference/mlx-runtime.js', () => ({ mlxHome: () => '/tmp/example-mlx', mlxCredentials: mocks.credentials }));
const endpoint = { name: 'mac-mlx', type: 'mlx', enabled: true, baseUrl: 'http://127.0.0.1:8321/v1', zone: 'local', apiKey: 'test-key' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockReturnValue({ local: { endpoints: [] } });
  mocks.reload.mockImplementation(() => mocks.config());
  mocks.credentials.mockReturnValue({ token: 'test-key', baseUrl: endpoint.baseUrl });
});

test.each([
  [], [endpoint], [{ ...endpoint, enabled: false }], [{ ...endpoint, apiKey: 'wrong-key' }],
  [{ ...endpoint, baseUrl: 'http://127.0.0.1:8322/v1' }], [{ ...endpoint, type: 'vllm' }],
  [{ ...endpoint, zone: 'cloud' }], [{ ...endpoint, name: 'another-endpoint' }],
].map((endpoints) => ({ endpoints })))('checks connection identity without writes: %j', ({ endpoints }) => {
  mocks.config.mockReturnValue({ local: { endpoints } });
  expect(isMlxConnected()).toBe(endpoints.length === 1 && endpoints[0] === endpoint);
  expect(mocks.ensure).not.toHaveBeenCalled();
  expect(mocks.configure).not.toHaveBeenCalled();
  expect(mocks.secrets).not.toHaveBeenCalled();
});

test('missing installation credentials are disconnected and cannot be registered', () => {
  mocks.credentials.mockImplementation(() => { throw new Error('No installation'); });
  expect(isMlxConnected()).toBe(false);
  expect(() => connectMlxModel({ route: 'console.local.start' })).toThrow();
  expect(mocks.secrets).not.toHaveBeenCalled();
  expect(mocks.configure).not.toHaveBeenCalled();
});

test('registers a missing endpoint using a stored reference without choosing a default', () => {
  connectMlxModel({ route: 'console.local.start' });
  expect(mocks.secrets).toHaveBeenCalledWith({ LOCAL_ENDPOINT_MAC_MLX_API_KEY: 'test-key' });
  expect(mocks.configure).toHaveBeenCalledWith(
    { name: 'mac-mlx', type: 'mlx', enabled: true, baseUrl: endpoint.baseUrl, zone: 'local' },
    { source: 'store', id: 'LOCAL_ENDPOINT_MAC_MLX_API_KEY' }, undefined,
    { route: 'console.local.start', source: 'user' },
  );
});

test('re-enables a disabled managed endpoint', () => {
  mocks.config.mockReturnValue({ local: { endpoints: [{ ...endpoint, enabled: false }] } });
  connectMlxModel({ route: 'cli.local.serve' });
  expect(mocks.configure).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }), expect.anything(), undefined, expect.anything());
});

test('does not rewrite a working connection', () => {
  mocks.config.mockReturnValue({ local: { endpoints: [endpoint] } });
  connectMlxModel({ route: 'cli.local.serve' });
  expect(mocks.configure).not.toHaveBeenCalled();
  expect(mocks.secrets).not.toHaveBeenCalled();
});

test('refuses a conflicting endpoint discovered by a fresh disk reload before storing credentials', () => {
  mocks.reload.mockReturnValue({ local: { endpoints: [{ ...endpoint, type: 'vllm' }] } });
  expect(() => connectMlxModel({ route: 'console.local.start' })).toThrow('another backend');
  expect(mocks.secrets).not.toHaveBeenCalled();
  expect(mocks.configure).not.toHaveBeenCalled();
});
