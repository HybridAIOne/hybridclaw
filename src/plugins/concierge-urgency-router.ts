import {
  type AgentTurnContext,
  applyClassifierMiddleware,
  type ClassifierMiddlewareSkill,
  type MiddlewareOutcome,
  type MiddlewarePhase,
  type MiddlewareRouteDecision,
} from '../agent/middleware.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import {
  type ConciergeProfile,
  parseConciergeChoice,
} from '../gateway/concierge-profiles.js';
import { logger } from '../logger.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import type { ChatMessage } from '../types/api.js';

export const CONCIERGE_URGENCY_ROUTER_TAG = 'concierge_urgency';

export type ConciergeDecision =
  | { kind: 'skip' }
  | { kind: 'ask_user' }
  | { kind: 'pick_profile'; profile: ConciergeProfile };

export interface ConciergeRoutingMiddlewareHost {
  hasMiddleware(phase?: MiddlewarePhase, filter?: { tag?: string }): boolean;
  applyMiddleware(
    phase: MiddlewarePhase,
    context: AgentTurnContext,
    filter?: { tag?: string },
  ): Promise<MiddlewareOutcome>;
}

const LONG_TASK_HINT_RE =
  /\b(create|draft|write|generate|build|produce|prepare|plan|report|proposal|strategy|analysis|marketing plan|presentation|slides?|deck|document|pdf|docx|pptx|xlsx|spreadsheet|roadmap|spec)\b/i;
const ASAP_RE =
  /\b(asap|urgent|immediately|right away|as soon as possible|need it now|right now)\b/i;
const NO_HURRY_RE =
  /\b(no hurry|whenever|take your time|not urgent|can wait|no rush)\b/i;
const BALANCED_RE =
  /\b(can wait a bit|later today|soon but not urgent|not immediately)\b/i;

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

export function inferPromptUrgencyProfile(
  content: string,
): ConciergeProfile | null {
  const normalized = String(content || '').trim();
  if (!normalized) return null;
  if (ASAP_RE.test(normalized)) return 'asap';
  if (NO_HURRY_RE.test(normalized)) return 'no_hurry';
  if (BALANCED_RE.test(normalized)) return 'balanced';
  return null;
}

export function shouldTriggerConcierge(
  content: string,
  opts?: {
    explicitModelPinned?: boolean;
    interactiveOnly?: boolean;
  },
): boolean {
  if (opts?.interactiveOnly === false) return false;
  if (opts?.explicitModelPinned) return false;

  const normalized = String(content || '').trim();
  if (!normalized) return false;
  if (inferPromptUrgencyProfile(normalized)) return false;

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount < 6 && !LONG_TASK_HINT_RE.test(normalized)) return false;

  return LONG_TASK_HINT_RE.test(normalized) || normalized.length >= 140;
}

export function parseConciergeDecision(
  content: string,
): ConciergeDecision | null {
  const trimmed = String(content || '').trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const rawDecision =
    typeof record.decision === 'string'
      ? record.decision
      : typeof record.action === 'string'
        ? record.action
        : '';
  const decision = normalizeToken(rawDecision);
  if (decision === 'skip') return { kind: 'skip' };
  if (decision === 'ask_user') return { kind: 'ask_user' };
  if (decision !== 'pick_profile') return null;

  const rawProfile =
    typeof record.profile === 'string'
      ? record.profile
      : typeof record.mode === 'string'
        ? record.mode
        : '';
  const profile = parseConciergeChoice(rawProfile);
  if (!profile) return null;
  return { kind: 'pick_profile', profile };
}

function conciergeDecisionToRoute(
  decision: ConciergeDecision,
  reason?: string,
): MiddlewareRouteDecision {
  return {
    action: 'route',
    kind: CONCIERGE_URGENCY_ROUTER_TAG,
    decision: decision.kind,
    ...(decision.kind === 'pick_profile' ? { profile: decision.profile } : {}),
    ...(reason ? { reason } : {}),
  };
}

function parseConciergeRouteDecision(
  routing: MiddlewareRouteDecision | undefined,
): ConciergeDecision | null {
  if (!routing || routing.kind !== CONCIERGE_URGENCY_ROUTER_TAG) return null;
  const profile = parseConciergeChoice(routing.profile || '');
  if (profile) return { kind: 'pick_profile', profile };

  const decision = normalizeToken(routing.decision || '');
  if (decision === 'skip') return { kind: 'skip' };
  if (decision === 'ask_user') return { kind: 'ask_user' };
  const decisionProfile = parseConciergeChoice(decision);
  if (decisionProfile)
    return { kind: 'pick_profile', profile: decisionProfile };
  return null;
}

function conciergeDecisionFromMiddlewareOutcome(
  outcome: MiddlewareOutcome,
): ConciergeDecision | null {
  for (const event of outcome.events) {
    const decision = parseConciergeRouteDecision(event.routing);
    if (decision) return decision;
  }
  if (outcome.blocked) return { kind: 'ask_user' };
  return null;
}

export function createConciergeUrgencyRouterMiddlewareSkill(): ClassifierMiddlewareSkill<AgentTurnContext> {
  return {
    id: 'concierge-urgency-router',
    tags: [CONCIERGE_URGENCY_ROUTER_TAG],
    async pre_send(context) {
      const content = context.userContent;
      const inferredProfile = inferPromptUrgencyProfile(content);
      if (inferredProfile) {
        return conciergeDecisionToRoute(
          { kind: 'pick_profile', profile: inferredProfile },
          'Explicit urgency phrase in user request.',
        );
      }

      if (
        !shouldTriggerConcierge(content, {
          explicitModelPinned: false,
          interactiveOnly: true,
        })
      ) {
        return { action: 'allow' };
      }

      const config = getRuntimeConfig();
      const model = config.routing.concierge.model.trim();
      if (!config.routing.concierge.enabled || !model) {
        return conciergeDecisionToRoute(
          { kind: 'ask_user' },
          'Concierge classifier model unavailable.',
        );
      }

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You are a routing concierge for HybridClaw. Decide whether the user should be asked about urgency, or whether the urgency is already clear from the request. Respond with JSON only. Valid shapes: {"decision":"ask_user"} or {"decision":"pick_profile","profile":"asap"} or {"decision":"pick_profile","profile":"balanced"} or {"decision":"pick_profile","profile":"no_hurry"}. Choose pick_profile only when urgency is explicit in the request.',
        },
        {
          role: 'user',
          content,
        },
      ];

      try {
        const result = await callAuxiliaryModel({
          task: 'skills_hub',
          messages,
          fallbackChatbotId: context.chatbotId,
          fallbackEnableRag: false,
          agentId: context.agentId,
          provider: 'auto',
          model,
          maxTokens: 80,
          temperature: 0,
          timeoutMs: 5_000,
        });
        return conciergeDecisionToRoute(
          parseConciergeDecision(result.content) ?? { kind: 'ask_user' },
          'Concierge classifier selected urgency routing.',
        );
      } catch (error) {
        logger.debug(
          { error, model },
          'Concierge routing fell back to ask_user',
        );
        return conciergeDecisionToRoute(
          { kind: 'ask_user' },
          'Concierge classifier failed.',
        );
      }
    },
  };
}

export async function decideConciergeRouting(params: {
  content: string;
  sessionId?: string;
  userId?: string;
  agentId?: string;
  channelId?: string;
  chatbotId?: string;
  model?: string;
  workspacePath?: string;
  pluginManager?: ConciergeRoutingMiddlewareHost | null;
}): Promise<ConciergeDecision> {
  const context: AgentTurnContext = {
    sessionId: params.sessionId || '',
    userId: params.userId,
    agentId: params.agentId || '',
    channelId: params.channelId || '',
    model: params.model,
    chatbotId: params.chatbotId,
    workspacePath: params.workspacePath,
    messages: [{ role: 'user', content: params.content }],
    userContent: params.content,
  };

  if (
    params.pluginManager?.hasMiddleware('pre_send', {
      tag: CONCIERGE_URGENCY_ROUTER_TAG,
    })
  ) {
    try {
      const pluginOutcome = await params.pluginManager.applyMiddleware(
        'pre_send',
        context,
        { tag: CONCIERGE_URGENCY_ROUTER_TAG },
      );
      const pluginDecision =
        conciergeDecisionFromMiddlewareOutcome(pluginOutcome);
      if (pluginDecision) return pluginDecision;
    } catch (error) {
      logger.warn({ error }, 'Concierge urgency middleware failed');
    }
  }

  const builtInOutcome = await applyClassifierMiddleware(
    'pre_send',
    [createConciergeUrgencyRouterMiddlewareSkill()],
    context,
  );
  return (
    conciergeDecisionFromMiddlewareOutcome(builtInOutcome) ?? { kind: 'skip' }
  );
}
