import { describe, expect, test } from 'vitest';
import {
  requireTestClientOrg,
  requireTestCoworker,
  SECRET_FIXTURE_CLASSES,
  testSecretSamplesByClass,
  testThreads,
  trustedCoworkerFixtures,
} from './fixtures/trusted-coworker.ts';

describe('trusted coworker test fixtures', () => {
  test('exports the requested fixture families from one module', () => {
    expect(trustedCoworkerFixtures.coworkers).toHaveLength(5);
    expect(trustedCoworkerFixtures.clientOrgs).toHaveLength(3);
    expect(trustedCoworkerFixtures.threads).toHaveLength(10);

    for (const className of SECRET_FIXTURE_CLASSES) {
      expect(testSecretSamplesByClass[className]).toHaveLength(20);
    }

    const secretIds = new Set(
      trustedCoworkerFixtures.secretSamples.map((sample) => sample.id),
    );
    expect(secretIds.size).toBe(SECRET_FIXTURE_CLASSES.length * 20);
  });

  test('roadmap 1.x A2A thread fixtures resolve sender and recipient coworkers', () => {
    const coworkerIds = new Set(
      trustedCoworkerFixtures.coworkers.map((coworker) => coworker.id),
    );
    const threadIds = new Set(testThreads.map((thread) => thread.id));
    expect(threadIds.size).toBe(10);

    for (const thread of testThreads) {
      expect(coworkerIds.has(thread.ownerCoworkerId)).toBe(true);
      const messageIds = new Set(thread.messages.map((message) => message.id));
      for (const message of thread.messages) {
        expect(coworkerIds.has(message.senderCoworkerId)).toBe(true);
        expect(coworkerIds.has(message.recipientCoworkerId)).toBe(true);
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
          owner_coworker_id: requireTestCoworker('coworker_briefing').id,
          action: `Brief ${clientOrg.launchCodename}`,
          stakes_threshold: 'medium',
        },
        {
          id: 'build',
          owner_coworker_id: requireTestCoworker('coworker_builder').id,
          action: 'Build approved artifact',
          stakes_threshold: 'medium',
        },
        {
          id: 'review',
          owner_coworker_id: requireTestCoworker('coworker_reviewer').id,
          action: 'Review output before client update',
          stakes_threshold: 'high',
        },
      ],
      transitions: [
        { from: 'brief', to: 'build' },
        { from: 'build', to: 'review' },
      ],
    };
    const coworkerIds = new Set(
      trustedCoworkerFixtures.coworkers.map((coworker) => coworker.id),
    );

    expect(
      workflow.steps.every((step) => coworkerIds.has(step.owner_coworker_id)),
    ).toBe(true);
    expect(workflow.steps.map((step) => step.owner_coworker_id)).toEqual([
      'coworker_briefing',
      'coworker_builder',
      'coworker_reviewer',
    ]);
    expect(workflow.steps[2].stakes_threshold).toBe('high');
  });
});
