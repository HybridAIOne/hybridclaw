import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-team-structure-revisions-',
});

async function configureAgent(payload: Record<string, unknown>): Promise<void> {
  const { handleAgentPackageCommand } = await import(
    '../src/cli/agent-command.ts'
  );
  await handleAgentPackageCommand(['config', JSON.stringify(payload)]);
}

test('org-chart changes create F4 team revisions with visible diffs', async () => {
  setupHome();
  vi.spyOn(console, 'log').mockImplementation(() => {});

  await configureAgent({
    id: 'support',
    role: 'Support Lead',
    reports_to: 'main',
  });
  await configureAgent({
    id: 'support',
    role: 'Support Manager',
    reports_to: 'main',
  });

  const { getGatewayAdminTeamStructure } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const team = getGatewayAdminTeamStructure();

  expect(team.revisions.length).toBeGreaterThanOrEqual(2);
  expect(team.revisions[0]).toMatchObject({
    changeCount: 1,
    diff: {
      changed: [
        {
          agentId: 'support',
          fields: [
            {
              field: 'role',
              before: 'Support Lead',
              after: 'Support Manager',
            },
          ],
        },
      ],
    },
  });
});

test('team rollback restores the previous org chart atomically', async () => {
  setupHome();
  vi.spyOn(console, 'log').mockImplementation(() => {});

  await configureAgent({
    id: 'support',
    role: 'Support Lead',
    reports_to: 'main',
  });
  await configureAgent({
    id: 'support',
    role: 'Support Manager',
    reports_to: 'main',
  });
  await configureAgent({
    id: 'triage',
    role: 'Triage Specialist',
    reports_to: 'support',
  });

  const {
    getGatewayAdminTeamStructure,
    restoreGatewayAdminTeamStructureRevision,
  } = await import('../src/gateway/gateway-service.ts');
  const { getAgentById } = await import('../src/agents/agent-registry.ts');
  const revision = getGatewayAdminTeamStructure().revisions.find((entry) =>
    entry.diff.changed.some((change) => change.agentId === 'support'),
  );
  if (!revision) {
    throw new Error('Expected support org-chart revision.');
  }

  restoreGatewayAdminTeamStructureRevision(revision.id);

  expect(getAgentById('support')).toMatchObject({
    role: 'Support Lead',
    reportsTo: 'main',
  });
  expect(getAgentById('triage')?.role).toBeUndefined();
  expect(getAgentById('triage')?.reportsTo).toBeUndefined();
});

test('team rollback rejects missing revisions before mutating agents', async () => {
  setupHome();
  vi.spyOn(console, 'log').mockImplementation(() => {});

  await configureAgent({
    id: 'support',
    role: 'Support Manager',
    reports_to: 'main',
  });

  const { restoreGatewayAdminTeamStructureRevision } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { getAgentById } = await import('../src/agents/agent-registry.ts');

  expect(() => restoreGatewayAdminTeamStructureRevision(999)).toThrow(
    'Team structure revision 999 was not found.',
  );
  expect(getAgentById('support')).toMatchObject({
    role: 'Support Manager',
    reportsTo: 'main',
  });
});

test('runtime config org-chart sync creates team revisions', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { listAgents } = await import('../src/agents/agent-registry.ts');
  const { getGatewayAdminTeamStructure } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      { id: 'main', name: 'Main Agent' },
      { id: 'support', role: 'Support Lead', reportsTo: 'main' },
    ];
  });
  expect(listAgents().find((agent) => agent.id === 'support')?.role).toBe(
    'Support Lead',
  );

  updateRuntimeConfig((draft) => {
    draft.agents.list = [
      { id: 'main', name: 'Main Agent' },
      { id: 'support', role: 'Support Manager', reportsTo: 'main' },
    ];
  });
  expect(listAgents().find((agent) => agent.id === 'support')?.role).toBe(
    'Support Manager',
  );

  expect(getGatewayAdminTeamStructure().revisions[0]).toMatchObject({
    diff: {
      changed: [
        {
          agentId: 'support',
          fields: [
            {
              field: 'role',
              before: 'Support Lead',
              after: 'Support Manager',
            },
          ],
        },
      ],
    },
  });
});

test('atomic team rollback leaves agents unchanged when F4 sync fails', async () => {
  setupHome();
  vi.spyOn(console, 'log').mockImplementation(() => {});

  await configureAgent({
    id: 'support',
    role: 'Support Manager',
    reports_to: 'main',
  });

  const { replaceAgentOrgChart } = await import('../src/memory/db.ts');
  const { getAgentById } = await import('../src/agents/agent-registry.ts');
  const { runtimeConfigRevisionStorePath, syncRuntimeAssetRevisionState } =
    await import('../src/config/runtime-config-revisions.ts');
  const { agentTeamStructureAssetPath } = await import(
    '../src/agents/team-structure-revisions.ts'
  );

  syncRuntimeAssetRevisionState('team', agentTeamStructureAssetPath(), {
    route: 'test.seed',
    source: 'test',
  });
  const revisionDb = new Database(runtimeConfigRevisionStorePath());
  try {
    revisionDb.exec('DROP TABLE config_revision_state');
  } finally {
    revisionDb.close();
  }

  expect(() =>
    replaceAgentOrgChart(
      [
        { id: 'main' },
        { id: 'support', role: 'Support Lead', reportsTo: 'main' },
      ],
      {
        route: 'test.atomic_failure',
        source: 'test',
      },
    ),
  ).toThrow();
  expect(getAgentById('support')).toMatchObject({
    role: 'Support Manager',
    reportsTo: 'main',
  });
});
