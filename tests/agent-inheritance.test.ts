import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;
const makeTempHome = useTempDir('hybridclaw-inheritance-');

useCleanMocks({
  restoreAllMocks: true,
  cleanup: async () => {
    const { resetAgentRegistryForTesting } = await import(
      '../src/agents/agent-registry.ts'
    );
    resetAgentRegistryForTesting();
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
  },
  resetModules: true,
  unmock: ['../src/logger.js'],
});

async function bootRegistry() {
  process.env.HOME = makeTempHome();
  vi.resetModules();
  vi.doMock('../src/config/config.js', async () => ({
    ...(await vi.importActual<typeof import('../src/config/config.js')>(
      '../src/config/config.js',
    )),
    MSTEAMS_TENANT_ID: 'tenant-a',
  }));
  const { initDatabase } = await import('../src/memory/db.ts');
  const registry = await import('../src/agents/agent-registry.ts');
  initDatabase({ quiet: true });
  registry.initAgentRegistry({
    defaultAgentId: 'main',
    defaults: { model: 'default-model' },
    list: [
      { id: 'main' },
      {
        id: 'ams',
        name: 'AMS Assistant',
        model: 'hybridai/gpt-5.6-luna',
        skills: ['crm', 'reporting'],
        chatbotId: 'bot-ams',
        enableRag: true,
      },
    ],
  });
  return registry;
}

test('a child resolves unset settings from its parent, live, and keeps its own identity', async () => {
  const registry = await bootRegistry();
  registry.upsertRegisteredAgent({
    id: 'ams-erika',
    extends: 'ams',
    displayName: 'AMS · Erika',
    enableRag: false,
  });

  const child = registry.getAgentById('ams-erika');
  expect(child).toMatchObject({
    id: 'ams-erika',
    extends: 'ams',
    displayName: 'AMS · Erika',
    model: 'hybridai/gpt-5.6-luna',
    skills: ['crm', 'reporting'],
    chatbotId: 'bot-ams',
    enableRag: false,
  });
  expect(child?.name).toBeUndefined();
  expect(registry.getStoredAgentConfig('ams-erika')?.model).toBeUndefined();
  expect(registry.childAgentsOf('ams')).toEqual(['ams-erika']);

  registry.upsertRegisteredAgent({
    ...registry.getStoredAgentConfig('ams'),
    id: 'ams',
    model: 'hybridai/gpt-5.7',
    skills: ['crm'],
  });
  expect(registry.getAgentById('ams-erika')).toMatchObject({
    model: 'hybridai/gpt-5.7',
    skills: ['crm'],
  });
  expect(registry.resolveAgentForRequest({ agentId: 'ams-erika' })).toEqual({
    agentId: 'ams-erika',
    model: 'hybridai/gpt-5.7',
    chatbotId: 'bot-ams',
  });
  expect(
    registry.listAgents().find((agent) => agent.id === 'ams-erika')?.model,
  ).toBe('hybridai/gpt-5.7');
});

test('inheritance rejects unknown, self, and chained parents', async () => {
  const registry = await bootRegistry();
  expect(() =>
    registry.upsertRegisteredAgent({ id: 'orphan', extends: 'nobody' }),
  ).toThrow(/extends references unknown agent "nobody"/);
  expect(() =>
    registry.upsertRegisteredAgent({ id: 'loop', extends: 'loop' }),
  ).toThrow(/cannot reference itself/);
  registry.upsertRegisteredAgent({ id: 'ams-erika', extends: 'ams' });
  expect(() =>
    registry.upsertRegisteredAgent({ id: 'grandchild', extends: 'ams-erika' }),
  ).toThrow(/one level deep/);
  expect(registry.getAgentById('orphan')).toBeNull();
  expect(registry.getAgentById('grandchild')).toBeNull();
});

test('a parent with active children cannot be archived or deleted', async () => {
  const registry = await bootRegistry();
  registry.upsertRegisteredAgent({ id: 'ams-erika', extends: 'ams' });
  expect(() => registry.setRegisteredAgentArchived('ams', true)).toThrow(
    /Cannot archive agent "ams" while active agents extend it: ams-erika/,
  );
  expect(() => registry.deleteRegisteredAgent('ams')).toThrow(
    /ams-erika\.extends/,
  );
  registry.setRegisteredAgentArchived('ams-erika', true);
  expect(registry.setRegisteredAgentArchived('ams', true).archived).toBe(true);
});

test('createPersonalAgent seeds the workspace from the parent and skips hatching', async () => {
  const registry = await bootRegistry();
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  const { createPersonalAgent } = await import(
    '../src/agents/personal-agent.ts'
  );
  const { isBootstrapping, loadBootstrapFiles } = await import(
    '../src/workspace.ts'
  );
  const parentDir = agentWorkspaceDir('ams');
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(path.join(parentDir, 'SOUL.md'), '# AMS soul\n');
  fs.writeFileSync(path.join(parentDir, 'MEMORY.md'), '# private notes\n');
  fs.writeFileSync(path.join(parentDir, 'USER.md'), '# the admin\n');

  const created = createPersonalAgent({
    parentAgentId: 'ams',
    handle: 'Erika Mustermann',
    displayName: 'AMS Assistant · Erika Mustermann',
    userMarkdown: '# USER.md\n\n- Name: Erika Mustermann\n',
  });
  expect(created.id).toBe('ams-erika-mustermann');
  expect(created.extends).toBe('ams');
  expect(registry.getAgentById(created.id)?.model).toBe(
    'hybridai/gpt-5.6-luna',
  );

  const childDir = agentWorkspaceDir(created.id);
  expect(fs.readFileSync(path.join(childDir, 'SOUL.md'), 'utf-8')).toBe(
    '# AMS soul\n',
  );
  expect(fs.readFileSync(path.join(childDir, 'USER.md'), 'utf-8')).toContain(
    'Erika Mustermann',
  );
  expect(fs.existsSync(path.join(childDir, 'MEMORY.md'))).toBe(false);
  expect(isBootstrapping(created.id)).toBe(false);
  expect(
    loadBootstrapFiles(created.id).some((file) => file.name === 'BOOTSTRAP.md'),
  ).toBe(false);

  const second = createPersonalAgent({
    parentAgentId: 'ams',
    handle: 'Erika Mustermann',
    displayName: 'AMS Assistant · Erika Mustermann',
    userMarkdown: '# USER.md\n',
  });
  expect(second.id).toBe('ams-erika-mustermann-2');
  expect(() =>
    createPersonalAgent({
      parentAgentId: created.id,
      handle: 'x',
      displayName: 'x',
      userMarkdown: '',
    }),
  ).toThrow(/cannot be a parent/);
});

test('Teams routes personal agents in direct chats only and provisions them on demand', async () => {
  const registry = await bootRegistry();
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { observeMSTeamsUser, getMSTeamsUserAgent } = await import(
    '../src/memory/msteams-users.ts'
  );
  const { ensureMSTeamsPersonalAgent, resolveMSTeamsUserAgent } = await import(
    '../src/channels/msteams/user-routing.ts'
  );
  const { createAdminMSTeamsPersonalAgent, getAdminMSTeamsUsers } =
    await import('../src/gateway/msteams-users.ts');

  observeMSTeamsUser({
    tenantId: 'tenant-a',
    userId: 'entra-erika',
    teamsUserId: '29:erika',
    entraObjectId: 'entra-erika',
    displayName: 'Erika Mustermann',
    isMessage: true,
  });
  expect(getAdminMSTeamsUsers().personalAgentParent).toBeNull();
  expect(
    createAdminMSTeamsPersonalAgent({ userId: 'nobody', parentAgentId: 'ams' }),
  ).toEqual({ status: 404, error: expect.stringContaining('not found') });
  expect(
    createAdminMSTeamsPersonalAgent({ userId: 'entra-erika', parentAgentId: 'main' }),
  ).toMatchObject({ status: 200, agentId: 'main-erika-mustermann' });
  expect(getMSTeamsUserAgent('tenant-a', 'entra-erika')).toBe(
    'main-erika-mustermann',
  );
  expect(
    createAdminMSTeamsPersonalAgent({
      userId: 'entra-erika',
      parentAgentId: 'main-erika-mustermann',
    }),
  ).toMatchObject({ status: 400 });

  expect(resolveMSTeamsUserAgent('tenant-a', 'entra-erika', 'personal')).toBe(
    'main-erika-mustermann',
  );
  expect(resolveMSTeamsUserAgent('tenant-a', 'entra-erika', 'group')).toBe(
    'main',
  );
  expect(resolveMSTeamsUserAgent('tenant-a', 'entra-erika', 'channel')).toBe(
    'main',
  );

  observeMSTeamsUser({
    tenantId: 'tenant-a',
    userId: 'entra-tomasz',
    teamsUserId: '29:tomasz',
    entraObjectId: 'entra-tomasz',
    displayName: 'Tomasz',
    isMessage: true,
  });
  expect(
    ensureMSTeamsPersonalAgent({
      tenantId: 'tenant-a',
      userId: 'entra-tomasz',
      displayName: 'Tomasz',
      entraObjectId: 'entra-tomasz',
      teamsUserId: '29:tomasz',
    }),
  ).toBeNull();
  updateRuntimeConfig((draft) => {
    draft.msteams.personalAgentParent = 'ams';
  });
  expect(
    ensureMSTeamsPersonalAgent({
      tenantId: 'tenant-a',
      userId: 'never-observed',
      displayName: 'Ghost',
      entraObjectId: null,
      teamsUserId: null,
    }),
  ).toBeNull();
  expect(registry.listAgents().some((agent) => agent.id.includes('ghost'))).toBe(
    false,
  );
  expect(getAdminMSTeamsUsers().personalAgentParent).toBe('ams');
  expect(
    ensureMSTeamsPersonalAgent({
      tenantId: 'tenant-a',
      userId: 'entra-tomasz',
      displayName: 'Tomasz',
      entraObjectId: 'entra-tomasz',
      teamsUserId: '29:tomasz',
    }),
  ).toBe('ams-tomasz');
  expect(registry.getAgentById('ams-tomasz')).toMatchObject({
    extends: 'ams',
    displayName: 'AMS Assistant · Tomasz',
    chatbotId: 'bot-ams',
  });
  expect(
    ensureMSTeamsPersonalAgent({
      tenantId: 'tenant-a',
      userId: 'entra-tomasz',
      displayName: 'Tomasz',
      entraObjectId: 'entra-tomasz',
      teamsUserId: '29:tomasz',
    }),
  ).toBeNull();
  expect(
    ensureMSTeamsPersonalAgent({
      tenantId: 'tenant-a',
      userId: 'entra-erika',
      displayName: 'Erika',
      entraObjectId: null,
      teamsUserId: null,
    }),
  ).toBeNull();
});
