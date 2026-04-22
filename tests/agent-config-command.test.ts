import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-agent-config-command-',
});

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

test('agent config command accepts direct JSON and overwrites markdown files', async () => {
  setupHome();

  const { handleAgentPackageCommand } = await import(
    '../src/cli/agent-command.ts'
  );
  const { getAgentById } = await import('../src/agents/agent-registry.ts');
  const { getRuntimeConfig, runtimeConfigPath } = await import(
    '../src/config/runtime-config.ts'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await handleAgentPackageCommand([
    'config',
    JSON.stringify({
      id: 'felix',
      name: 'Felix',
      model: 'gpt-5.4-mini',
      chatbotId: 'bot-felix',
      enableRag: true,
      skills: ['memory', 'memory', 'docs'],
      markdown: {
        'IDENTITY.md': '# Felix\n',
        'BOOT.md': '# Boot\n',
      },
    }),
    '--activate',
  ]);

  const workspacePath = agentWorkspaceDir('felix');
  expect(getAgentById('felix')).toMatchObject({
    id: 'felix',
    name: 'Felix',
    model: 'gpt-5.4-mini',
    chatbotId: 'bot-felix',
    enableRag: true,
    skills: ['memory', 'docs'],
  });
  expect(
    fs.readFileSync(path.join(workspacePath, 'IDENTITY.md'), 'utf-8'),
  ).toBe('# Felix\n');
  expect(fs.readFileSync(path.join(workspacePath, 'BOOT.md'), 'utf-8')).toBe(
    '# Boot\n',
  );
  expect(getRuntimeConfig().agents.defaultAgentId).toBe('felix');
  expect(logSpy).toHaveBeenCalledWith('Configured agent felix.');
  expect(logSpy).toHaveBeenCalledWith(
    `Activated agent felix as the default at ${runtimeConfigPath()}.`,
  );

  logSpy.mockClear();
  await handleAgentPackageCommand([
    'config',
    JSON.stringify({ id: 'felix' }),
    '--activate',
  ]);
  expect(logSpy).toHaveBeenCalledWith('Configured agent felix.');
  expect(logSpy).not.toHaveBeenCalledWith(
    expect.stringContaining('Activated agent felix'),
  );

  await handleAgentPackageCommand([
    'config',
    '--json',
    JSON.stringify({
      id: 'felix',
      files: {
        'IDENTITY.md': '# Updated Felix\n',
      },
    }),
  ]);

  expect(getAgentById('felix')?.model).toBe('gpt-5.4-mini');
  expect(
    fs.readFileSync(path.join(workspacePath, 'IDENTITY.md'), 'utf-8'),
  ).toBe('# Updated Felix\n');
});

test('agent config command imports remote image assets into the workspace', async () => {
  setupHome();

  const { handleAgentPackageCommand } = await import(
    '../src/cli/agent-command.ts'
  );
  const { getAgentById } = await import('../src/agents/agent-registry.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const image = Buffer.from('test-image');
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? 'image/jpeg' : null,
    },
    arrayBuffer: async () => bufferToArrayBuffer(image),
  }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});

  await handleAgentPackageCommand([
    'config',
    JSON.stringify({
      id: 'stephan',
      name: 'Stephan',
      imageAsset: 'https://example.com/team/stephan-noller.jpg?size=512',
    }),
  ]);

  expect(fetchMock).toHaveBeenCalledWith(
    new URL('https://example.com/team/stephan-noller.jpg?size=512'),
  );
  expect(getAgentById('stephan')).toMatchObject({
    id: 'stephan',
    imageAsset: 'assets/stephan-noller.jpg',
  });
  expect(
    fs.readFileSync(
      path.join(agentWorkspaceDir('stephan'), 'assets', 'stephan-noller.jpg'),
    ),
  ).toEqual(image);
});

test('agent config command copies local image assets into the workspace', async () => {
  const homeDir = setupHome();

  const { handleAgentPackageCommand } = await import(
    '../src/cli/agent-command.ts'
  );
  const { getAgentById } = await import('../src/agents/agent-registry.ts');
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const image = Buffer.from('local-image');
  const sourcePath = path.join(homeDir, 'stephan.png');
  fs.writeFileSync(sourcePath, image);
  vi.spyOn(console, 'log').mockImplementation(() => {});

  await handleAgentPackageCommand([
    'config',
    JSON.stringify({
      id: 'stephan',
      name: 'Stephan',
      imageAsset: sourcePath,
    }),
  ]);

  expect(getAgentById('stephan')).toMatchObject({
    id: 'stephan',
    imageAsset: 'assets/stephan.png',
  });
  expect(
    fs.readFileSync(
      path.join(agentWorkspaceDir('stephan'), 'assets', 'stephan.png'),
    ),
  ).toEqual(image);
});

test('agent config command rejects invalid field types without clearing existing values', async () => {
  setupHome();

  const { handleAgentPackageCommand } = await import(
    '../src/cli/agent-command.ts'
  );
  const { getAgentById } = await import('../src/agents/agent-registry.ts');
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await handleAgentPackageCommand([
    'config',
    JSON.stringify({
      id: 'felix',
      name: 'Felix',
      enableRag: true,
    }),
  ]);

  await expect(
    handleAgentPackageCommand([
      'config',
      JSON.stringify({
        id: 'felix',
        name: 123,
      }),
    ]),
  ).rejects.toThrow('`name` must be a string or null.');
  expect(getAgentById('felix')).toMatchObject({
    id: 'felix',
    name: 'Felix',
    enableRag: true,
  });

  await expect(
    handleAgentPackageCommand([
      'config',
      JSON.stringify({
        id: 'felix',
        enableRag: 'true',
      }),
    ]),
  ).rejects.toThrow('`enableRag` must be a boolean or null.');
  expect(getAgentById('felix')).toMatchObject({
    id: 'felix',
    name: 'Felix',
    enableRag: true,
  });

  logSpy.mockRestore();
});

test('agent config command rejects duplicate JSON payload inputs', async () => {
  setupHome();

  const { handleAgentPackageCommand } = await import(
    '../src/cli/agent-command.ts'
  );

  await expect(
    handleAgentPackageCommand([
      'config',
      JSON.stringify({ id: 'felix' }),
      '--json',
      JSON.stringify({ id: 'felix' }),
    ]),
  ).rejects.toThrow(
    'Provide agent config JSON only once for `hybridclaw agent config`.',
  );
});

test('agent config command rejects markdown and files together before upserting', async () => {
  setupHome();

  const { handleAgentPackageCommand } = await import(
    '../src/cli/agent-command.ts'
  );
  const { getAgentById } = await import('../src/agents/agent-registry.ts');

  await expect(
    handleAgentPackageCommand([
      'config',
      JSON.stringify({
        id: 'felix',
        markdown: {
          'IDENTITY.md': '# Felix\n',
        },
        files: {
          'BOOT.md': '# Boot\n',
        },
      }),
    ]),
  ).rejects.toThrow('Provide either `markdown` or `files`, not both.');
  expect(getAgentById('felix')).toBeNull();
});

test('agent config command rejects nested markdown file paths before upserting', async () => {
  setupHome();

  const { handleAgentPackageCommand } = await import(
    '../src/cli/agent-command.ts'
  );
  const { getAgentById } = await import('../src/agents/agent-registry.ts');

  await expect(
    handleAgentPackageCommand([
      'config',
      JSON.stringify({
        id: 'felix',
        markdown: {
          'docs/IDENTITY.md': '# Felix\n',
        },
      }),
    ]),
  ).rejects.toThrow(
    'Unsupported markdown file "docs/IDENTITY.md". Use a top-level .md filename such as IDENTITY.md.',
  );
  expect(getAgentById('felix')).toBeNull();
});
