import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-agent-markdown-defaults-',
});

test('returns shipped defaults without changing workspace content and preserves revisions when saved', async () => {
  setupHome();
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const {
    WORKSPACE_BOOTSTRAP_FILES,
    WORKSPACE_TEMPLATES_DIR,
  } = await import('../src/workspace-templates.js');
  const {
    getGatewayAdminAgentMarkdownFile,
    getGatewayAdminAgentMarkdownRevision,
    saveGatewayAdminAgentMarkdownFile,
  } = await import('../src/gateway/gateway-service.js');

  for (const fileName of WORKSPACE_BOOTSTRAP_FILES) {
    const customContent = `# Customized ${fileName}\n`;
    saveGatewayAdminAgentMarkdownFile({
      agentId: 'main',
      fileName,
      content: customContent,
    });
    const loaded = getGatewayAdminAgentMarkdownFile('main', fileName);
    expect(loaded.file.defaultContent).toBe(
      fs.readFileSync(path.join(WORKSPACE_TEMPLATES_DIR, fileName), 'utf-8'),
    );
    expect(
      fs.readFileSync(path.join(agentWorkspaceDir('main'), fileName), 'utf-8'),
    ).toBe(customContent);
    expect(loaded.file.revisions).toEqual([]);
    if (loaded.file.defaultContent == null) {
      throw new Error(`Missing default for ${fileName}`);
    }

    const saved = saveGatewayAdminAgentMarkdownFile({
      agentId: 'main',
      fileName,
      content: loaded.file.defaultContent,
    });
    expect(saved.file.content).toBe(loaded.file.defaultContent);
    expect(saved.file.revisions).toHaveLength(1);
    expect(
      getGatewayAdminAgentMarkdownRevision({
        agentId: 'main',
        fileName,
        revisionId: saved.file.revisions[0]?.id || '',
      }).revision.content,
    ).toBe(customContent);
  }
});

test('has no default for custom or read-only memory files and rejects unsupported paths', async () => {
  setupHome();
  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { readWorkspaceTemplate } = await import('../src/workspace-templates.js');
  const { getGatewayAdminAgentMarkdownFile } = await import(
    '../src/gateway/gateway-service.js'
  );
  const memoryDir = path.join(agentWorkspaceDir('main'), 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, '2026-10-02.md'), '# Daily memory');
  for (const fileName of [
    'CV.md',
    'memory/2026-10-02.md',
    'Instance Memory.md',
    'Organization Memory.md',
  ]) {
    expect(
      getGatewayAdminAgentMarkdownFile('main', fileName).file.defaultContent,
    ).toBeNull();
  }
  for (const fileName of ['../AGENTS.md', '/AGENTS.md', 'notes.md']) {
    expect(readWorkspaceTemplate(fileName)).toBeNull();
    expect(() => getGatewayAdminAgentMarkdownFile('main', fileName)).toThrow();
  }
});

test('fails explicitly when a shipped template cannot be read', async () => {
  setupHome();
  const { readWorkspaceTemplate } = await import('../src/workspace-templates.js');
  const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
    throw new Error('Template unavailable');
  });
  try {
    expect(() => readWorkspaceTemplate('SOUL.md')).toThrow('Template unavailable');
    expect(readWorkspaceTemplate('../SOUL.md')).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    read.mockRestore();
  }
});
