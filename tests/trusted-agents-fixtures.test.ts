import { describe, expect, test } from 'vitest';
import {
  requireTestAgent,
  requireTestClientOrg,
  SECRET_FIXTURE_CLASSES,
  testClientOrgs,
  testSecretSamples,
  testSecretSamplesByClass,
  testThreads,
  trustedAgentsFixtures,
} from './fixtures/trusted-agents.ts';

describe('trusted agents test fixtures', () => {
  test('exports the requested fixture families from one module', () => {
    expect(trustedAgentsFixtures.agents).toHaveLength(5);
    expect(trustedAgentsFixtures.clientOrgs).toHaveLength(3);
    expect(trustedAgentsFixtures.threads).toHaveLength(10);

    for (const className of SECRET_FIXTURE_CLASSES) {
      expect(testSecretSamplesByClass[className]).toHaveLength(20);
    }

    const secretIds = new Set(
      trustedAgentsFixtures.secretSamples.map((sample) => sample.id),
    );
    expect(secretIds.size).toBe(SECRET_FIXTURE_CLASSES.length * 20);

    const clientOrgIds = new Set(
      testClientOrgs.map((clientOrg) => clientOrg.id),
    );
    expect(
      testSecretSamples.every((sample) => clientOrgIds.has(sample.clientOrgId)),
    ).toBe(true);
    expect(
      testSecretSamplesByClass.client.find((sample) => sample.value === 'AWL')
        ?.clientOrgId,
    ).toBe('client_aster');
    expect(
      testSecretSamplesByClass.nda.find((sample) =>
        sample.value.includes('DR-ASTER-001'),
      )?.clientOrgId,
    ).toBe('client_aster');
  });

  test('roadmap 1.x A2A thread fixtures resolve sender and recipient agents', () => {
    const agentIds = new Set(
      trustedAgentsFixtures.agents.map((agent) => agent.id),
    );
    const clientOrgIds = new Set(
      trustedAgentsFixtures.clientOrgs.map((clientOrg) => clientOrg.id),
    );
    const threadIds = new Set(testThreads.map((thread) => thread.id));
    expect(threadIds.size).toBe(10);

    for (const thread of testThreads) {
      expect(agentIds.has(thread.ownerAgentId)).toBe(true);
      expect(clientOrgIds.has(thread.clientOrgId)).toBe(true);
      const messageIds = new Set(thread.messages.map((message) => message.id));
      for (const message of thread.messages) {
        expect(agentIds.has(message.senderAgentId)).toBe(true);
        expect(agentIds.has(message.recipientAgentId)).toBe(true);
        if (message.parentMessageId) {
          expect(messageIds.has(message.parentMessageId)).toBe(true);
        }
      }
    }

    expect(
      testThreads.some((thread) =>
        thread.messages.some((message) => message.intent === 'handoff'),
      ),
    ).toBe(true);
  });

  test('roadmap 2.x workflow fixtures can model brief, build, and review ownership', () => {
    const clientOrg = requireTestClientOrg('client_aster');
    const workflow = {
      id: 'workflow_fixture_launch_package',
      name: 'Fixture launch package workflow',
      steps: [
        {
          id: 'brief',
          owner_agent_id: requireTestAgent('agent_briefing').id,
          action: `Brief ${clientOrg.launchCodename}`,
          stakes_threshold: 'medium',
        },
        {
          id: 'build',
          owner_agent_id: requireTestAgent('agent_builder').id,
          action: 'Build approved artifact',
          stakes_threshold: 'medium',
        },
        {
          id: 'review',
          owner_agent_id: requireTestAgent('agent_reviewer').id,
          action: 'Review output before client update',
          stakes_threshold: 'high',
        },
      ],
      transitions: [
        { from: 'brief', to: 'build' },
        { from: 'build', to: 'review' },
      ],
    };
    const agentIds = new Set(
      trustedAgentsFixtures.agents.map((agent) => agent.id),
    );

    expect(
      workflow.steps.every((step) => agentIds.has(step.owner_agent_id)),
    ).toBe(true);
    expect(workflow.steps.map((step) => step.owner_agent_id)).toEqual([
      'agent_briefing',
      'agent_builder',
      'agent_reviewer',
    ]);
    expect(workflow.steps[2].stakes_threshold).toBe('high');
  });
});
