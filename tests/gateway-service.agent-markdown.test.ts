import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-agent-markdown-',
});

test('saves and reloads allowlisted agent workspace markdown files', async () => {
  setupHome();

  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const {
    getGatewayAdminAgentMarkdownFile,
    getGatewayAdminAgentMarkdownRevision,
    restoreGatewayAdminAgentMarkdownRevision,
    saveGatewayAdminAgentMarkdownFile,
  } = await import('../src/gateway/gateway-service.ts');

  const initial = saveGatewayAdminAgentMarkdownFile({
    agentId: 'main',
    fileName: 'AGENTS.md',
    content: '# AGENTS.md\n\n- Keep responses concise.\n',
  });
  expect(initial.file.revisions).toEqual([]);

  const updated = saveGatewayAdminAgentMarkdownFile({
    agentId: 'main',
    fileName: 'AGENTS.md',
    content: '# AGENTS.md\n\n- Prefer concise answers.\n',
  });

  const filePath = path.join(agentWorkspaceDir('main'), 'AGENTS.md');
  expect(fs.readFileSync(filePath, 'utf-8')).toBe(
    '# AGENTS.md\n\n- Prefer concise answers.\n',
  );
  expect(updated.file.path).toBe(filePath);
  expect(updated.file.exists).toBe(true);
  expect(updated.file.revisions).toHaveLength(1);
  expect(updated.file.revisions[0]?.source).toBe('save');

  const loaded = getGatewayAdminAgentMarkdownFile('main', 'AGENTS.md');
  expect(loaded.file.content).toBe(
    '# AGENTS.md\n\n- Prefer concise answers.\n',
  );
  expect(loaded.file.revisions).toHaveLength(1);

  const revisionId = loaded.file.revisions[0]?.id;
  if (!revisionId) {
    throw new Error('Expected a saved markdown revision.');
  }

  const revision = getGatewayAdminAgentMarkdownRevision({
    agentId: 'main',
    fileName: 'AGENTS.md',
    revisionId,
  });
  expect(revision.revision.content).toBe(
    '# AGENTS.md\n\n- Keep responses concise.\n',
  );

  const restored = restoreGatewayAdminAgentMarkdownRevision({
    agentId: 'main',
    fileName: 'AGENTS.md',
    revisionId,
  });
  expect(restored.file.content).toBe(
    '# AGENTS.md\n\n- Keep responses concise.\n',
  );
  expect(restored.file.revisions.length).toBeGreaterThanOrEqual(2);
  expect(restored.file.revisions[0]?.source).toBe('restore');
});

test('rejects non-allowlisted agent workspace markdown file names', async () => {
  setupHome();

  const { saveGatewayAdminAgentMarkdownFile } = await import(
    '../src/gateway/gateway-service.ts'
  );

  expect(() =>
    saveGatewayAdminAgentMarkdownFile({
      agentId: 'main',
      fileName: 'notes.md',
      content: '# notes\n',
    }),
  ).toThrow('Unsupported markdown file "notes.md"');
});

test('rejects oversized multibyte markdown saves before mutating the workspace file', async () => {
  setupHome();

  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { saveGatewayAdminAgentMarkdownFile } = await import(
    '../src/gateway/gateway-service.ts'
  );

  saveGatewayAdminAgentMarkdownFile({
    agentId: 'main',
    fileName: 'AGENTS.md',
    content: '# AGENTS.md\n\n- Keep responses concise.\n',
  });

  const oversizedContent = '🙂'.repeat(60_000);
  expect(() =>
    saveGatewayAdminAgentMarkdownFile({
      agentId: 'main',
      fileName: 'AGENTS.md',
      content: oversizedContent,
    }),
  ).toThrow('Markdown content exceeds the 200000-byte admin editor limit.');

  expect(
    fs.readFileSync(path.join(agentWorkspaceDir('main'), 'AGENTS.md'), 'utf-8'),
  ).toBe('# AGENTS.md\n\n- Keep responses concise.\n');
});

test('rejects oversized revision restores before mutating the workspace file', async () => {
  setupHome();

  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const {
    restoreGatewayAdminAgentMarkdownRevision,
    saveGatewayAdminAgentMarkdownFile,
  } = await import('../src/gateway/gateway-service.ts');

  saveGatewayAdminAgentMarkdownFile({
    agentId: 'main',
    fileName: 'AGENTS.md',
    content: '# AGENTS.md\n\n- Keep responses concise.\n',
  });

  const workspacePath = agentWorkspaceDir('main');
  const revisionDir = path.join(
    path.dirname(workspacePath),
    'markdown-revisions',
    'AGENTS.md',
  );
  fs.mkdirSync(revisionDir, { recursive: true });
  fs.writeFileSync(
    path.join(revisionDir, 'oversized.json'),
    JSON.stringify({
      id: 'oversized',
      fileName: 'AGENTS.md',
      createdAt: '2026-04-13T12:00:00.000Z',
      sizeBytes: Buffer.byteLength('🙂'.repeat(60_000), 'utf-8'),
      sha256: 'deadbeef',
      source: 'save',
      content: '🙂'.repeat(60_000),
    }),
    'utf-8',
  );

  expect(() =>
    restoreGatewayAdminAgentMarkdownRevision({
      agentId: 'main',
      fileName: 'AGENTS.md',
      revisionId: 'oversized',
    }),
  ).toThrow('Markdown content exceeds the 200000-byte admin editor limit.');

  expect(fs.readFileSync(path.join(workspacePath, 'AGENTS.md'), 'utf-8')).toBe(
    '# AGENTS.md\n\n- Keep responses concise.\n',
  );
});
