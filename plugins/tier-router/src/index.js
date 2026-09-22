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
          api.getRoutingConfig(),
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
      handler(args, context) {
        if (!api.getRoutingConfig()?.enabled) {
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
        if (args.length > 0) {
          return {
            kind: 'plain',
            text: 'Starting one routing tier higher.',
            continueWithMessage: true,
          };
        }
        return 'The next agent turn will start one routing tier higher.';
      },
    });
  },
};
