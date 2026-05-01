import { logger } from '../logger.js';
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

export interface ClassifierMiddlewareSkill<TContext = AgentTurnContext> {
  id: string;
  priority?: number;
  pre_send?: (
    context: TContext,
  ) =>
    | Promise<MiddlewareDecision | null | undefined>
    | MiddlewareDecision
    | null
    | undefined;
  post_receive?: (
    context: TContext,
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

const EVENT_TEXT_LIMIT = 500;

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

function replaceMessageTextContent(
  message: ChatMessage,
  text: string,
): ChatMessage {
  if (!Array.isArray(message.content)) {
    return { ...message, content: text };
  }
  let replaced = false;
  const content = message.content.map((part) => {
    if (part.type !== 'text' || replaced) return part;
    replaced = true;
    return { ...part, text };
  });
  return {
    ...message,
    content: replaced ? content : [{ type: 'text', text }, ...content],
  };
}

function syncMessagesForMiddleware(
  phase: MiddlewarePhase,
  messages: readonly ChatMessage[],
  text: string,
): ChatMessage[] {
  const role = phase === 'pre_send' ? 'user' : 'assistant';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== role) continue;
    const next = messages.slice();
    next[index] = replaceMessageTextContent(message, text);
    return next;
  }
  return [...messages, { role, content: text }];
}

function eventText(value: string): string {
  if (value.length <= EVENT_TEXT_LIMIT) return value;
  return `${value.slice(0, EVENT_TEXT_LIMIT)}...`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDecision(
  value: unknown,
  skill: ClassifierMiddlewareSkill,
  phase: MiddlewarePhase,
): MiddlewareDecision | null {
  if (!value) return null;
  if (!isObjectRecord(value)) {
    logger.warn(
      { skillId: skill.id, phase },
      'Middleware returned invalid decision shape; treating as allow',
    );
    return null;
  }

  switch (value.action) {
    case 'allow':
      return { action: 'allow' };
    case 'block': {
      const reason = safeText(value.reason);
      const payload = safeText(value.payload);
      return reason
        ? { action: 'block', reason, ...(payload ? { payload } : {}) }
        : null;
    }
    case 'warn': {
      const reason = safeText(value.reason);
      return reason ? { action: 'warn', reason } : null;
    }
    case 'transform': {
      const payload = safeText(value.payload);
      const reason = safeText(value.reason);
      return reason ? { action: 'transform', payload, reason } : null;
    }
    case 'escalate': {
      const reason = safeText(value.reason);
      if (
        reason &&
        (value.route === 'operator' ||
          value.route === 'security' ||
          value.route === 'approval_request' ||
          value.route === 'policy_denial')
      ) {
        return { action: 'escalate', route: value.route, reason };
      }
      break;
    }
  }

  logger.warn(
    { skillId: skill.id, phase, action: value.action },
    'Middleware returned incomplete or unknown decision; treating as allow',
  );
  return null;
}

export async function applyClassifierMiddleware(
  phase: MiddlewarePhase,
  skills: readonly ClassifierMiddlewareSkill[],
  context: AgentTurnContext,
): Promise<MiddlewareOutcome> {
  const events: MiddlewareEvent[] = [];
  let userContent = context.userContent;
  let resultText = context.resultText || '';
  let messages = context.messages.slice();

  for (const skill of skills) {
    const handler = skill[phase];
    if (!handler) continue;

    const currentContext: AgentTurnContext = {
      ...context,
      messages,
      userContent,
      resultText,
    };
    const decision = normalizeDecision(
      await handler(currentContext),
      skill,
      phase,
    );
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
        messages = syncMessagesForMiddleware(phase, messages, userContent);
      } else {
        resultText = decision.payload;
        messages = syncMessagesForMiddleware(phase, messages, resultText);
      }
      events.push({
        skillId: skill.id,
        phase,
        action: 'transform',
        reason: decision.reason,
        before: eventText(before),
        after: eventText(decision.payload),
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
      before: eventText(before),
      after: eventText(replacement),
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
