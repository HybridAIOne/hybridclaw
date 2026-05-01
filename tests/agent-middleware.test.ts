import { describe, expect, test } from 'vitest';
import { createConfidentialLeakMiddlewareSkill } from '../src/agent/confidential-middleware.js';
import { applyClassifierMiddleware } from '../src/agent/middleware.js';
import { parseConfidentialYaml } from '../src/security/confidential-rules.js';

describe('agent middleware', () => {
  test('applies post-receive transforms in declared order', async () => {
    const outcome = await applyClassifierMiddleware(
      'post_receive',
      [
        {
          id: 'second',
          priority: 20,
          post_receive: (context) => ({
            action: 'transform',
            payload: `${context.resultText} two`,
            reason: 'second',
          }),
        },
        {
          id: 'first',
          priority: 10,
          post_receive: (context) => ({
            action: 'transform',
            payload: `${context.resultText} one`,
            reason: 'first',
          }),
        },
      ],
      {
        sessionId: 'session-1',
        agentId: 'main',
        channelId: 'tui',
        messages: [],
        userContent: 'hello',
        resultText: 'draft',
      },
    );

    expect(outcome.blocked).toBe(false);
    expect(outcome.resultText).toBe('draft one two');
    expect(outcome.events.map((event) => event.skillId)).toEqual([
      'first',
      'second',
    ]);
  });

  test('keeps message snapshots in sync across transforms', async () => {
    const observedMessages: string[] = [];
    const outcome = await applyClassifierMiddleware(
      'pre_send',
      [
        {
          id: 'first',
          priority: 10,
          pre_send: () => ({
            action: 'transform',
            payload: 'rewritten prompt',
            reason: 'rewrite',
          }),
        },
        {
          id: 'second',
          priority: 20,
          pre_send: (context) => {
            const latestUser = [...context.messages]
              .reverse()
              .find((message) => message.role === 'user');
            observedMessages.push(String(latestUser?.content || ''));
            return { action: 'allow' };
          },
        },
      ],
      {
        sessionId: 'session-1',
        agentId: 'main',
        channelId: 'tui',
        messages: [{ role: 'user', content: 'original prompt' }],
        userContent: 'original prompt',
      },
    );

    expect(outcome.userContent).toBe('rewritten prompt');
    expect(observedMessages).toEqual(['rewritten prompt']);
  });

  test('confidential leak middleware redacts outbound matches', async () => {
    const ruleSet = parseConfidentialYaml(`
clients:
  - name: Serviceplan
    sensitivity: high
    `);
    const middleware = createConfidentialLeakMiddlewareSkill(ruleSet);
    expect(middleware).not.toBeNull();
    if (!middleware) throw new Error('Expected confidential middleware.');

    const outcome = await applyClassifierMiddleware(
      'post_receive',
      [middleware],
      {
        sessionId: 'session-1',
        agentId: 'main',
        channelId: 'tui',
        messages: [],
        userContent: 'hello',
        resultText: 'The account is Serviceplan.',
      },
    );

    expect(outcome.blocked).toBe(false);
    expect(outcome.resultText).toBe('The account is «CONF:CLIENT_001».');
    expect(outcome.events[0]).toMatchObject({
      skillId: 'confidential-leak',
      action: 'transform',
      reason:
        'Confidential output matched 1 high client rule (high, 1 match).',
    });
  });

  test('confidential leak middleware escalates critical outbound matches', async () => {
    const ruleSet = parseConfidentialYaml(`
clients:
  - name: Serviceplan
    sensitivity: critical
`);
    const middleware = createConfidentialLeakMiddlewareSkill(ruleSet);
    if (!middleware) throw new Error('Expected confidential middleware.');

    const outcome = await applyClassifierMiddleware(
      'post_receive',
      [middleware],
      {
        sessionId: 'session-1',
        agentId: 'main',
        channelId: 'tui',
        messages: [],
        userContent: 'hello',
        resultText: 'The account is Serviceplan.',
      },
    );

    expect(outcome.blocked).toBe(true);
    expect(outcome.events[0]).toMatchObject({
      skillId: 'confidential-leak',
      action: 'escalate',
      route: 'security',
      reason:
        'Confidential output matched 1 critical client rule (critical, 1 match).',
    });
    expect(outcome.events[0]?.reason).not.toContain('Serviceplan');
  });
});
