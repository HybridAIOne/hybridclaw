import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import {
  baseRequest,
  firstInput,
  RUNNER_MODES,
  useRunnerModes,
} from './helpers/worker-runner-modes.js';

const startRunner = useRunnerModes('hybridclaw-host-runner-spawn-');
const host = RUNNER_MODES.find((mode) => mode.mode === 'host')!;

const spawnEnv = (call: { 2?: { env?: NodeJS.ProcessEnv } } | undefined) =>
  call?.[2]?.env;

test('hostRunner exposes the uploaded media cache root and the allowed roots to host agent processes', async () => {
  const { runner, workerCalls } = await startRunner(host);
  const { resolveUploadedMediaCacheHostDir } = await import(
    '../src/media/uploaded-media-cache.js'
  );

  await runner.exec({
    ...baseRequest,
    sessionId: 'session-uploaded-media-root',
    channelId: 'web',
  });

  const env = spawnEnv(workerCalls[0]);
  expect(env?.HYBRIDCLAW_AGENT_UPLOADED_MEDIA_ROOT).toBe(
    resolveUploadedMediaCacheHostDir(),
  );
  expect(JSON.parse(env?.HYBRIDCLAW_AGENT_ALLOWED_ROOTS || '[]')).toEqual(
    expect.arrayContaining([os.homedir(), process.cwd(), os.tmpdir()]),
  );
});

test('hostRunner strips ambient credentials from the host agent process env', async () => {
  const ambient = {
    OPENAI_API_KEY: 'openai-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret',
    AWS_ACCESS_KEY_ID: 'aws-access-key',
    AWS_SECRET_ACCESS_KEY: 'aws-secret-key',
    AWS_SESSION_TOKEN: 'aws-session-token',
    GITHUB_TOKEN: 'github-token',
    GH_TOKEN: 'gh-token',
    CUSTOM_SERVICE_API_KEY: 'custom-service-key',
    CUSTOM_PASSWORD: 'custom-password',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    BRAVE_API_KEY: 'brave-secret',
    PERPLEXITY_API_KEY: 'perplexity-secret',
    TAVILY_API_KEY: 'tavily-secret',
  };
  for (const [name, value] of Object.entries(ambient)) vi.stubEnv(name, value);
  vi.stubEnv('GATEWAY_API_TOKEN', 'gateway-secret');
  vi.stubEnv('HYBRIDCLAW_TEST_VISIBLE', 'visible');
  const { runner, workers, workerCalls } = await startRunner(host, {
    beforeLoad: (homeDir) => {
      fs.mkdirSync(path.join(homeDir, '.hybridclaw'), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, '.hybridclaw', 'config.json'),
        `${JSON.stringify({
          agents: {
            list: [
              {
                id: 'default',
                webSearch: {
                  searxngBaseUrl: 'https://search.default.example',
                  searxngBearerTokenRef: {
                    source: 'store',
                    id: 'DEFAULT_SEARXNG_BEARER_TOKEN',
                  },
                },
              },
            ],
          },
        })}\n`,
        'utf-8',
      );
    },
  });

  await runner.exec({
    ...baseRequest,
    sessionId: 'session-sanitized-env',
    channelId: 'web',
  });

  const env = spawnEnv(workerCalls[0]);
  const { deriveAgentRuntimeToken } = await import(
    '../src/security/agent-runtime-token.js'
  );
  expect(env?.HYBRIDCLAW_AGENT_SANDBOX_MODE).toBe('host');
  expect(env?.HYBRIDCLAW_GATEWAY_TOKEN).toBe(
    deriveAgentRuntimeToken('gateway-secret'),
  );
  expect(Object.values(env ?? {})).not.toContain('gateway-secret');
  expect(String(workers[0]?.stdin.write.mock.calls)).not.toContain(
    'gateway-secret',
  );
  expect(env?.HYBRIDCLAW_TEST_VISIBLE).toBe('visible');
  for (const name of Object.keys(ambient)) {
    expect(env?.[name], name).toBeUndefined();
  }

  expect(firstInput(workers[0]).webSearch).toMatchObject({
    searxngBaseUrl: 'https://search.default.example',
    searxngBearerTokenRef: {
      source: 'store',
      id: 'DEFAULT_SEARXNG_BEARER_TOKEN',
    },
    braveApiKey: 'brave-secret',
    perplexityApiKey: 'perplexity-secret',
    tavilyApiKey: 'tavily-secret',
  });
});

test.each(['nested', 'hoisted'] as const)('hostRunner exposes the %s agent-browser binary to host agent processes', async (layout) => {
  const { runner, workerCalls } = await startRunner(host);
  const { resolveInstallRoot } = await import('../src/infra/install-root.js');
  vi.stubEnv('AGENT_BROWSER_BIN', '');
  const binName =
    process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser';
  const nested = path.join(resolveInstallRoot(), 'container', 'node_modules', '.bin', binName);
  const hoisted = path.join(resolveInstallRoot(), 'node_modules', '.bin', binName);
  const expected = layout === 'nested' ? nested : hoisted;
  const exists = fs.existsSync;
  vi.spyOn(fs, 'existsSync').mockImplementation((file) => {
    if (file === nested || file === hoisted) return file === expected;
    return exists(file);
  });

  await runner.exec({
    ...baseRequest,
    sessionId: 'session-agent-browser-bin',
    channelId: 'web',
  });

  expect(spawnEnv(workerCalls[0])?.AGENT_BROWSER_BIN).toBe(expected);
});

test('hostRunner gives the stored runtime env at spawn and keeps the host NODE_PATH', async () => {
  const { runner, workers, workerCalls } = await startRunner(host);
  const { saveNamedRuntimeEnv } = await import('../src/config/runtime-env.js');
  saveNamedRuntimeEnv({
    EXAMPLE_REGION: 'region-a',
    NODE_PATH: '/opt/example/node_modules',
  });

  await runner.exec({ ...baseRequest, sessionId: 'session-stored-env' });

  const env = spawnEnv(workerCalls[0]);
  expect(env?.EXAMPLE_REGION).toBe('region-a');
  const nodePath = String(env?.NODE_PATH).split(path.delimiter);
  expect(nodePath.at(-1)).toBe('/opt/example/node_modules');
  expect(nodePath.length).toBeGreaterThan(1);
  // Re-applying the stored env in the worker would drop the host entries.
  expect(firstInput(workers[0])).not.toHaveProperty('runtimeEnv');
});

test('hostRunner links the install node_modules but leaves a real node_modules directory alone', async () => {
  const { runner } = await startRunner(host);
  const { resolveInstallRoot } = await import('../src/infra/install-root.js');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const linked = path.join(agentWorkspaceDir('default'), 'node_modules');
  const ownDir = path.join(agentWorkspaceDir('agent-b'), 'node_modules');
  fs.mkdirSync(ownDir, { recursive: true });
  fs.writeFileSync(path.join(ownDir, 'marker.txt'), 'installed by the agent');

  await runner.exec({ ...baseRequest, sessionId: 'session-link' });
  await runner.exec({
    ...baseRequest,
    sessionId: 'session-own-modules',
    agentId: 'agent-b',
  });

  expect(fs.readlinkSync(linked)).toBe(
    path.join(resolveInstallRoot(), 'node_modules'),
  );
  expect(fs.lstatSync(ownDir).isDirectory()).toBe(true);
  expect(fs.readFileSync(path.join(ownDir, 'marker.txt'), 'utf-8')).toBe(
    'installed by the agent',
  );
});
