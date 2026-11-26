import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';
import type { AgentConfig } from '../src/agents/agent-types.ts';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-admin-agents-',
});

function readConfigAgentsList(configPath: string): AgentConfig[] {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
    agents?: { list?: AgentConfig[] };
  };
  return parsed.agents?.list ?? [];
}

test('persists admin agent updates to config.json across registry reloads and unrelated config edits', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const {
    getRuntimeConfig,
    listRuntimeConfigRevisions,
    runtimeConfigPath,
    updateRuntimeConfig,
  } = await import('../src/config/runtime-config.ts');
  const { getAgentById, initAgentRegistry } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { getGatewayAdminAgents, updateGatewayAdminAgent } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      { id: 'main', name: 'Main Agent' },
      {
        id: 'writer',
        name: 'Writer',
        displayName: 'Writer Display',
        model: 'gpt-5-mini',
        skills: ['pdf'],
        tools: ['read'],
        workspace: 'writer-v1',
        chatbotId: 'bot-v1',
        enableRag: true,
        budget: { cap: 25, currency: 'USD', unit: 'USD' },
      },
    ];
  });
  initAgentRegistry(getRuntimeConfig().agents);
  const revisionsBefore = listRuntimeConfigRevisions().length;

  const updated = updateGatewayAdminAgent('writer', {
    name: 'Senior Writer',
    model: 'gpt-5.2',
    skills: ['pdf', 'docx'],
    tools: ['read', 'grep'],
    workspace: 'writer-v2',
    chatbotId: 'bot-v2',
    enableRag: false,
    role: 'Lead Writer',
    reportsTo: 'main',
  });

  expect(updated.agent).toMatchObject({
    id: 'writer',
    name: 'Senior Writer',
    model: 'gpt-5.2',
    skills: ['pdf', 'docx'],
    tools: ['read', 'grep'],
    workspace: 'writer-v2',
    chatbotId: 'bot-v2',
    enableRag: false,
    role: 'Lead Writer',
    reportsTo: 'main',
  });

  // Config file persisted the edited fields and preserved untouched/config-only fields.
  const diskWriter = readConfigAgentsList(runtimeConfigPath()).find(
    (entry) => entry.id === 'writer',
  );
  expect(diskWriter).toMatchObject({
    id: 'writer',
    name: 'Senior Writer',
    displayName: 'Writer Display',
    model: 'gpt-5.2',
    skills: ['pdf', 'docx'],
    tools: ['read', 'grep'],
    workspace: 'writer-v2',
    chatbotId: 'bot-v2',
    enableRag: false,
    role: 'Lead Writer',
    reportsTo: 'main',
    budget: { cap: 25, currency: 'USD', unit: 'USD' },
  });

  // Recorded a config revision for the admin edit.
  const revisionsAfter = listRuntimeConfigRevisions();
  expect(revisionsAfter.length).toBeGreaterThan(revisionsBefore);
  expect(revisionsAfter[0]).toMatchObject({
    route: 'admin.agents.update:writer',
    source: 'user',
  });

  // Simulate a gateway restart re-syncing from config.json.
  initAgentRegistry(getRuntimeConfig().agents);
  expect(getAgentById('writer')).toMatchObject({
    name: 'Senior Writer',
    model: 'gpt-5.2',
    skills: ['pdf', 'docx'],
    tools: ['read', 'grep'],
    workspace: 'writer-v2',
    chatbotId: 'bot-v2',
    enableRag: false,
    role: 'Lead Writer',
    reportsTo: 'main',
  });

  // Simulate an unrelated config.json edit to another agent triggering ensureRegistryCurrent.
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      ...(draft.agents.list ?? []),
      { id: 'analyst', name: 'Analyst' },
    ];
  });
  const adminWriter = getGatewayAdminAgents().agents.find(
    (agent) => agent.id === 'writer',
  );
  expect(adminWriter).toMatchObject({
    name: 'Senior Writer',
    model: 'gpt-5.2',
    skills: ['pdf', 'docx'],
    tools: ['read', 'grep'],
    workspace: 'writer-v2',
    chatbotId: 'bot-v2',
    enableRag: false,
    role: 'Lead Writer',
    reportsTo: 'main',
  });
});

test('clearing optional fields on a config-backed agent removes them from config.json and does not revert', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const {
    getRuntimeConfig,
    runtimeConfigPath,
    updateRuntimeConfig,
  } = await import('../src/config/runtime-config.ts');
  const { getAgentById, initAgentRegistry } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { updateAdminAgentRecord } = await import(
    '../src/gateway/admin-agents.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      { id: 'main', name: 'Main Agent' },
      { id: 'parent', name: 'Parent Agent' },
      {
        id: 'writer',
        extends: 'parent',
        name: 'Writer',
        model: 'gpt-5-mini',
        skills: ['pdf'],
        tools: ['read'],
        workspace: 'writer-ws',
        chatbotId: 'bot-1',
        enableRag: true,
        role: 'Author',
        reportsTo: 'main',
        delegatesTo: ['parent'],
        peers: ['parent'],
        proxy: {
          kind: 'hybridai',
          baseUrl: 'https://hybridai.example',
          chatbotId: 'bot-proxy',
          apiKey: { source: 'store', id: 'HYBRIDAI_API_KEY' },
        },
      },
    ];
  });
  initAgentRegistry(getRuntimeConfig().agents);

  const cleared = updateAdminAgentRecord('writer', {
    extends: null,
    name: '',
    model: '',
    skills: null,
    tools: null,
    workspace: '',
    chatbotId: null,
    enableRag: null,
    role: null,
    reportsTo: null,
    delegatesTo: null,
    peers: null,
    proxy: null,
  });

  expect(cleared.id).toBe('writer');
  expect(cleared.extends).toBeUndefined();
  expect(cleared.name).toBeUndefined();
  expect(cleared.model).toBeUndefined();
  expect(cleared.skills).toBeUndefined();
  expect(cleared.tools).toBeUndefined();
  expect(cleared.workspace).toBeUndefined();
  expect(cleared.chatbotId).toBeUndefined();
  expect(cleared.enableRag).toBeUndefined();
  expect(cleared.role).toBeUndefined();
  expect(cleared.reportsTo).toBeUndefined();
  expect(cleared.delegatesTo).toBeUndefined();
  expect(cleared.peers).toBeUndefined();
  expect(cleared.proxy).toBeUndefined();

  const diskWriter = readConfigAgentsList(runtimeConfigPath()).find(
    (entry) => entry.id === 'writer',
  );
  expect(diskWriter).toEqual({ id: 'writer' });

  // Re-sync and mutate another agent: cleared fields must stay cleared.
  initAgentRegistry(getRuntimeConfig().agents);
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      ...(draft.agents.list ?? []),
      { id: 'reviewer', name: 'Reviewer' },
    ];
  });
  const afterSync = getAgentById('writer');
  expect(afterSync?.extends).toBeUndefined();
  expect(afterSync?.name).toBeUndefined();
  expect(afterSync?.model).toBeUndefined();
  expect(afterSync?.skills).toBeUndefined();
  expect(afterSync?.tools).toBeUndefined();
  expect(afterSync?.workspace).toBeUndefined();
  expect(afterSync?.chatbotId).toBeUndefined();
  expect(afterSync?.enableRag).toBeUndefined();
  expect(afterSync?.role).toBeUndefined();
  expect(afterSync?.reportsTo).toBeUndefined();
  expect(afterSync?.delegatesTo).toBeUndefined();
  expect(afterSync?.peers).toBeUndefined();
  expect(afterSync?.proxy).toBeUndefined();
});

test('preserves empty skill and tool allowlists separately from cleared allowlists', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const {
    getRuntimeConfig,
    runtimeConfigPath,
    updateRuntimeConfig,
  } = await import('../src/config/runtime-config.ts');
  const { getAgentById, initAgentRegistry } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { updateAdminAgentRecord } = await import(
    '../src/gateway/admin-agents.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      { id: 'main' },
      { id: 'writer', skills: ['pdf'], tools: ['read'] },
    ];
  });
  initAgentRegistry(getRuntimeConfig().agents);

  updateAdminAgentRecord('writer', { skills: [], tools: [] });

  const diskWriter = readConfigAgentsList(runtimeConfigPath()).find(
    (entry) => entry.id === 'writer',
  );
  expect(diskWriter?.skills).toEqual([]);
  expect(diskWriter?.tools).toEqual([]);

  initAgentRegistry(getRuntimeConfig().agents);
  expect(getAgentById('writer')?.skills).toEqual([]);
  expect(getAgentById('writer')?.tools).toEqual([]);
});

test('skips spurious config writes for no-op or archive-only edits and preserves object model shape', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const {
    getRuntimeConfig,
    listRuntimeConfigRevisions,
    runtimeConfigPath,
    updateRuntimeConfig,
  } = await import('../src/config/runtime-config.ts');
  const { initAgentRegistry } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { updateAdminAgentRecord } = await import(
    '../src/gateway/admin-agents.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      { id: 'main' },
      {
        id: 'writer',
        model: { primary: 'ollama/llama3.2' },
        skills: ['pdf'],
      },
    ];
  });
  initAgentRegistry(getRuntimeConfig().agents);
  const revisionsBefore = listRuntimeConfigRevisions().length;

  updateAdminAgentRecord('writer', {
    model: 'ollama/llama3.2',
    skills: ['pdf'],
  });
  updateAdminAgentRecord('writer', { archived: true });

  expect(listRuntimeConfigRevisions().length).toBe(revisionsBefore);
  const diskWriter = readConfigAgentsList(runtimeConfigPath()).find(
    (entry) => entry.id === 'writer',
  );
  expect(diskWriter?.model).toEqual({ primary: 'ollama/llama3.2' });
});

test('keeps DB-only agents out of config.json across create, update, and delete', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const {
    getRuntimeConfig,
    listRuntimeConfigRevisions,
    runtimeConfigPath,
    updateRuntimeConfig,
  } = await import('../src/config/runtime-config.ts');
  const { getAgentById, initAgentRegistry } = await import(
    '../src/agents/agent-registry.ts'
  );
  const {
    createAdminAgentRecord,
    deleteAdminAgentRecord,
    updateAdminAgentRecord,
  } = await import('../src/gateway/admin-agents.ts');

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [{ id: 'main', name: 'Main Agent' }];
  });
  initAgentRegistry(getRuntimeConfig().agents);
  const revisionsBefore = listRuntimeConfigRevisions().length;

  createAdminAgentRecord({
    id: 'db-only',
    name: 'DB Only Agent',
    skills: ['pdf'],
  });
  updateAdminAgentRecord('db-only', {
    skills: ['pdf', 'docx'],
    model: 'gpt-5-mini',
  });

  expect(getAgentById('db-only')).toMatchObject({
    id: 'db-only',
    name: 'DB Only Agent',
    skills: ['pdf', 'docx'],
    model: 'gpt-5-mini',
  });
  expect(
    readConfigAgentsList(runtimeConfigPath()).map((entry) => entry.id),
  ).toEqual(['main']);
  expect(listRuntimeConfigRevisions().length).toBe(revisionsBefore);

  // Re-syncing config.json preserves DB-only agent edits.
  initAgentRegistry(getRuntimeConfig().agents);
  expect(getAgentById('db-only')).toMatchObject({
    skills: ['pdf', 'docx'],
    model: 'gpt-5-mini',
  });

  const deleted = deleteAdminAgentRecord('db-only');
  expect(deleted).toEqual({ deleted: true, agentId: 'db-only' });
  expect(getAgentById('db-only')).toBeNull();
  expect(listRuntimeConfigRevisions().length).toBe(revisionsBefore);
});

test('persists edits to the default main agent and removes deleted config-backed agents from config.json', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const {
    getRuntimeConfig,
    listRuntimeConfigRevisions,
    runtimeConfigPath,
    updateRuntimeConfig,
  } = await import('../src/config/runtime-config.ts');
  const { getAgentById, initAgentRegistry } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { deleteAdminAgentRecord, updateAdminAgentRecord } = await import(
    '../src/gateway/admin-agents.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      { id: 'main', skills: ['pdf'] },
      { id: 'writer', skills: ['pdf'] },
    ];
  });
  initAgentRegistry(getRuntimeConfig().agents);

  updateAdminAgentRecord('main', { skills: ['pdf', 'docx'] });
  initAgentRegistry(getRuntimeConfig().agents);
  expect(getAgentById('main')?.skills).toEqual(['pdf', 'docx']);
  expect(
    readConfigAgentsList(runtimeConfigPath()).find(
      (entry) => entry.id === 'main',
    )?.skills,
  ).toEqual(['pdf', 'docx']);

  const deleted = deleteAdminAgentRecord('writer');
  expect(deleted).toEqual({ deleted: true, agentId: 'writer' });
  expect(
    readConfigAgentsList(runtimeConfigPath()).map((entry) => entry.id),
  ).toEqual(['main']);
  expect(listRuntimeConfigRevisions()[0]).toMatchObject({
    route: 'admin.agents.delete:writer',
    source: 'user',
  });

  // Re-syncing from config.json must not resurrect the deleted agent.
  initAgentRegistry(getRuntimeConfig().agents);
  expect(getAgentById('writer')).toBeNull();
});

test.each([
  {
    label: 'the default agent',
    agents: { defaultAgentId: 'writer' },
    error: /is the default agent/,
  },
  {
    label: 'an agent bound to a channel',
    agents: { channels: { slack: 'writer' } },
    error: /answers on slack/,
  },
])('refuses to delete $label instead of moving its traffic', async ({
  agents,
  error,
}) => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig, runtimeConfigPath, updateRuntimeConfig } =
    await import('../src/config/runtime-config.ts');
  const { getAgentById, initAgentRegistry } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { deleteAdminAgentRecord } = await import(
    '../src/gateway/admin-agents.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents = {
      ...draft.agents,
      ...agents,
      list: [{ id: 'main' }, { id: 'writer', name: 'Writer' }],
    };
  });
  initAgentRegistry(getRuntimeConfig().agents);
  const configBefore = fs.readFileSync(runtimeConfigPath(), 'utf-8');

  expect(() => deleteAdminAgentRecord('writer')).toThrow(error);
  expect(getAgentById('writer')?.name).toBe('Writer');
  expect(fs.readFileSync(runtimeConfigPath(), 'utf-8')).toBe(configBefore);
});

test('keeps config.json valid when a config-backed agent references a DB-only agent', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const {
    getRuntimeConfig,
    runtimeConfigPath,
    updateRuntimeConfig,
  } = await import('../src/config/runtime-config.ts');
  const { getAgentById, initAgentRegistry } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { createAdminAgentRecord, updateAdminAgentRecord } = await import(
    '../src/gateway/admin-agents.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      { id: 'main', name: 'Main Agent' },
      { id: 'parent', name: 'Config Parent' },
      { id: 'writer', extends: 'parent', reportsTo: 'parent' },
    ];
  });
  initAgentRegistry(getRuntimeConfig().agents);

  createAdminAgentRecord({ id: 'db-lead', name: 'DB Lead' });

  updateAdminAgentRecord('writer', {
    extends: 'db-lead',
    reportsTo: 'db-lead',
    delegatesTo: ['db-lead'],
    peers: ['db-lead'],
  });

  // Config entry cleared the stale config-parent refs instead of writing invalid DB-only refs.
  const diskWriter = readConfigAgentsList(runtimeConfigPath()).find(
    (entry) => entry.id === 'writer',
  );
  expect(diskWriter).toEqual({ id: 'writer' });

  // Re-syncing from config.json preserves the DB-only relationships without reverting to parent.
  initAgentRegistry(getRuntimeConfig().agents);
  expect(getAgentById('writer')).toMatchObject({
    extends: 'db-lead',
    reportsTo: 'db-lead',
    delegatesTo: ['db-lead'],
    peers: ['db-lead'],
  });
});

test('upserting an existing config-backed agent via createGatewayAdminAgent syncs config.json', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const {
    getRuntimeConfig,
    runtimeConfigPath,
    updateRuntimeConfig,
  } = await import('../src/config/runtime-config.ts');
  const { getAgentById, initAgentRegistry } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { createAdminAgentRecord } = await import(
    '../src/gateway/admin-agents.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      { id: 'main' },
      {
        id: 'writer',
        skills: ['pdf'],
        model: 'gpt-5-mini',
        budget: { cap: 15, currency: 'USD', unit: 'USD' },
      },
    ];
  });
  initAgentRegistry(getRuntimeConfig().agents);

  createAdminAgentRecord({
    id: 'writer',
    skills: ['docx'],
  });

  const diskWriter = readConfigAgentsList(runtimeConfigPath()).find(
    (entry) => entry.id === 'writer',
  );
  expect(diskWriter).toEqual({
    id: 'writer',
    skills: ['docx'],
    budget: { cap: 15, currency: 'USD', unit: 'USD' },
  });

  initAgentRegistry(getRuntimeConfig().agents);
  expect(getAgentById('writer')?.skills).toEqual(['docx']);
  expect(getAgentById('writer')?.model).toBeUndefined();
});

test.skipIf(process.getuid?.() === 0)(
  'rolls the SQLite edit back when config.json cannot be written',
  async () => {
    setupHome();

    const { initDatabase } = await import('../src/memory/db.ts');
    const { getRuntimeConfig, runtimeConfigPath, updateRuntimeConfig } =
      await import('../src/config/runtime-config.ts');
    const { getAgentById, initAgentRegistry } = await import(
      '../src/agents/agent-registry.ts'
    );
    const { updateAdminAgentRecord } = await import(
      '../src/gateway/admin-agents.ts'
    );

    initDatabase({ quiet: true });
    updateRuntimeConfig((draft) => {
      draft.agents.list = [{ id: 'main' }, { id: 'writer', name: 'Writer' }];
    });
    initAgentRegistry(getRuntimeConfig().agents);

    const configDir = path.dirname(runtimeConfigPath());
    fs.chmodSync(configDir, 0o555);
    try {
      expect(() =>
        updateAdminAgentRecord('writer', { name: 'Renamed' }),
      ).toThrow();
    } finally {
      fs.chmodSync(configDir, 0o755);
    }

    expect(getAgentById('writer')?.name).toBe('Writer');
    expect(
      readConfigAgentsList(runtimeConfigPath()).find(
        (entry) => entry.id === 'writer',
      )?.name,
    ).toBe('Writer');
  },
);
