import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

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
  ).toThrow(
    'Markdown revision content exceeds the 200000-byte admin editor limit.',
  );

  expect(fs.readFileSync(path.join(workspacePath, 'AGENTS.md'), 'utf-8')).toBe(
    '# AGENTS.md\n\n- Keep responses concise.\n',
  );
});

test('caps markdown revisions to the newest 50 saves', async () => {
  setupHome();

  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const {
    getGatewayAdminAgentMarkdownFile,
    saveGatewayAdminAgentMarkdownFile,
  } = await import('../src/gateway/gateway-service.ts');

  const baseTimeMs = Date.parse('2026-04-13T10:00:00.000Z');
  const createdRevisionIds: string[] = [];
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(baseTimeMs));
    saveGatewayAdminAgentMarkdownFile({
      agentId: 'main',
      fileName: 'AGENTS.md',
      content: '# Version 0\n',
    });

    for (let index = 1; index <= 55; index += 1) {
      vi.setSystemTime(new Date(baseTimeMs + index * 1_000));
      const response = saveGatewayAdminAgentMarkdownFile({
        agentId: 'main',
        fileName: 'AGENTS.md',
        content: `# Version ${index}\n`,
      });
      const revisionId = response.file.revisions[0]?.id;
      if (!revisionId) {
        throw new Error(`Expected revision id for save ${index}.`);
      }
      createdRevisionIds.push(revisionId);
    }
  } finally {
    vi.useRealTimers();
  }

  const workspacePath = agentWorkspaceDir('main');
  const revisionDir = path.join(
    path.dirname(workspacePath),
    'markdown-revisions',
    'AGENTS.md',
  );
  const revisionFiles = fs
    .readdirSync(revisionDir)
    .filter((entry) => entry.endsWith('.json'));
  expect(revisionFiles).toHaveLength(50);

  const loaded = getGatewayAdminAgentMarkdownFile('main', 'AGENTS.md');
  expect(loaded.file.revisions).toHaveLength(50);
  expect(loaded.file.revisions.map((revision) => revision.id)).toEqual(
    createdRevisionIds.slice(-50).reverse(),
  );
});

test('lists admin agents with one workspace directory scan instead of per-file stats', async () => {
  setupHome();

  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { getGatewayAdminAgents, saveGatewayAdminAgentMarkdownFile } =
    await import('../src/gateway/gateway-service.ts');
  const { WORKSPACE_BOOTSTRAP_FILES } = await import('../src/workspace.ts');

  saveGatewayAdminAgentMarkdownFile({
    agentId: 'main',
    fileName: 'AGENTS.md',
    content: '# AGENTS.md\n\n- Keep responses concise.\n',
  });

  const workspacePath = agentWorkspaceDir('main');
  const bootstrapFilePaths = new Set(
    WORKSPACE_BOOTSTRAP_FILES.map((fileName) =>
      path.join(workspacePath, fileName),
    ),
  );
  const statSpy = vi.spyOn(fs, 'statSync');
  const readdirSpy = vi.spyOn(fs, 'readdirSync');

  try {
    statSpy.mockClear();
    readdirSpy.mockClear();

    const response = getGatewayAdminAgents();
    const mainAgent = response.agents.find((agent) => agent.id === 'main');
    const mainAgentsFile = mainAgent?.markdownFiles.find(
      (file) => file.name === 'AGENTS.md',
    );

    expect(mainAgentsFile).toEqual({
      name: 'AGENTS.md',
      path: path.join(workspacePath, 'AGENTS.md'),
      exists: true,
      updatedAt: null,
      sizeBytes: null,
    });

    const bootstrapStatCalls = statSpy.mock.calls.filter(([targetPath]) => {
      return (
        typeof targetPath === 'string' && bootstrapFilePaths.has(targetPath)
      );
    });
    const workspaceReadCalls = readdirSpy.mock.calls.filter(([targetPath]) => {
      return targetPath === workspacePath;
    });

    expect(bootstrapStatCalls).toHaveLength(0);
    expect(workspaceReadCalls).toHaveLength(1);
  } finally {
    statSpy.mockRestore();
    readdirSpy.mockRestore();
  }
});

test('reads only the newest 50 markdown revision files when listing versions', async () => {
  setupHome();

  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const {
    getGatewayAdminAgentMarkdownFile,
    saveGatewayAdminAgentMarkdownFile,
  } = await import('../src/gateway/gateway-service.ts');

  saveGatewayAdminAgentMarkdownFile({
    agentId: 'main',
    fileName: 'AGENTS.md',
    content: '# Current Rules\n',
  });

  const workspacePath = agentWorkspaceDir('main');
  const revisionDir = path.join(
    path.dirname(workspacePath),
    'markdown-revisions',
    'AGENTS.md',
  );
  fs.mkdirSync(revisionDir, { recursive: true });

  const baseTimeMs = Date.parse('2026-04-13T12:00:00.000Z');
  const revisionIds: string[] = [];
  for (let index = 1; index <= 60; index += 1) {
    const timestampMs = baseTimeMs + index * 1_000;
    const revisionId = `${timestampMs.toString(36)}-rev${index
      .toString()
      .padStart(2, '0')}`;
    revisionIds.push(revisionId);
    fs.writeFileSync(
      path.join(revisionDir, `${revisionId}.json`),
      JSON.stringify(
        {
          id: revisionId,
          fileName: 'AGENTS.md',
          createdAt: new Date(timestampMs).toISOString(),
          sizeBytes: index,
          sha256: `sha-${index}`,
          source: index % 2 === 0 ? 'restore' : 'save',
          content: `# Revision ${index}\n`,
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  const readSpy = vi.spyOn(fs, 'readFileSync');
  try {
    readSpy.mockClear();

    const loaded = getGatewayAdminAgentMarkdownFile('main', 'AGENTS.md');
    expect(loaded.file.revisions).toHaveLength(50);
    expect(loaded.file.revisions.map((revision) => revision.id)).toEqual(
      revisionIds.slice(-50).reverse(),
    );

    const revisionReadCalls = readSpy.mock.calls.filter(([targetPath]) => {
      return (
        typeof targetPath === 'string' &&
        targetPath.startsWith(revisionDir) &&
        targetPath.endsWith('.json')
      );
    });

    expect(revisionReadCalls).toHaveLength(50);
  } finally {
    readSpy.mockRestore();
  }
});

test('lists split revision metadata without reading revision content files', async () => {
  setupHome();

  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const {
    getGatewayAdminAgentMarkdownFile,
    saveGatewayAdminAgentMarkdownFile,
  } = await import('../src/gateway/gateway-service.ts');

  const baseTimeMs = Date.parse('2026-04-13T14:00:00.000Z');
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(baseTimeMs));
    saveGatewayAdminAgentMarkdownFile({
      agentId: 'main',
      fileName: 'AGENTS.md',
      content: '# Version 0\n',
    });

    for (let index = 1; index <= 55; index += 1) {
      vi.setSystemTime(new Date(baseTimeMs + index * 1_000));
      saveGatewayAdminAgentMarkdownFile({
        agentId: 'main',
        fileName: 'AGENTS.md',
        content: `# Version ${index}\n`,
      });
    }
  } finally {
    vi.useRealTimers();
  }

  const workspacePath = agentWorkspaceDir('main');
  const revisionDir = path.join(
    path.dirname(workspacePath),
    'markdown-revisions',
    'AGENTS.md',
  );
  expect(
    fs
      .readdirSync(revisionDir)
      .filter((entry) => entry.endsWith('.json') || entry.endsWith('.md')),
  ).toHaveLength(100);

  const readSpy = vi.spyOn(fs, 'readFileSync');
  try {
    readSpy.mockClear();

    const loaded = getGatewayAdminAgentMarkdownFile('main', 'AGENTS.md');
    expect(loaded.file.revisions).toHaveLength(50);

    const revisionMetadataReadCalls = readSpy.mock.calls.filter(
      ([targetPath]) => {
        return (
          typeof targetPath === 'string' &&
          targetPath.startsWith(revisionDir) &&
          targetPath.endsWith('.json')
        );
      },
    );
    const revisionContentReadCalls = readSpy.mock.calls.filter(
      ([targetPath]) => {
        return (
          typeof targetPath === 'string' &&
          targetPath.startsWith(revisionDir) &&
          targetPath.endsWith('.md')
        );
      },
    );

    expect(revisionMetadataReadCalls).toHaveLength(50);
    expect(revisionContentReadCalls).toHaveLength(0);
  } finally {
    readSpy.mockRestore();
  }
});

test('rejects invalid revision ids before reading revision files', async () => {
  setupHome();

  const {
    getGatewayAdminAgentMarkdownRevision,
    restoreGatewayAdminAgentMarkdownRevision,
    saveGatewayAdminAgentMarkdownFile,
  } = await import('../src/gateway/gateway-service.ts');

  saveGatewayAdminAgentMarkdownFile({
    agentId: 'main',
    fileName: 'AGENTS.md',
    content: '# AGENTS.md\n\n- Keep responses concise.\n',
  });

  expect(() =>
    getGatewayAdminAgentMarkdownRevision({
      agentId: 'main',
      fileName: 'AGENTS.md',
      revisionId: '../outside',
    }),
  ).toThrow('Revision id is invalid.');

  expect(() =>
    restoreGatewayAdminAgentMarkdownRevision({
      agentId: 'main',
      fileName: 'AGENTS.md',
      revisionId: '../outside',
    }),
  ).toThrow('Revision id is invalid.');
});

test('reuses the resolved agent config within a markdown file detail request', async () => {
  setupHome();

  const agentRegistry = await import('../src/agents/agent-registry.ts');
  const resolveSpy = vi.spyOn(agentRegistry, 'resolveAgentConfig');
  const {
    getGatewayAdminAgentMarkdownFile,
    saveGatewayAdminAgentMarkdownFile,
  } = await import('../src/gateway/gateway-service.ts');

  saveGatewayAdminAgentMarkdownFile({
    agentId: 'main',
    fileName: 'AGENTS.md',
    content: '# AGENTS.md\n\n- Keep responses concise.\n',
  });

  resolveSpy.mockClear();

  const response = getGatewayAdminAgentMarkdownFile('main', 'AGENTS.md');
  expect(response.file.content).toBe(
    '# AGENTS.md\n\n- Keep responses concise.\n',
  );
  expect(
    resolveSpy.mock.calls.filter(([agentId]) => agentId === 'main'),
  ).toHaveLength(1);
});

test('reuses the target markdown file state within a save request', async () => {
  setupHome();

  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const { saveGatewayAdminAgentMarkdownFile } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { WORKSPACE_BOOTSTRAP_FILES } = await import('../src/workspace.ts');

  saveGatewayAdminAgentMarkdownFile({
    agentId: 'main',
    fileName: 'AGENTS.md',
    content: '# AGENTS.md\n\n- Keep responses concise.\n',
  });

  const workspacePath = agentWorkspaceDir('main');
  const filePath = path.join(workspacePath, 'AGENTS.md');
  const otherBootstrapFilePaths = new Set(
    WORKSPACE_BOOTSTRAP_FILES.map((fileName) =>
      path.join(workspacePath, fileName),
    ).filter((targetPath) => targetPath !== filePath),
  );
  const statSpy = vi.spyOn(fs, 'statSync');
  const readSpy = vi.spyOn(fs, 'readFileSync');
  const readdirSpy = vi.spyOn(fs, 'readdirSync');

  try {
    statSpy.mockClear();
    readSpy.mockClear();
    readdirSpy.mockClear();

    saveGatewayAdminAgentMarkdownFile({
      agentId: 'main',
      fileName: 'AGENTS.md',
      content: '# AGENTS.md\n\n- Prefer concise answers.\n',
    });

    const targetStatCalls = statSpy.mock.calls.filter(([targetPath]) => {
      return targetPath === filePath;
    });
    const targetReadCalls = readSpy.mock.calls.filter(([targetPath]) => {
      return targetPath === filePath;
    });
    const otherBootstrapStatCalls = statSpy.mock.calls.filter(
      ([targetPath]) => {
        return (
          typeof targetPath === 'string' &&
          otherBootstrapFilePaths.has(targetPath)
        );
      },
    );
    const workspaceReadCalls = readdirSpy.mock.calls.filter(([targetPath]) => {
      return targetPath === workspacePath;
    });

    expect(targetStatCalls).toHaveLength(2);
    expect(targetReadCalls).toHaveLength(1);
    expect(otherBootstrapStatCalls).toHaveLength(0);
    expect(workspaceReadCalls).toHaveLength(1);
  } finally {
    statSpy.mockRestore();
    readSpy.mockRestore();
    readdirSpy.mockRestore();
  }
});

test('reuses the target markdown file state within a restore request', async () => {
  setupHome();

  const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
  const {
    restoreGatewayAdminAgentMarkdownRevision,
    saveGatewayAdminAgentMarkdownFile,
  } = await import('../src/gateway/gateway-service.ts');
  const { WORKSPACE_BOOTSTRAP_FILES } = await import('../src/workspace.ts');

  saveGatewayAdminAgentMarkdownFile({
    agentId: 'main',
    fileName: 'AGENTS.md',
    content: '# AGENTS.md\n\n- Keep responses concise.\n',
  });

  const updated = saveGatewayAdminAgentMarkdownFile({
    agentId: 'main',
    fileName: 'AGENTS.md',
    content: '# AGENTS.md\n\n- Prefer concise answers.\n',
  });

  const revisionId = updated.file.revisions[0]?.id;
  if (!revisionId) {
    throw new Error('Expected a saved markdown revision.');
  }

  const workspacePath = agentWorkspaceDir('main');
  const filePath = path.join(workspacePath, 'AGENTS.md');
  const otherBootstrapFilePaths = new Set(
    WORKSPACE_BOOTSTRAP_FILES.map((fileName) =>
      path.join(workspacePath, fileName),
    ).filter((targetPath) => targetPath !== filePath),
  );
  const statSpy = vi.spyOn(fs, 'statSync');
  const readSpy = vi.spyOn(fs, 'readFileSync');
  const readdirSpy = vi.spyOn(fs, 'readdirSync');

  try {
    statSpy.mockClear();
    readSpy.mockClear();
    readdirSpy.mockClear();

    restoreGatewayAdminAgentMarkdownRevision({
      agentId: 'main',
      fileName: 'AGENTS.md',
      revisionId,
    });

    const targetStatCalls = statSpy.mock.calls.filter(([targetPath]) => {
      return targetPath === filePath;
    });
    const targetReadCalls = readSpy.mock.calls.filter(([targetPath]) => {
      return targetPath === filePath;
    });
    const otherBootstrapStatCalls = statSpy.mock.calls.filter(
      ([targetPath]) => {
        return (
          typeof targetPath === 'string' &&
          otherBootstrapFilePaths.has(targetPath)
        );
      },
    );
    const workspaceReadCalls = readdirSpy.mock.calls.filter(([targetPath]) => {
      return targetPath === workspacePath;
    });

    expect(targetStatCalls).toHaveLength(2);
    expect(targetReadCalls).toHaveLength(1);
    expect(otherBootstrapStatCalls).toHaveLength(0);
    expect(workspaceReadCalls).toHaveLength(1);
  } finally {
    statSpy.mockRestore();
    readSpy.mockRestore();
    readdirSpy.mockRestore();
  }
});
