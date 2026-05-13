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
  | ((event: SkillRunEvent) => boolean)
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

export interface RegisterJudgeSubscriberInput {
  id?: string;
  filter: JudgeSubscriberFilter;
  criteria: JudgeSubscriberCriteria;
  sink: JudgeSubscriberSink;
  budget?: JudgeSubscriberBudget;
  judgeOptions?: Omit<JudgeTraceOptions, 'usageContext'> & {
    usageContext?: never;
  };
  /** Debounce window for bursty skill_run events; useful in tests and low-latency consumers. */
  debounceMs?: number;
  /** Per-subscriber bounded backlog to prevent judge work from growing without limit. */
  maxQueueSize?: number;
}

export interface GoalJudgeEvent extends RuntimeEventPayload {
  type: 'goal_judge';
  request_id: string;
  session_id: string;
  agent_id: string;
  thread_id: string | null;
  goal_text: string;
  assistant_response: string;
  created_at: string;
}

export type GoalJudgeSubscriberFilter =
  | ((event: GoalJudgeEvent) => boolean)
  | {
      agentId?: JudgeSubscriberStringMatcher;
      sessionId?: JudgeSubscriberStringMatcher;
    };

export interface GoalJudgeSubscriberSinkPayload {
  subscriberId: string;
  event: GoalJudgeEvent;
  judgedAt: string;
}

export type GoalJudgeSubscriberSink = (
  payload: GoalJudgeSubscriberSinkPayload,
) => unknown | Promise<unknown>;

export interface RegisterGoalJudgeSubscriberInput {
  id?: string;
  filter?: GoalJudgeSubscriberFilter;
  sink: GoalJudgeSubscriberSink;
  /** Debounce window for bursty goal_judge events; useful in tests and low-latency consumers. */
  debounceMs?: number;
  /** Per-subscriber bounded backlog to prevent judge work from growing without limit. */
  maxQueueSize?: number;
}

interface ActiveJudgeSubscriber {
  id: string;
  input: RegisterJudgeSubscriberInput;
  debounceMs: number;
  maxQueueSize: number;
  pending: SkillRunEvent[];
  timer: NodeJS.Timeout | null;
  work: Promise<void>;
  unsubscribe: () => void;
  stopped: boolean;
}

interface ActiveGoalJudgeSubscriber {
  id: string;
  input: RegisterGoalJudgeSubscriberInput;
  debounceMs: number;
  maxQueueSize: number;
  pending: GoalJudgeEvent[];
  timer: NodeJS.Timeout | null;
  work: Promise<void>;
  unsubscribe: () => void;
  stopped: boolean;
}

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_MAX_QUEUE_SIZE = 100;
const MAX_IDLE_FLUSH_ITERATIONS = 100;

const activeSubscribers = new Set<ActiveJudgeSubscriber>();
const activeGoalJudgeSubscribers = new Set<ActiveGoalJudgeSubscriber>();
let nextSubscriberNumber = 1;

export function registerJudgeSubscriber(
  input: RegisterJudgeSubscriberInput,
): () => void {
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

  subscriber.unsubscribe = subscribeSkillRunEvents((event) => {
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

export function registerGoalJudgeSubscriber(
  input: RegisterGoalJudgeSubscriberInput,
): () => void {
  const id = normalizeSubscriberId(input.id);
  const maxQueueSize = normalizePositiveInteger(
    input.maxQueueSize,
    DEFAULT_MAX_QUEUE_SIZE,
    'Goal judge subscriber maxQueueSize',
  );
  const debounceMs = normalizeDebounceMs(input.debounceMs);
  const subscriber: ActiveGoalJudgeSubscriber = {
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

  subscriber.unsubscribe = subscribeRuntimeEvents((event) => {
    if (event.type !== 'goal_judge') return;
    enqueueGoalJudgeSubscriberEvent(subscriber, event as GoalJudgeEvent);
  });
  activeGoalJudgeSubscribers.add(subscriber);

  return () => {
    subscriber.stopped = true;
    subscriber.unsubscribe();
    if (subscriber.timer) clearTimeout(subscriber.timer);
    subscriber.timer = null;
    subscriber.pending = [];
    activeGoalJudgeSubscribers.delete(subscriber);
  };
}

export async function waitForJudgeSubscribersIdle(): Promise<void> {
  for (const subscriber of activeSubscribers) {
    await flushJudgeSubscriber(subscriber);
  }
  for (const subscriber of activeGoalJudgeSubscribers) {
    await flushGoalJudgeSubscriber(subscriber);
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

  if (subscriber.pending.length >= subscriber.maxQueueSize) {
    logger.warn(
      {
        subscriberId: subscriber.id,
        sessionId: event.session_id,
        runId: event.run_id,
        skillId: event.skill_id,
        maxQueueSize: subscriber.maxQueueSize,
      },
      'Judge subscriber queue full, dropping skill_run event',
    );
    return;
  }

  subscriber.pending.push(event);
  scheduleJudgeSubscriberDrain(subscriber);
}

function enqueueGoalJudgeSubscriberEvent(
  subscriber: ActiveGoalJudgeSubscriber,
  event: GoalJudgeEvent,
): void {
  if (
    subscriber.stopped ||
    !matchesGoalJudgeSubscriberFilter(subscriber, event)
  ) {
    return;
  }

  if (subscriber.pending.length >= subscriber.maxQueueSize) {
    logger.warn(
      {
        subscriberId: subscriber.id,
        sessionId: event.session_id,
        requestId: event.request_id,
        maxQueueSize: subscriber.maxQueueSize,
      },
      'Goal judge subscriber queue full, dropping goal_judge event',
    );
    return;
  }

  subscriber.pending.push(event);
  scheduleGoalJudgeSubscriberDrain(subscriber);
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

function scheduleGoalJudgeSubscriberDrain(
  subscriber: ActiveGoalJudgeSubscriber,
): void {
  if (subscriber.timer) clearTimeout(subscriber.timer);
  subscriber.timer = setTimeout(() => {
    subscriber.timer = null;
    void drainGoalJudgeSubscriber(subscriber);
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

async function flushGoalJudgeSubscriber(
  subscriber: ActiveGoalJudgeSubscriber,
): Promise<void> {
  let iterations = 0;
  while (!subscriber.stopped) {
    iterations += 1;
    if (iterations > MAX_IDLE_FLUSH_ITERATIONS) {
      throw new Error(
        `Goal judge subscriber ${subscriber.id} did not become idle after ${MAX_IDLE_FLUSH_ITERATIONS} flush iterations.`,
      );
    }
    if (subscriber.timer) clearTimeout(subscriber.timer);
    subscriber.timer = null;
    if (subscriber.pending.length === 0) {
      await subscriber.work;
      if (subscriber.pending.length === 0) return;
    }
    await drainGoalJudgeSubscriber(subscriber);
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

function drainGoalJudgeSubscriber(
  subscriber: ActiveGoalJudgeSubscriber,
): Promise<void> {
  subscriber.work = subscriber.work
    .then(async () => {
      const events = subscriber.pending.splice(0, subscriber.pending.length);
      for (const event of events) {
        if (subscriber.stopped) break;
        await runGoalJudgeSubscriberEvent(subscriber, event);
      }
    })
    .catch((error) => {
      logger.warn(
        { subscriberId: subscriber.id, error },
        'Goal judge subscriber drain failed',
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
    const criteria =
      typeof subscriber.input.criteria === 'function'
        ? await subscriber.input.criteria(event)
        : subscriber.input.criteria;
    if (subscriber.stopped) return;
    const judgedAt = new Date().toISOString();
    const result = await judgeTrace(event, criteria, {
      ...subscriber.input.judgeOptions,
      usageContext: {
        sessionId: event.session_id,
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

async function runGoalJudgeSubscriberEvent(
  subscriber: ActiveGoalJudgeSubscriber,
  event: GoalJudgeEvent,
): Promise<void> {
  try {
    if (subscriber.stopped) return;
    const judgedAt = new Date().toISOString();
    await subscriber.input.sink({
      subscriberId: subscriber.id,
      event,
      judgedAt,
    });
  } catch (error) {
    logger.warn(
      {
        subscriberId: subscriber.id,
        sessionId: event.session_id,
        requestId: event.request_id,
        error,
      },
      'Goal judge subscriber failed for goal_judge event',
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
  event: SkillRunEvent,
): boolean {
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
}

function matchesGoalJudgeSubscriberFilter(
  subscriber: ActiveGoalJudgeSubscriber,
  event: GoalJudgeEvent,
): boolean {
  const filter = subscriber.input.filter;
  if (!filter) return true;
  if (typeof filter === 'function') return filter(event);
  if (
    filter.agentId !== undefined &&
    !matchesString(filter.agentId, event.agent_id)
  ) {
    return false;
  }
  if (
    filter.sessionId !== undefined &&
    !matchesString(filter.sessionId, event.session_id)
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
