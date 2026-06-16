import { recordAuditEvent } from '../audit/audit-events.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import {
  type ConfidentialClassCount,
  type ConfidentialPlaceholderMap,
  createPlaceholderMap,
  dehydrateConfidential,
  rehydrateConfidentialWithStats,
} from './confidential-redact.js';
import {
  type ConfidentialRuleSet,
  loadConfidentialRules,
} from './confidential-rules.js';

let cachedRuleSet: ConfidentialRuleSet | null = null;

export function getConfidentialRuleSet(): ConfidentialRuleSet {
  cachedRuleSet ??= loadConfidentialRules();
  return cachedRuleSet;
}

export function resetConfidentialRuleSetCache(): void {
  cachedRuleSet = null;
}

/**
 * Test seam: inject a rule set without touching the filesystem.
 * Pass `null` to fall back to the regular loader.
 */
export function setConfidentialRuleSetForTesting(
  ruleSet: ConfidentialRuleSet | null,
): void {
  cachedRuleSet = ruleSet;
}

export function isConfidentialRedactionEnabled(): boolean {
  if (process.env.HYBRIDCLAW_CONFIDENTIAL_DISABLE === '1') return false;
  if (!getRuntimeConfig().security.confidentialRedactionEnabled) return false;
  return getConfidentialRuleSet().rules.length > 0;
}

export interface DehydrateMessageToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}

export interface DehydrateMessageContent {
  role?: string;
  content: unknown;
  tool_calls?: DehydrateMessageToolCall[];
}

export interface ConfidentialRuntimeAuditOptions {
  sessionId: string;
  runId: string;
  parentRunId?: string;
}

export interface ConfidentialRuntimeOptions {
  audit?: ConfidentialRuntimeAuditOptions;
}

interface ConfidentialRuntimeStats {
  hits: number;
  classes: Map<ConfidentialClassCount['class'], number>;
}

interface ConfidentialOperationStats {
  hits: number;
  classes: readonly ConfidentialClassCount[];
}

const DEFAULT_DEHYDRATE_SURFACE = 'runtime.messages';
const DEFAULT_REHYDRATE_SURFACE = 'runtime.text';
const DEFAULT_DELTA_SURFACE = 'runtime.delta';
const DEFAULT_FIELDS_SURFACE = 'runtime.fields';
const DEFAULT_EVENT_SURFACE = 'runtime.event';

function createRuntimeStats(): ConfidentialRuntimeStats {
  return { hits: 0, classes: new Map() };
}

function addClassCounts(
  stats: ConfidentialRuntimeStats,
  classes: readonly ConfidentialClassCount[],
): void {
  for (const entry of classes) {
    stats.classes.set(
      entry.class,
      (stats.classes.get(entry.class) || 0) + entry.count,
    );
  }
}

function addRuntimeStats(
  stats: ConfidentialRuntimeStats,
  next: ConfidentialRuntimeStats,
): void {
  stats.hits += next.hits;
  for (const [className, count] of next.classes) {
    stats.classes.set(className, (stats.classes.get(className) || 0) + count);
  }
}

function addConfidentialResult(
  stats: ConfidentialRuntimeStats,
  result: ConfidentialOperationStats,
): void {
  stats.hits += result.hits;
  addClassCounts(stats, result.classes);
}

function sortedClassCounts(
  stats: ConfidentialRuntimeStats,
): ConfidentialClassCount[] {
  return [...stats.classes.entries()]
    .map(([className, count]) => ({ class: className, count }))
    .sort((a, b) => a.class.localeCompare(b.class));
}

function emitConfidentialAuditEvent(params: {
  audit: ConfidentialRuntimeAuditOptions | undefined;
  type: 'secret.masked' | 'secret.rehydrated';
  surface: string;
  stats: ConfidentialRuntimeStats;
  rulesSource: string | null;
}): void {
  if (!params.audit || params.stats.hits === 0) return;
  recordAuditEvent({
    sessionId: params.audit.sessionId,
    runId: params.audit.runId,
    parentRunId: params.audit.parentRunId,
    event: {
      type: params.type,
      surface: params.surface,
      count: params.stats.hits,
      classes: sortedClassCounts(params.stats),
      rulesSource: params.rulesSource,
    },
  });
}

function dehydrateContentField(
  content: unknown,
  mappings: ConfidentialPlaceholderMap,
  ruleSet: ConfidentialRuleSet,
): { content: unknown; mutated: boolean; stats: ConfidentialRuntimeStats } {
  const stats = createRuntimeStats();
  if (typeof content === 'string') {
    const dehydrated = dehydrateConfidential(content, ruleSet, mappings);
    addConfidentialResult(stats, dehydrated);
    return {
      content: dehydrated.text,
      mutated: dehydrated.text !== content,
      stats,
    };
  }
  if (Array.isArray(content)) {
    let mutated = false;
    const next = content.map((part) => {
      if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        const original = (part as { text: string }).text;
        const dehydrated = dehydrateConfidential(original, ruleSet, mappings);
        addConfidentialResult(stats, dehydrated);
        if (dehydrated.text !== original) {
          mutated = true;
          return { ...part, text: dehydrated.text };
        }
      }
      return part;
    });
    return { content: mutated ? next : content, mutated, stats };
  }
  return { content, mutated: false, stats };
}

/**
 * Tool call arguments are stored as a JSON string. We dehydrate that
 * string directly — confidential placeholders use Unicode brackets
 * (`«CONF:…»`) that are valid inside JSON strings, so the result stays
 * parseable. `tool_calls[].function.arguments` would otherwise leak the
 * original term back to the model on every subsequent turn.
 */
function dehydrateToolCalls(
  toolCalls: DehydrateMessageToolCall[],
  mappings: ConfidentialPlaceholderMap,
  ruleSet: ConfidentialRuleSet,
): {
  toolCalls: DehydrateMessageToolCall[];
  mutated: boolean;
  stats: ConfidentialRuntimeStats;
} {
  let mutated = false;
  const stats = createRuntimeStats();
  const next = toolCalls.map((call) => {
    const args = call.function?.arguments;
    if (typeof args !== 'string' || args.length === 0) return call;
    const dehydrated = dehydrateConfidential(args, ruleSet, mappings);
    addConfidentialResult(stats, dehydrated);
    if (dehydrated.text === args) return call;
    mutated = true;
    return {
      ...call,
      function: {
        ...(call.function ?? {}),
        arguments: dehydrated.text,
      },
    };
  });
  return { toolCalls: mutated ? next : toolCalls, mutated, stats };
}

function dehydrateContent<T extends DehydrateMessageContent>(
  message: T,
  mappings: ConfidentialPlaceholderMap,
  ruleSet: ConfidentialRuleSet,
): { message: T; stats: ConfidentialRuntimeStats } {
  const stats = createRuntimeStats();
  const contentResult = dehydrateContentField(
    message.content,
    mappings,
    ruleSet,
  );
  addRuntimeStats(stats, contentResult.stats);
  let toolCallsResult: {
    toolCalls: DehydrateMessageToolCall[];
    mutated: boolean;
    stats: ConfidentialRuntimeStats;
  } = {
    toolCalls: message.tool_calls ?? [],
    mutated: false,
    stats: createRuntimeStats(),
  };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    toolCallsResult = dehydrateToolCalls(message.tool_calls, mappings, ruleSet);
    addRuntimeStats(stats, toolCallsResult.stats);
  }

  if (!contentResult.mutated && !toolCallsResult.mutated) {
    return { message, stats };
  }
  const next: T = { ...message };
  if (contentResult.mutated) {
    (next as { content: unknown }).content = contentResult.content;
  }
  if (toolCallsResult.mutated) {
    (next as { tool_calls?: DehydrateMessageToolCall[] }).tool_calls =
      toolCallsResult.toolCalls;
  }
  return { message: next, stats };
}

export interface ConfidentialRuntimeContext {
  enabled: boolean;
  ruleSet: ConfidentialRuleSet;
  mappings: ConfidentialPlaceholderMap;
  dehydrate<T extends DehydrateMessageContent>(
    messages: T[],
    surface?: string,
  ): T[];
  rehydrate(text: string | null | undefined, surface?: string): string;
  wrapDelta(
    callback: ((delta: string) => void) | undefined,
    surface?: string,
  ): ((delta: string) => void) | undefined;
  /** Rehydrate every listed string field on an object (shallow). */
  rehydrateFields<T extends object>(
    value: T | null | undefined,
    fields: ReadonlyArray<keyof T>,
    surface?: string,
  ): T | null | undefined;
  /** Map a callback that receives an object, rehydrating string fields by name. */
  wrapEvent<T extends object>(
    callback: ((event: T) => void) | undefined,
    fields: ReadonlyArray<keyof T>,
    surface?: string,
  ): ((event: T) => void) | undefined;
}

const NOOP_CONTEXT: ConfidentialRuntimeContext = {
  enabled: false,
  ruleSet: { rules: [], sourcePath: null },
  mappings: createPlaceholderMap(),
  dehydrate: (messages) => messages,
  rehydrate: (text) => text || '',
  wrapDelta: (callback) => callback,
  rehydrateFields: (value) => value,
  wrapEvent: (callback) => callback,
};

function rehydrateStringField<T extends object>(
  source: T,
  key: keyof T,
  mappings: ConfidentialPlaceholderMap,
): { value: T[keyof T]; mutated: boolean; stats: ConfidentialRuntimeStats } {
  const stats = createRuntimeStats();
  const raw = source[key];
  if (typeof raw !== 'string') return { value: raw, mutated: false, stats };
  const result = rehydrateConfidentialWithStats(raw, mappings);
  addConfidentialResult(stats, result);
  return {
    value: result.text as T[keyof T],
    mutated: result.text !== raw,
    stats,
  };
}

/**
 * Maximum number of trailing characters we keep in the streaming buffer
 * waiting for a placeholder to close. Placeholders are at most ~20 chars
 * (`«CONF:` + ID + `»`); 64 leaves slack for compound IDs while bounding
 * how much of the live stream we delay.
 *
 * If the orphan tail exceeds this length without a closing `»`, it
 * cannot be a placeholder — we flush it as-is so the user does not lose
 * legitimate text that happens to start with `«`.
 */
const STREAM_PLACEHOLDER_LOOKAHEAD = 64;

function makeStreamingDeltaWrapper(
  callback: (delta: string) => void,
  mappings: ConfidentialPlaceholderMap,
  audit: ConfidentialRuntimeAuditOptions | undefined,
  rulesSource: string | null,
  surface: string,
): (delta: string) => void {
  // A placeholder may straddle two delta chunks — e.g. one delta ends
  // with `«CONF:CLIENT_` and the next begins with `001»`. If we
  // rehydrated each delta independently the user would see broken
  // halves. We hold back any characters from the latest unmatched `«`
  // so the placeholder is only emitted once it is whole.
  let pending = '';
  return (delta: string) => {
    pending += delta;
    const lastOpen = pending.lastIndexOf('«');
    let flushUpTo: number;
    if (lastOpen === -1) {
      flushUpTo = pending.length;
    } else {
      const closeAfter = pending.indexOf('»', lastOpen);
      if (closeAfter !== -1) {
        flushUpTo = pending.length;
      } else if (pending.length - lastOpen > STREAM_PLACEHOLDER_LOOKAHEAD) {
        // Tail is too long to still be a placeholder — release it so the
        // user does not stall on an orphan `«` in legitimate prose.
        flushUpTo = pending.length;
      } else {
        flushUpTo = lastOpen;
      }
    }
    if (flushUpTo === 0) return;
    const ready = pending.slice(0, flushUpTo);
    pending = pending.slice(flushUpTo);
    const result = rehydrateConfidentialWithStats(ready, mappings);
    const stats = createRuntimeStats();
    addConfidentialResult(stats, result);
    emitConfidentialAuditEvent({
      audit,
      type: 'secret.rehydrated',
      surface,
      stats,
      rulesSource,
    });
    callback(result.text);
  };
}

export function createConfidentialRuntimeContext(
  ruleSetOverride?: ConfidentialRuleSet,
  options: ConfidentialRuntimeOptions = {},
): ConfidentialRuntimeContext {
  if (process.env.HYBRIDCLAW_CONFIDENTIAL_DISABLE === '1') {
    return NOOP_CONTEXT;
  }
  if (
    ruleSetOverride === undefined &&
    !getRuntimeConfig().security.confidentialRedactionEnabled
  ) {
    return NOOP_CONTEXT;
  }
  const ruleSet = ruleSetOverride ?? getConfidentialRuleSet();
  if (ruleSet.rules.length === 0) {
    return NOOP_CONTEXT;
  }
  const mappings = createPlaceholderMap();
  const audit = options.audit;
  const rulesSource = ruleSet.sourcePath;

  function rehydrateFields<T extends object>(
    value: T | null | undefined,
    fields: ReadonlyArray<keyof T>,
    surface = DEFAULT_FIELDS_SURFACE,
  ): T | null | undefined {
    if (!value) return value;
    let mutated = false;
    const next = { ...value } as T;
    const stats = createRuntimeStats();
    for (const field of fields) {
      const result = rehydrateStringField(value, field, mappings);
      addRuntimeStats(stats, result.stats);
      if (result.mutated) {
        next[field] = result.value;
        mutated = true;
      }
    }
    emitConfidentialAuditEvent({
      audit,
      type: 'secret.rehydrated',
      surface,
      stats,
      rulesSource,
    });
    return mutated ? next : value;
  }

  return {
    enabled: true,
    ruleSet,
    mappings,
    dehydrate(messages, surface = DEFAULT_DEHYDRATE_SURFACE) {
      const stats = createRuntimeStats();
      const next = messages.map((message) => {
        const result = dehydrateContent(message, mappings, ruleSet);
        addRuntimeStats(stats, result.stats);
        return result.message;
      });
      emitConfidentialAuditEvent({
        audit,
        type: 'secret.masked',
        surface,
        stats,
        rulesSource,
      });
      return next;
    },
    rehydrate(text, surface = DEFAULT_REHYDRATE_SURFACE) {
      if (!text) return text || '';
      const result = rehydrateConfidentialWithStats(text, mappings);
      const stats = createRuntimeStats();
      addConfidentialResult(stats, result);
      emitConfidentialAuditEvent({
        audit,
        type: 'secret.rehydrated',
        surface,
        stats,
        rulesSource,
      });
      return result.text;
    },
    wrapDelta(callback, surface = DEFAULT_DELTA_SURFACE) {
      if (!callback) return callback;
      return makeStreamingDeltaWrapper(
        callback,
        mappings,
        audit,
        rulesSource,
        surface,
      );
    },
    rehydrateFields,
    wrapEvent(callback, fields, surface = DEFAULT_EVENT_SURFACE) {
      if (!callback) return callback;
      return (event) => {
        const next = rehydrateFields(event, fields, surface);
        callback((next ?? event) as Parameters<typeof callback>[0]);
      };
    },
  };
}
