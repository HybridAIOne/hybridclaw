import { logger } from '../logger.js';
import type { SkillExecutionOutcome } from '../skills/adaptive-skills-types.js';
import {
  type RuntimeEventPayload,
  type SkillRunEvent,
  subscribeRuntimeEvents,
  subscribeSkillRunEvents,
} from '../skills/skill-run-events.js';
import {
  type JudgeTraceOptions,
  type JudgeTraceResult,
  judgeTrace,
} from './trace-judge.js';
import { normalizePositiveInteger } from './trace-preparation.js';

export type JudgeSubscriberFilter =
  | ((event: SkillRunEvent | RuntimeEventPayload) => boolean)
  | {
      skillId?: JudgeSubscriberStringMatcher;
      agentId?: JudgeSubscriberNullableStringMatcher;
      sessionId?: JudgeSubscriberStringMatcher;
      outcome?: SkillExecutionOutcome | readonly SkillExecutionOutcome[];
    };

export type JudgeSubscriberStringMatcher = string | RegExp;

export type JudgeSubscriberNullableStringMatcher =
  JudgeSubscriberStringMatcher | null;

export type JudgeSubscriberStaticCriteria =
  | string
  | number
  | boolean
  | null
  | readonly unknown[]
  | Record<string, unknown>;

export type JudgeSubscriberCriteria =
  | JudgeSubscriberStaticCriteria
  | ((event: SkillRunEvent) => unknown | Promise<unknown>);

export interface JudgeSubscriberBudget {
  /** Chargeback agent id for the feature consuming this judge subscription. */
  agentId: string | ((event: SkillRunEvent) => string | null | undefined);
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

export interface RuntimeJudgeSubscriberSinkPayload {
  subscriberId: string;
  event: RuntimeEventPayload;
  judgedAt: string;
}

export type RuntimeJudgeSubscriberSink = (
  payload: RuntimeJudgeSubscriberSinkPayload,
) => unknown | Promise<unknown>;

interface BaseJudgeSubscriberInput {
  id?: string;
  /** Debounce window for bursty events; useful in tests and low-latency consumers. */
  debounceMs?: number;
  /** Per-subscriber bounded backlog to prevent judge work from growing without limit. */
  maxQueueSize?: number;
}

export interface SkillRunJudgeSubscriberInput extends BaseJudgeSubscriberInput {
  filter: JudgeSubscriberFilter;
  criteria: JudgeSubscriberCriteria;
  sink: JudgeSubscriberSink;
  runtimeEventType?: never;
  runtimeSink?: never;
  budget?: JudgeSubscriberBudget;
  judgeOptions?: Omit<JudgeTraceOptions, 'usageContext'> & {
    usageContext?: never;
  };
}

export interface RuntimeJudgeSubscriberInput extends BaseJudgeSubscriberInput {
  filter?: JudgeSubscriberFilter;
  runtimeEventType: string;
  runtimeSink: RuntimeJudgeSubscriberSink;
  criteria?: never;
  sink?: never;
  budget?: never;
  judgeOptions?: never;
}

export type RegisterJudgeSubscriberInput =
  | SkillRunJudgeSubscriberInput
  | RuntimeJudgeSubscriberInput;

export interface GoalJudgeEvent extends RuntimeEventPayload {
  type: 'goal_judge';
  request_id: string;
  session_id: string;
  agent_id: string;
  thread_id: string | null;
  goal_text: string;
  assistant_response: string;
  fallback_model?: string | null;
  created_at: string;
}

interface ActiveJudgeSubscriber {
  id: string;
  input: RegisterJudgeSubscriberInput;
  debounceMs: number;
  maxQueueSize: number;
  pending: RuntimeEventPayload[];
  timer: NodeJS.Timeout | null;
  work: Promise<void>;
  unsubscribe: () => void;
  stopped: boolean;
}

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_MAX_QUEUE_SIZE = 100;
const MAX_IDLE_FLUSH_ITERATIONS = 100;

const activeSubscribers = new Set<ActiveJudgeSubscriber>();
let nextSubscriberNumber = 1;

export function registerJudgeSubscriber(
  input: RegisterJudgeSubscriberInput,
): () => void {
  validateJudgeSubscriberInput(input);
  const id = normalizeSubscriberId(input.id);
  const maxQueueSize = normalizePositiveInteger(
    input.maxQueueSize,
    DEFAULT_MAX_QUEUE_SIZE,
    'Judge subscriber maxQueueSize',
  );
  const debounceMs = normalizeDebounceMs(input.debounceMs);
  const subscriber: ActiveJudgeSubscriber = {
    id,
    input,
    debounceMs,
    maxQueueSize,
    pending: [],
    timer: null,
    work: Promise.resolve(),
    unsubscribe: () => {},
    stopped: false,
  };

  subscriber.unsubscribe = input.runtimeEventType
    ? subscribeRuntimeEvents((event) => {
        if (event.type !== input.runtimeEventType) return;
        enqueueJudgeSubscriberEvent(subscriber, event);
      })
    : subscribeSkillRunEvents((event) => {
        enqueueJudgeSubscriberEvent(subscriber, event);
      });
  activeSubscribers.add(subscriber);

  return () => {
    // In-flight judgeTrace calls cannot be aborted yet; unsubscribe prevents
    // queued work and sink delivery after the current awaited step completes.
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

function validateJudgeSubscriberInput(
  input: RegisterJudgeSubscriberInput,
): void {
  if (input.runtimeEventType) {
    if (!input.runtimeSink) {
      throw new Error('Runtime judge subscribers require runtimeSink.');
    }
    return;
  }
  if (!input.filter || !input.criteria || !input.sink) {
    throw new Error('Judge subscribers require filter, criteria, and sink.');
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
  event: RuntimeEventPayload,
): void {
  if (subscriber.stopped || !matchesJudgeSubscriberFilter(subscriber, event)) {
    return;
  }

  if (subscriber.pending.length >= subscriber.maxQueueSize) {
    logger.warn(
      {
        subscriberId: subscriber.id,
        sessionId: resolveEventSessionId(event),
        eventType: event.type,
        maxQueueSize: subscriber.maxQueueSize,
      },
      'Judge subscriber queue full, dropping runtime event',
    );
    return;
  }

  subscriber.pending.push(event);
  scheduleJudgeSubscriberDrain(subscriber);
}

function scheduleJudgeSubscriberDrain(subscriber: ActiveJudgeSubscriber): void {
  if (subscriber.timer) clearTimeout(subscriber.timer);
  subscriber.timer = setTimeout(() => {
    subscriber.timer = null;
    void drainJudgeSubscriber(subscriber);
  }, subscriber.debounceMs);
  if (typeof subscriber.timer.unref === 'function') {
    subscriber.timer.unref();
  }
}

async function flushJudgeSubscriber(
  subscriber: ActiveJudgeSubscriber,
): Promise<void> {
  let iterations = 0;
  while (!subscriber.stopped) {
    iterations += 1;
    if (iterations > MAX_IDLE_FLUSH_ITERATIONS) {
      throw new Error(
        `Judge subscriber ${subscriber.id} did not become idle after ${MAX_IDLE_FLUSH_ITERATIONS} flush iterations.`,
      );
    }
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
  event: RuntimeEventPayload,
): Promise<void> {
  try {
    if (subscriber.stopped) return;
    if (subscriber.input.runtimeSink) {
      await runRuntimeJudgeSubscriberEvent(subscriber, event);
      return;
    }
    const skillRunEvent = event as SkillRunEvent;
    const criteriaResolver = subscriber.input.criteria;
    const sink = subscriber.input.sink;
    if (!criteriaResolver || !sink) return;
    const criteria =
      typeof criteriaResolver === 'function'
        ? await criteriaResolver(skillRunEvent)
        : criteriaResolver;
    if (subscriber.stopped) return;
    const judgedAt = new Date().toISOString();
    const result = await judgeTrace(skillRunEvent, criteria, {
      ...subscriber.input.judgeOptions,
      usageContext: {
        sessionId: skillRunEvent.session_id,
        agentId: resolveBudgetAgentId(subscriber, skillRunEvent),
        timestamp: judgedAt,
      },
    });
    if (subscriber.stopped) return;
    await sink({
      subscriberId: subscriber.id,
      event: skillRunEvent,
      criteria,
      result,
      judgedAt,
    });
  } catch (error) {
    logger.warn(
      {
        subscriberId: subscriber.id,
        sessionId: resolveEventSessionId(event),
        eventType: event.type,
        error,
      },
      'Judge subscriber failed for runtime event',
    );
  }
}

async function runRuntimeJudgeSubscriberEvent(
  subscriber: ActiveJudgeSubscriber,
  event: RuntimeEventPayload,
): Promise<void> {
  if (!subscriber.input.runtimeSink) return;
  const judgedAt = new Date().toISOString();
  await subscriber.input.runtimeSink({
    subscriberId: subscriber.id,
    event,
    judgedAt,
  });
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

function matchesJudgeSubscriberFilter(
  subscriber: ActiveJudgeSubscriber,
  event: RuntimeEventPayload,
): boolean {
  const filter = subscriber.input.filter;
  if (!filter) return true;
  if (typeof filter === 'function') return filter(event);
  if (subscriber.input.runtimeEventType) {
    if (
      filter.agentId !== undefined &&
      !matchesNullableString(filter.agentId, resolveEventAgentId(event))
    ) {
      return false;
    }
    if (
      filter.sessionId !== undefined &&
      !matchesString(filter.sessionId, resolveEventSessionId(event))
    ) {
      return false;
    }
    return true;
  }
  const skillRunEvent = event as SkillRunEvent;
  if (
    filter.skillId !== undefined &&
    !matchesString(filter.skillId, skillRunEvent.skill_id)
  ) {
    return false;
  }
  if (
    filter.agentId !== undefined &&
    !matchesNullableString(filter.agentId, skillRunEvent.agent_id)
  ) {
    return false;
  }
  if (
    filter.sessionId !== undefined &&
    !matchesString(filter.sessionId, skillRunEvent.session_id)
  ) {
    return false;
  }
  if (
    filter.outcome !== undefined &&
    !matchesOutcome(filter.outcome, skillRunEvent.outcome)
  ) {
    return false;
  }
  return true;
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
  matcher.lastIndex = 0;
  return matcher.test(value);
}

function matchesOutcome(
  matcher: SkillExecutionOutcome | readonly SkillExecutionOutcome[],
  value: SkillExecutionOutcome,
): boolean {
  return Array.isArray(matcher) ? matcher.includes(value) : matcher === value;
}

function normalizeDebounceMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DEBOUNCE_MS;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      'Judge subscriber debounceMs must be a non-negative number.',
    );
  }
  return Math.floor(value);
}

function resolveEventSessionId(event: RuntimeEventPayload): string {
  return typeof event.session_id === 'string' ? event.session_id : 'unknown';
}

function resolveEventAgentId(event: RuntimeEventPayload): string | null {
  return typeof event.agent_id === 'string' ? event.agent_id : null;
}
