import type { ChatMessage } from '../types/api.js';
import type { ToolExecution } from '../types/execution.js';

export type MiddlewarePhase = 'pre_send' | 'post_receive';

export type EscalationRoute =
  | 'operator'
  | 'security'
  | 'approval_request'
  | 'policy_denial';

export interface AgentTurnContext {
  sessionId: string;
  userId?: string;
  agentId: string;
  channelId: string;
  model?: string;
  workspacePath?: string;
  messages: ChatMessage[];
  userContent: string;
  resultText?: string;
  toolExecutions?: ToolExecution[];
}

export type MiddlewareDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string; payload?: string }
  | { action: 'warn'; reason: string }
  | { action: 'transform'; payload: string; reason: string }
  | { action: 'escalate'; route: EscalationRoute; reason: string };

export interface ClassifierMiddlewareSkill {
  id: string;
  priority?: number;
  pre_send?: (
    context: AgentTurnContext,
  ) =>
    | Promise<MiddlewareDecision | null | undefined>
    | MiddlewareDecision
    | null
    | undefined;
  post_receive?: (
    context: AgentTurnContext,
  ) =>
    | Promise<MiddlewareDecision | null | undefined>
    | MiddlewareDecision
    | null
    | undefined;
}

export interface MiddlewareEvent {
  skillId: string;
  phase: MiddlewarePhase;
  action: MiddlewareDecision['action'];
  reason?: string;
  before?: string;
  after?: string;
  route?: EscalationRoute;
}

export interface MiddlewareOutcome {
  userContent: string;
  resultText: string;
  blocked: boolean;
  events: MiddlewareEvent[];
}

export function getMessageTextContent(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

export function getLatestUserTextContent(
  messages: readonly ChatMessage[],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return getMessageTextContent(message);
  }
  return '';
}

function normalizeDecision(value: unknown): MiddlewareDecision | null {
  if (!value || typeof value !== 'object') return null;
  const action = (value as { action?: unknown }).action;
  if (action === 'allow') return { action };
  if (action === 'block') {
    const reason = String((value as { reason?: unknown }).reason || '').trim();
    const payload = String((value as { payload?: unknown }).payload || '');
    return reason ? { action, reason, ...(payload ? { payload } : {}) } : null;
  }
  if (action === 'warn') {
    const reason = String((value as { reason?: unknown }).reason || '').trim();
    return reason ? { action, reason } : null;
  }
  if (action === 'transform') {
    const payload = String((value as { payload?: unknown }).payload || '');
    const reason = String((value as { reason?: unknown }).reason || '').trim();
    return reason ? { action, payload, reason } : null;
  }
  if (action === 'escalate') {
    const route = (value as { route?: unknown }).route;
    const reason = String((value as { reason?: unknown }).reason || '').trim();
    if (
      (route === 'operator' ||
        route === 'security' ||
        route === 'approval_request' ||
        route === 'policy_denial') &&
      reason
    ) {
      return { action, route, reason };
    }
  }
  return null;
}

export async function applyClassifierMiddleware(
  phase: MiddlewarePhase,
  skills: readonly ClassifierMiddlewareSkill[],
  context: AgentTurnContext,
): Promise<MiddlewareOutcome> {
  const ordered = [...skills].sort((left, right) => {
    const priorityDiff = (left.priority ?? 0) - (right.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    return left.id.localeCompare(right.id);
  });

  const events: MiddlewareEvent[] = [];
  let userContent = context.userContent;
  let resultText = context.resultText || '';

  for (const skill of ordered) {
    const handler = skill[phase];
    if (!handler) continue;

    const currentContext: AgentTurnContext = {
      ...context,
      userContent,
      resultText,
    };
    const decision = normalizeDecision(await handler(currentContext));
    if (!decision || decision.action === 'allow') {
      events.push({ skillId: skill.id, phase, action: 'allow' });
      continue;
    }
    if (decision.action === 'warn') {
      events.push({
        skillId: skill.id,
        phase,
        action: 'warn',
        reason: decision.reason,
      });
      continue;
    }

    const before = phase === 'pre_send' ? userContent : resultText;
    if (decision.action === 'transform') {
      if (!decision.payload.trim()) {
        events.push({
          skillId: skill.id,
          phase,
          action: 'warn',
          reason: `${decision.reason} Empty transform ignored.`,
        });
        continue;
      }
      if (phase === 'pre_send') {
        userContent = decision.payload;
      } else {
        resultText = decision.payload;
      }
      events.push({
        skillId: skill.id,
        phase,
        action: 'transform',
        reason: decision.reason,
        before,
        after: decision.payload,
      });
      continue;
    }

    const replacement =
      decision.action === 'block' && decision.payload
        ? decision.payload
        : decision.reason;
    events.push({
      skillId: skill.id,
      phase,
      action: decision.action,
      reason: decision.reason,
      before,
      after: replacement,
      route: decision.action === 'escalate' ? decision.route : undefined,
    });
    return {
      userContent,
      resultText: replacement,
      blocked: true,
      events,
    };
  }

  return {
    userContent,
    resultText,
    blocked: false,
    events,
  };
}
