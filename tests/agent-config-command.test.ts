import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-agent-config-command-',
});

test('agent config command accepts direct JSON and overwrites markdown files', async () => {
  setupHome();

  const { handleAgentPackageCommand } = await import(
    '../src/cli/agent-command.ts'
  );
  const { getAgentById } = await import('../src/agents/agent-registry.ts');
  const { getRuntimeConfig } = await import(
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
  expect(fs.readFileSync(path.join(workspacePath, 'IDENTITY.md'), 'utf-8')).toBe(
    '# Felix\n',
  );
  expect(fs.readFileSync(path.join(workspacePath, 'BOOT.md'), 'utf-8')).toBe(
    '# Boot\n',
  );
  expect(getRuntimeConfig().agents.defaultAgentId).toBe('felix');
  expect(logSpy).toHaveBeenCalledWith('Configured agent felix.');

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
  expect(fs.readFileSync(path.join(workspacePath, 'IDENTITY.md'), 'utf-8')).toBe(
    '# Updated Felix\n',
  );
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
