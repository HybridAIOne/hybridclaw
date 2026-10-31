import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { DISCORD_CAPABILITIES } from '../src/channels/channel.js';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { loadIsolatedSkillsRuntime } from './helpers/skills-workspace-runtime.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir('hybridclaw-skill-workspace-');
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  restoreAllMocks: true,
  resetModules: true,
  unstubAllEnvs: true,
  unmock: ['../src/infra/install-root.js'],
});

async function fixture() {
  const runtime = await loadIsolatedSkillsRuntime(tempDir());
  const skill = path.join(runtime.bundledDir, 'notes', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(
    skill,
    '---\nname: notes\ndescription: Organize notes\n---\nRead source notes.\n',
  );
  const { initDatabase } = await import('../src/memory/db.js');
  initDatabase({ quiet: true });
  const { buildConversationContext } = await import(
    '../src/agent/conversation.js'
  );
  const { buildEligibleSkillCatalog } = await import(
    '../src/skills/skill-catalog.js'
  );
  const project = tempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', project);
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT', project);
  vi.stubEnv(
    'HYBRIDCLAW_AGENT_ALLOWED_ROOTS',
    JSON.stringify([runtime.workspaceDir]),
  );
  return {
    ...runtime,
    project,
    buildConversationContext,
    buildEligibleSkillCatalog,
  };
}

test('advertised skill reads reach agent-owned assets from a separate execution directory', async () => {
  const f = await fixture();
  const runtimeInfo = {
    workspacePath: f.project,
    skillWorkspacePath: f.workspaceDir,
  };
  const context = f.buildConversationContext({
    agentId: 'main',
    history: [],
    runtimeInfo,
  });
  const catalog = f.buildEligibleSkillCatalog(context.skills);
  const worker = await import('../container/src/tools/skills-list.js');
  worker.setEligibleSkillsCatalog(catalog);
  worker.setSkillDiscoveryTools(
    [
      {
        type: 'function',
        function: { name: 'read', description: '', parameters: {} },
      },
    ],
    [
      {
        type: 'function',
        function: { name: 'read', description: '', parameters: {} },
      },
    ],
  );
  const selected = JSON.parse(worker.runSkillsList({ name: 'notes' }));
  const { executeToolWithMetadata } = await import('../container/src/tools.js');
  const result = await executeToolWithMetadata(
    selected.next.name,
    JSON.stringify(selected.next.arguments),
  );
  expect(result.isError).toBe(false);
  expect(result.output).toContain('Read source notes.');
  expect(selected.skill.location).toBe(
    path.join(f.workspaceDir, 'skills/notes/SKILL.md'),
  );
  expect(context.messages.map((m) => String(m.content)).join('\n')).toContain(
    selected.skill.location,
  );
  expect(fs.readdirSync(f.project)).toEqual([]);
});

test('normal and scoped workspaces retain relative locations and scope-owned assets', async () => {
  const f = await fixture();
  for (const workspaceDir of [undefined, tempDir()]) {
    const context = f.buildConversationContext({
      agentId: 'main',
      workspaceDir,
      history: [],
    });
    expect(context.skills[0].location).toBe('skills/notes/SKILL.md');
    expect(
      fs.existsSync(
        path.join(workspaceDir ?? f.workspaceDir, context.skills[0].location),
      ),
    ).toBe(true);
  }
});

test('separate-workspace metadata preserves channel eligibility', async () => {
  const f = await fixture();
  const file = path.join(f.bundledDir, 'notes', 'SKILL.md');
  fs.writeFileSync(
    file,
    '---\nname: notes\ndescription: Organize notes\nsupported_channels: [web]\n---\nRead source notes.\n',
  );
  const runtimeInfo = {
    workspacePath: f.project,
    skillWorkspacePath: f.workspaceDir,
    channel: {
      kind: 'discord' as const,
      id: 'channel_a',
      capabilities: DISCORD_CAPABILITIES,
    },
  };
  const context = f.buildConversationContext({
    agentId: 'main',
    history: [],
    runtimeInfo,
  });
  expect(context.skills).toEqual([]);
  expect(f.buildEligibleSkillCatalog(context.skills)).toEqual([]);
  expect(fs.readdirSync(f.project)).toEqual([]);
});

test('skill metadata never grants read access outside admitted roots', async () => {
  const f = await fixture();
  vi.stubEnv('HYBRIDCLAW_AGENT_ALLOWED_ROOTS', '[]');
  const runtimeInfo = {
    workspacePath: f.project,
    skillWorkspacePath: f.workspaceDir,
  };
  const context = f.buildConversationContext({
    agentId: 'main',
    history: [],
    runtimeInfo,
  });
  const { executeToolWithMetadata } = await import('../container/src/tools.js');
  const result = await executeToolWithMetadata(
    'read',
    JSON.stringify({ path: context.skills[0].location }),
  );
  expect(result.isError).toBe(true);
  expect(result.output).not.toContain('Read source notes.');
});

test('runtime metadata describes the skill command directory independently of the catalog', async () => {
  const f = await fixture();
  const { buildSystemPromptFromHooks } = await import(
    '../src/agent/prompt-hooks.js'
  );
  const runtimeInfo = {
    workspacePath: f.project,
    skillWorkspacePath: f.workspaceDir,
  };
  const prompt = buildSystemPromptFromHooks({
    agentId: 'main',
    skills: [],
    runtimeInfo,
  });
  expect(prompt).toContain(f.project);
  expect(prompt).toContain(f.workspaceDir);
});
