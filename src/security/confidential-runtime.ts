import {
  type ConfidentialPlaceholderMap,
  createPlaceholderMap,
  dehydrateConfidential,
  rehydrateConfidential,
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

function dehydrateText(
  text: string,
  mappings: ConfidentialPlaceholderMap,
  ruleSet: ConfidentialRuleSet,
): string {
  if (!text) return text;
  return dehydrateConfidential(text, ruleSet, mappings).text;
}

function dehydrateContentField(
  content: unknown,
  mappings: ConfidentialPlaceholderMap,
  ruleSet: ConfidentialRuleSet,
): { content: unknown; mutated: boolean } {
  if (typeof content === 'string') {
    const dehydrated = dehydrateText(content, mappings, ruleSet);
    return { content: dehydrated, mutated: dehydrated !== content };
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
        const dehydrated = dehydrateText(original, mappings, ruleSet);
        if (dehydrated !== original) {
          mutated = true;
          return { ...part, text: dehydrated };
        }
      }
      return part;
    });
    return { content: mutated ? next : content, mutated };
  }
  return { content, mutated: false };
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
): { toolCalls: DehydrateMessageToolCall[]; mutated: boolean } {
  let mutated = false;
  const next = toolCalls.map((call) => {
    const args = call.function?.arguments;
    if (typeof args !== 'string' || args.length === 0) return call;
    const dehydrated = dehydrateText(args, mappings, ruleSet);
    if (dehydrated === args) return call;
    mutated = true;
    return {
      ...call,
      function: {
        ...(call.function ?? {}),
        arguments: dehydrated,
      },
    };
  });
  return { toolCalls: mutated ? next : toolCalls, mutated };
}

function dehydrateContent<T extends DehydrateMessageContent>(
  message: T,
  mappings: ConfidentialPlaceholderMap,
  ruleSet: ConfidentialRuleSet,
): T {
  const contentResult = dehydrateContentField(
    message.content,
    mappings,
    ruleSet,
  );
  let toolCallsResult: {
    toolCalls: DehydrateMessageToolCall[];
    mutated: boolean;
  } = {
    toolCalls: message.tool_calls ?? [],
    mutated: false,
  };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    toolCallsResult = dehydrateToolCalls(message.tool_calls, mappings, ruleSet);
  }

  if (!contentResult.mutated && !toolCallsResult.mutated) return message;
  const next: T = { ...message };
  if (contentResult.mutated) {
    (next as { content: unknown }).content = contentResult.content;
  }
  if (toolCallsResult.mutated) {
    (next as { tool_calls?: DehydrateMessageToolCall[] }).tool_calls =
      toolCallsResult.toolCalls;
  }
  return next;
}

export interface ConfidentialRuntimeContext {
  enabled: boolean;
  ruleSet: ConfidentialRuleSet;
  mappings: ConfidentialPlaceholderMap;
  dehydrate<T extends DehydrateMessageContent>(messages: T[]): T[];
  rehydrate(text: string | null | undefined): string;
  wrapDelta(
    callback: ((delta: string) => void) | undefined,
  ): ((delta: string) => void) | undefined;
  /** Rehydrate every listed string field on an object (shallow). */
  rehydrateFields<T extends object>(
    value: T | null | undefined,
    fields: ReadonlyArray<keyof T>,
  ): T | null | undefined;
  /** Map a callback that receives an object, rehydrating string fields by name. */
  wrapEvent<T extends object>(
    callback: ((event: T) => void) | undefined,
    fields: ReadonlyArray<keyof T>,
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
): { value: T[keyof T]; mutated: boolean } {
  const raw = source[key];
  if (typeof raw !== 'string') return { value: raw, mutated: false };
  const next = rehydrateConfidential(raw, mappings);
  return {
    value: next as T[keyof T],
    mutated: next !== raw,
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
    callback(rehydrateConfidential(ready, mappings));
  };
}

export function createConfidentialRuntimeContext(
  ruleSetOverride?: ConfidentialRuleSet,
): ConfidentialRuntimeContext {
  if (process.env.HYBRIDCLAW_CONFIDENTIAL_DISABLE === '1') {
    return NOOP_CONTEXT;
  }
  const ruleSet = ruleSetOverride ?? getConfidentialRuleSet();
  if (ruleSet.rules.length === 0) {
    return NOOP_CONTEXT;
  }
  const mappings = createPlaceholderMap();

  function rehydrateFields<T extends object>(
    value: T | null | undefined,
    fields: ReadonlyArray<keyof T>,
  ): T | null | undefined {
    if (!value) return value;
    let mutated = false;
    const next = { ...value } as T;
    for (const field of fields) {
      const result = rehydrateStringField(value, field, mappings);
      if (result.mutated) {
        next[field] = result.value;
        mutated = true;
      }
    }
    return mutated ? next : value;
  }

  return {
    enabled: true,
    ruleSet,
    mappings,
    dehydrate(messages) {
      return messages.map((message) =>
        dehydrateContent(message, mappings, ruleSet),
      );
    },
    rehydrate(text) {
      if (!text) return text || '';
      return rehydrateConfidential(text, mappings);
    },
    wrapDelta(callback) {
      if (!callback) return callback;
      return makeStreamingDeltaWrapper(callback, mappings);
    },
    rehydrateFields,
    wrapEvent(callback, fields) {
      if (!callback) return callback;
      return (event) => {
        const next = rehydrateFields(event, fields);
        callback((next ?? event) as Parameters<typeof callback>[0]);
      };
    },
  };
}
