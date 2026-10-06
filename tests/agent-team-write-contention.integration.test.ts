import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const workers: Worker[] = [];
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'agent-team-write-contention-',
  cleanup: async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  },
});

async function holdWriter(dbPath: string): Promise<void> {
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     const Database = require(workerData.sqlite);
     const db = new Database(workerData.dbPath);
     db.exec('BEGIN IMMEDIATE');
     parentPort.postMessage('locked');
     setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);`,
    {
      eval: true,
      workerData: {
        dbPath,
        sqlite: createRequire(import.meta.url).resolve('better-sqlite3'),
      },
    },
  );
  workers.push(worker);
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve());
    worker.once('error', reject);
  });
}

test.each(
  (['upsert', 'batch', 'org-chart', 'delete'] as const).flatMap((operation) =>
    (['agents', 'revisions'] as const).map((store) => ({ operation, store })),
  ),
)(
  '$operation waits for a competing $store writer before reading team state',
  async ({ operation, store }) => {
    setupHome();
    const db = await import('../src/memory/db.js');
    const { DB_PATH } = await import('../src/config/config.js');
    db.initDatabase({ quiet: true });
    const meta = { source: 'agent-registry', route: 'agents.team.test' };
    const agents = [{ id: 'main' }, { id: 'writer', role: 'Writer' }];
    db.upsertAgentsWithTeamRevision({ agents, finalAgents: agents, meta });
    const { runtimeConfigRevisionStorePath } = await import(
      '../src/config/runtime-config-revisions.js'
    );
    await holdWriter(
      store === 'agents' ? DB_PATH : runtimeConfigRevisionStorePath(),
    );

    const nextAgents = [agents[0], { id: 'writer', role: 'Editor' }];
    switch (operation) {
      case 'upsert':
        db.upsertAgentWithTeamRevision({
          agent: nextAgents[1],
          finalAgents: nextAgents,
          meta,
        });
        break;
      case 'batch':
        db.upsertAgentsWithTeamRevision({
          agents: nextAgents,
          finalAgents: nextAgents,
          meta,
        });
        break;
      case 'org-chart':
        db.replaceAgentOrgChart(nextAgents, meta);
        break;
      case 'delete':
        expect(
          db.deleteAgentWithTeamRevision({
            agentId: 'writer',
            finalAgents: [agents[0]],
            meta,
          }),
        ).toBe(true);
        break;
    }

    if (operation === 'delete') {
      expect(db.getAgentById('writer')).toBeNull();
    } else {
      expect(db.getAgentById('writer')?.role).toBe('Editor');
    }
    const { listAgentTeamStructureRevisions } = await import(
      '../src/agents/team-structure-revisions.js'
    );
    expect(listAgentTeamStructureRevisions(db.listAgents())[0].changeCount).toBe(
      1,
    );
  },
);
