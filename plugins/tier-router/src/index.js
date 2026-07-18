import { classifyRoutingTurn, resolveTierRoutingDecision } from './routing.js';

const MAX_PENDING_ESCALATIONS = 10_000;

export default {
  id: 'tier-router',
  kind: 'middleware',
  register(api) {
    const manualEscalations = new Set();

    api.registerMiddleware({
      id: 'tier-router',
      priority: -100,
      routing(context) {
        const manualEscalate =
          !context.explicitModelPinned &&
          classifyRoutingTurn(context) === 'agent' &&
          manualEscalations.delete(context.sessionId);
        const decision = resolveTierRoutingDecision(
          api.config.routing,
          context,
          manualEscalate,
        );
        if (!decision) return { action: 'allow' };
        return {
          action: 'allow',
          metadata: { tierRouter: decision },
        };
      },
    });

    api.registerCommand({
      name: 'escalate',
      description: 'Start the next unpinned agent turn one routing tier higher',
      handler(_args, context) {
        if (!api.config.routing?.enabled) {
          return 'Model routing is disabled.';
        }
        if (
          !manualEscalations.has(context.sessionId) &&
          manualEscalations.size >= MAX_PENDING_ESCALATIONS
        ) {
          const oldestSessionId = manualEscalations.values().next().value;
          if (oldestSessionId) manualEscalations.delete(oldestSessionId);
        }
        manualEscalations.add(context.sessionId);
        return 'The next agent turn will start one routing tier higher.';
      },
    });
  },
};
