import { describe, expect, test, vi } from 'vitest';
import tierRouterPlugin from '../plugins/tier-router/src/index.js';
import {
  classifyRoutingTurn,
  resolveTierRoutingDecision,
} from '../plugins/tier-router/src/routing.js';

const routing = {
  enabled: true,
  tiers: [
    { name: 'economy', models: ['local/small'] },
    { name: 'general', models: ['hai/medium'] },
    { name: 'advanced', models: ['cloud/frontier'] },
  ],
  defaultStart: 'general',
  escalationStickyTurns: 3,
  target: { quality: 0.5, speed: 0.3 },
};

describe('tier-router decision table', () => {
  test.each([
    [{ source: 'heartbeat' }, 'heartbeat'],
    [{ channelType: 'heartbeat' }, 'heartbeat'],
    [{ source: 'scheduler' }, 'scheduler'],
    [{ channelType: 'scheduler' }, 'scheduler'],
    [{ source: 'fullauto' }, 'fullauto'],
    [{ source: 'fullauto.fanout' }, 'fullauto'],
    [{ source: 'discord' }, 'agent'],
  ])('classifies %o as %s', (context, expected) => {
    expect(classifyRoutingTurn(context)).toBe(expected);
  });

  test.each(['heartbeat', 'scheduler', 'fullauto'])(
    '%s turns start on the bottom rung',
    (source) => {
      expect(resolveTierRoutingDecision(routing, { source }, false)).toMatchObject(
        {
          taxonomy: source,
          startTier: 'economy',
          model: 'local/small',
        },
      );
    },
  );

  test('uses an agent model as a start preference and sticky state as a floor', () => {
    expect(
      resolveTierRoutingDecision(
        routing,
        { source: 'discord', agentModel: 'local/small' },
        false,
      ),
    ).toMatchObject({ startTier: 'economy', reason: 'agent-model-start' });
    expect(
      resolveTierRoutingDecision(
        routing,
        {
          source: 'discord',
          agentModel: 'local/small',
          stickyTier: 'advanced',
        },
        false,
      ),
    ).toMatchObject({ startTier: 'advanced', reason: 'sticky-tier' });
  });

  test('applies agent start, skill floor, sticky state, and manual escalation in order', () => {
    expect(
      resolveTierRoutingDecision(
        routing,
        {
          source: 'discord',
          agentRouting: { start: 'economy' },
          skillRouting: { minTier: 'general' },
        },
        false,
      ),
    ).toMatchObject({ startTier: 'general', reason: 'skill-minimum-tier' });
    expect(
      resolveTierRoutingDecision(
        routing,
        {
          source: 'discord',
          agentRouting: { start: 'economy' },
          skillRouting: { minTier: 'general' },
        },
        true,
      ),
    ).toMatchObject({ startTier: 'advanced', reason: 'manual-escalate' });
  });

  test('never routes an explicitly pinned request or session', () => {
    expect(
      resolveTierRoutingDecision(
        routing,
        { source: 'discord', explicitModelPinned: true },
        true,
      ),
    ).toBeNull();
  });
});

test('/escalate raises exactly the next unpinned agent turn', async () => {
  const api = {
    config: { routing },
    registerMiddleware: vi.fn(),
    registerCommand: vi.fn(),
  };
  tierRouterPlugin.register(api);
  const middleware = api.registerMiddleware.mock.calls[0]?.[0];
  const command = api.registerCommand.mock.calls[0]?.[0];
  expect(command.name).toBe('escalate');

  await command.handler([], { sessionId: 'session-1' });
  expect(
    middleware.routing({
      sessionId: 'session-1',
      source: 'heartbeat',
      explicitModelPinned: false,
    }),
  ).toMatchObject({
    metadata: { tierRouter: { startTier: 'economy' } },
  });
  expect(
    middleware.routing({
      sessionId: 'session-1',
      source: 'discord',
      explicitModelPinned: true,
    }),
  ).toEqual({ action: 'allow' });
  const context = {
    sessionId: 'session-1',
    source: 'discord',
    explicitModelPinned: false,
  };
  expect(middleware.routing(context)).toMatchObject({
    metadata: {
      tierRouter: { startTier: 'advanced', reason: 'manual-escalate' },
    },
  });
  expect(middleware.routing(context)).toMatchObject({
    metadata: {
      tierRouter: { startTier: 'general', reason: 'quality-target' },
    },
  });
});
