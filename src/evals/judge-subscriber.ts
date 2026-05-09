import { logger } from '../logger.js';
import type { SkillExecutionOutcome } from '../skills/adaptive-skills-types.js';
import {
  type SkillRunEvent,
  subscribeSkillRunEvents,
} from '../skills/skill-run-events.js';
import {
  type JudgeTraceOptions,
  type JudgeTraceResult,
  judgeTrace,
} from './trace-judge.js';

export type JudgeSubscriberFilter =
  | ((event: SkillRunEvent) => boolean)
  | {
      skillId?: JudgeSubscriberStringMatcher;
      agentId?: JudgeSubscriberNullableStringMatcher;
      sessionId?: JudgeSubscriberStringMatcher;
      outcome?: SkillExecutionOutcome | readonly SkillExecutionOutcome[];
    };

export type JudgeSubscriberStringMatcher = string | RegExp | readonly string[];

export type JudgeSubscriberNullableStringMatcher =
  JudgeSubscriberStringMatcher | null;

export type JudgeSubscriberCriteria =
  | unknown
  | ((event: SkillRunEvent) => unknown | Promise<unknown>);

export interface JudgeSubscriberBudget {
  /** Chargeback agent id for the feature consuming this judge subscription. */
  agentId: string | ((event: SkillRunEvent) => string | null | undefined);
  sessionId?: string | ((event: SkillRunEvent) => string | null | undefined);
}

export interface JudgeSubscriberSinkPayload {
  subscriberId: string;
  event: SkillRunEvent;
  criteria: unknown;
  result: JudgeTraceResult;
  judgedAt: string;
}

export type JudgeSubscriberSink = (
  payload: JudgeSubscriberSinkPayload,
) => unknown | Promise<unknown>;

export interface RegisterJudgeSubscriberInput {
  id?: string;
  filter: JudgeSubscriberFilter;
  criteria: JudgeSubscriberCriteria;
  sink: JudgeSubscriberSink;
  budget?: JudgeSubscriberBudget;
  judgeOptions?: Omit<JudgeTraceOptions, 'usageContext'> & {
    usageContext?: never;
  };
  debounceMs?: number;
  maxQueueSize?: number;
}

interface ActiveJudgeSubscriber {
  id: string;
  input: RegisterJudgeSubscriberInput;
  pending: SkillRunEvent[];
  timer: NodeJS.Timeout | null;
  work: Promise<void>;
  unsubscribe: () => void;
  stopped: boolean;
}

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_MAX_QUEUE_SIZE = 100;

const activeSubscribers = new Set<ActiveJudgeSubscriber>();
let nextSubscriberNumber = 1;

export function registerJudgeSubscriber(
  input: RegisterJudgeSubscriberInput,
): () => void {
  const id = normalizeSubscriberId(input.id);
  const subscriber: ActiveJudgeSubscriber = {
    id,
    input,
    pending: [],
    timer: null,
    work: Promise.resolve(),
    unsubscribe: () => {},
    stopped: false,
  };

  subscriber.unsubscribe = subscribeSkillRunEvents((event) => {
    enqueueJudgeSubscriberEvent(subscriber, event);
  });
  activeSubscribers.add(subscriber);

  return () => {
    subscriber.stopped = true;
    subscriber.unsubscribe();
    if (subscriber.timer) clearTimeout(subscriber.timer);
    subscriber.timer = null;
    subscriber.pending = [];
    activeSubscribers.delete(subscriber);
  };
}

export async function waitForJudgeSubscribersIdle(): Promise<void> {
  for (const subscriber of activeSubscribers) {
    await flushJudgeSubscriber(subscriber);
  }
}

function normalizeSubscriberId(id: string | undefined): string {
  const trimmed = id?.trim();
  if (trimmed) return trimmed;
  const generated = `judge-subscriber-${nextSubscriberNumber}`;
  nextSubscriberNumber += 1;
  return generated;
}

function enqueueJudgeSubscriberEvent(
  subscriber: ActiveJudgeSubscriber,
  event: SkillRunEvent,
): void {
  if (subscriber.stopped || !matchesJudgeSubscriberFilter(subscriber, event)) {
    return;
  }

  const maxQueueSize = normalizePositiveInteger(
    subscriber.input.maxQueueSize,
    DEFAULT_MAX_QUEUE_SIZE,
  );
  if (subscriber.pending.length >= maxQueueSize) {
    logger.warn(
      {
        subscriberId: subscriber.id,
        sessionId: event.session_id,
        runId: event.run_id,
        skillId: event.skill_id,
        maxQueueSize,
      },
      'Judge subscriber queue full, dropping skill_run event',
    );
    return;
  }

  subscriber.pending.push(event);
  scheduleJudgeSubscriberDrain(subscriber);
}

function scheduleJudgeSubscriberDrain(subscriber: ActiveJudgeSubscriber): void {
  if (subscriber.timer) clearTimeout(subscriber.timer);
  const debounceMs = normalizeNonNegativeInteger(
    subscriber.input.debounceMs,
    DEFAULT_DEBOUNCE_MS,
  );
  subscriber.timer = setTimeout(() => {
    subscriber.timer = null;
    void drainJudgeSubscriber(subscriber);
  }, debounceMs);
  if (typeof subscriber.timer.unref === 'function') {
    subscriber.timer.unref();
  }
}

async function flushJudgeSubscriber(
  subscriber: ActiveJudgeSubscriber,
): Promise<void> {
  while (!subscriber.stopped) {
    if (subscriber.timer) clearTimeout(subscriber.timer);
    subscriber.timer = null;
    if (subscriber.pending.length === 0) {
      await subscriber.work;
      if (subscriber.pending.length === 0) return;
    }
    await drainJudgeSubscriber(subscriber);
  }
}

function drainJudgeSubscriber(
  subscriber: ActiveJudgeSubscriber,
): Promise<void> {
  subscriber.work = subscriber.work
    .then(async () => {
      const events = subscriber.pending.splice(0, subscriber.pending.length);
      for (const event of events) {
        if (subscriber.stopped) break;
        await runJudgeSubscriberEvent(subscriber, event);
      }
    })
    .catch((error) => {
      logger.warn(
        { subscriberId: subscriber.id, error },
        'Judge subscriber drain failed',
      );
    });
  return subscriber.work;
}

async function runJudgeSubscriberEvent(
  subscriber: ActiveJudgeSubscriber,
  event: SkillRunEvent,
): Promise<void> {
  try {
    if (subscriber.stopped) return;
    const criteria = await resolveJudgeSubscriberCriteria(
      subscriber.input.criteria,
      event,
    );
    if (subscriber.stopped) return;
    const judgedAt = new Date().toISOString();
    const result = await judgeTrace(event, criteria, {
      ...subscriber.input.judgeOptions,
      usageContext: {
        sessionId: resolveBudgetSessionId(subscriber, event),
        agentId: resolveBudgetAgentId(subscriber, event),
        timestamp: judgedAt,
      },
    });
    if (subscriber.stopped) return;
    await subscriber.input.sink({
      subscriberId: subscriber.id,
      event,
      criteria,
      result,
      judgedAt,
    });
  } catch (error) {
    logger.warn(
      {
        subscriberId: subscriber.id,
        sessionId: event.session_id,
        runId: event.run_id,
        skillId: event.skill_id,
        error,
      },
      'Judge subscriber failed for skill_run event',
    );
  }
}

function resolveBudgetAgentId(
  subscriber: ActiveJudgeSubscriber,
  event: SkillRunEvent,
): string {
  const budgetAgentId = resolveBudgetValue(
    subscriber.input.budget?.agentId,
    event,
  );
  return budgetAgentId || `judge-subscriber:${subscriber.id}`;
}

function resolveBudgetSessionId(
  subscriber: ActiveJudgeSubscriber,
  event: SkillRunEvent,
): string {
  return (
    resolveBudgetValue(subscriber.input.budget?.sessionId, event) ||
    event.session_id
  );
}

function resolveBudgetValue(
  value:
    | string
    | ((event: SkillRunEvent) => string | null | undefined)
    | null
    | undefined,
  event: SkillRunEvent,
): string | null {
  const resolved = typeof value === 'function' ? value(event) : value;
  const trimmed = resolved?.trim();
  return trimmed || null;
}

async function resolveJudgeSubscriberCriteria(
  criteria: JudgeSubscriberCriteria,
  event: SkillRunEvent,
): Promise<unknown> {
  if (typeof criteria === 'function') {
    return await criteria(event);
  }
  return criteria;
}

function matchesJudgeSubscriberFilter(
  subscriber: ActiveJudgeSubscriber,
  event: SkillRunEvent,
): boolean {
  try {
    const filter = subscriber.input.filter;
    if (typeof filter === 'function') return filter(event);
    if (
      filter.skillId !== undefined &&
      !matchesString(filter.skillId, event.skill_id)
    ) {
      return false;
    }
    if (
      filter.agentId !== undefined &&
      !matchesNullableString(filter.agentId, event.agent_id)
    ) {
      return false;
    }
    if (
      filter.sessionId !== undefined &&
      !matchesString(filter.sessionId, event.session_id)
    ) {
      return false;
    }
    if (
      filter.outcome !== undefined &&
      !matchesOutcome(filter.outcome, event.outcome)
    ) {
      return false;
    }
    return true;
  } catch (error) {
    logger.warn(
      {
        subscriberId: subscriber.id,
        sessionId: event.session_id,
        runId: event.run_id,
        skillId: event.skill_id,
        error,
      },
      'Judge subscriber filter failed for skill_run event',
    );
    return false;
  }
}

function matchesNullableString(
  matcher: JudgeSubscriberNullableStringMatcher,
  value: string | null,
): boolean {
  if (matcher === null) return value === null;
  return value !== null && matchesString(matcher, value);
}

function matchesString(
  matcher: JudgeSubscriberStringMatcher,
  value: string,
): boolean {
  if (typeof matcher === 'string') return matcher === value;
  if (!(matcher instanceof RegExp)) return matcher.includes(value);
  matcher.lastIndex = 0;
  return matcher.test(value);
}

function matchesOutcome(
  matcher: SkillExecutionOutcome | readonly SkillExecutionOutcome[],
  value: SkillExecutionOutcome,
): boolean {
  return Array.isArray(matcher) ? matcher.includes(value) : matcher === value;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}
