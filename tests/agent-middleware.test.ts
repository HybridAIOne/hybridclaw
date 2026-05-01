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
    });
  });
});
