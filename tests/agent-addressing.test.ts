import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-agent-addressing-',
});

test('resolves a single mention to an agent address envelope', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { resolveAgentAddressing } = await import(
    '../src/gateway/agent-addressing.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({
    id: 'research',
    displayName: 'Research Agent',
  });

  const resolved = resolveAgentAddressing({
    content: '@Research-Agent check this',
    currentAgentId: 'main',
  });

  expect(resolved).toMatchObject({
    kind: 'agent',
    agentId: 'research',
    content: 'check this',
    envelope: { to: 'research', from: 'main' },
  });
});

test('ambiguous handles prefer F10 peers before delegates and global matches', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { resolveAgentAddressing } = await import(
    '../src/gateway/agent-addressing.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({ id: 'peer-alex', displayName: 'Alex' });
  upsertRegisteredAgent({ id: 'delegate-alex', displayName: 'Alex' });
  upsertRegisteredAgent({ id: 'global-alex', displayName: 'Alex' });
  upsertRegisteredAgent({
    id: 'main',
    peers: ['peer-alex'],
    delegatesTo: ['delegate-alex'],
  });

  const resolved = resolveAgentAddressing({
    content: '@alex review this',
    currentAgentId: 'main',
  });

  expect(resolved).toMatchObject({
    kind: 'agent',
    agentId: 'peer-alex',
    envelope: { to: 'peer-alex' },
  });
});

test('unknown handles fail loud', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { resolveAgentAddressing } = await import(
    '../src/gateway/agent-addressing.ts'
  );

  initDatabase({ quiet: true });

  const resolved = resolveAgentAddressing({
    content: '@missing do this',
    currentAgentId: 'main',
  });

  expect(resolved).toMatchObject({
    kind: 'error',
    handle: 'missing',
  });
  expect(resolved.message).toContain('Unknown agent address');
});

test('ignores context references and non-leading unknown handles', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { resolveAgentAddressing } = await import(
    '../src/gateway/agent-addressing.ts'
  );

  initDatabase({ quiet: true });

  expect(
    resolveAgentAddressing({
      content: 'Explain @file:src/app.ts',
      currentAgentId: 'main',
    }),
  ).toMatchObject({ kind: 'none' });

  expect(
    resolveAgentAddressing({
      content: 'Use @handles from this list in normal replies.',
      currentAgentId: 'main',
    }),
  ).toMatchObject({ kind: 'none' });
});

test('known body mentions do not address agents', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { resolveAgentAddressing } = await import(
    '../src/gateway/agent-addressing.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({ id: 'research', displayName: 'Research Agent' });

  const resolved = resolveAgentAddressing({
    content: 'Please ask @research to check this',
    currentAgentId: 'main',
  });

  expect(resolved).toMatchObject({ kind: 'none' });

  const punctuated = resolveAgentAddressing({
    content: '@research: check this',
    currentAgentId: 'main',
  });

  expect(punctuated).toMatchObject({
    kind: 'agent',
    agentId: 'research',
    content: 'check this',
  });
});

test('@team and @all resolve to fanout envelopes', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { resolveAgentAddressing } = await import(
    '../src/gateway/agent-addressing.ts'
  );

  initDatabase({ quiet: true });
  upsertRegisteredAgent({ id: 'research' });
  upsertRegisteredAgent({ id: 'writer' });

  const team = resolveAgentAddressing({
    content: '@team status',
    currentAgentId: 'main',
  });
  const all = resolveAgentAddressing({
    content: '@all status',
    currentAgentId: 'main',
  });

  expect(team).toMatchObject({
    kind: 'fanout',
    alias: 'team',
    agentIds: ['research', 'writer'],
    envelope: { to: ['research', 'writer'], fanoutAlias: 'team' },
  });
  expect(all).toMatchObject({
    kind: 'fanout',
    alias: 'all',
    agentIds: ['main', 'research', 'writer'],
    envelope: { to: ['main', 'research', 'writer'], fanoutAlias: 'all' },
  });
});
