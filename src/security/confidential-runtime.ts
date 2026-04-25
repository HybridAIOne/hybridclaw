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

export interface DehydrateMessageContent {
  role?: string;
  content: unknown;
}

function dehydrateText(
  text: string,
  mappings: ConfidentialPlaceholderMap,
  ruleSet: ConfidentialRuleSet,
): string {
  if (!text) return text;
  return dehydrateConfidential(text, ruleSet, mappings).text;
}

function dehydrateContent<T extends DehydrateMessageContent>(
  message: T,
  mappings: ConfidentialPlaceholderMap,
  ruleSet: ConfidentialRuleSet,
): T {
  if (typeof message.content === 'string') {
    const dehydrated = dehydrateText(message.content, mappings, ruleSet);
    if (dehydrated === message.content) return message;
    return { ...message, content: dehydrated };
  }
  if (Array.isArray(message.content)) {
    let mutated = false;
    const next = message.content.map((part) => {
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
    if (!mutated) return message;
    return { ...message, content: next as unknown as T['content'] };
  }
  return message;
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

export function createConfidentialRuntimeContext(): ConfidentialRuntimeContext {
  if (!isConfidentialRedactionEnabled()) {
    return NOOP_CONTEXT;
  }
  const ruleSet = getConfidentialRuleSet();
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
      return (delta: string) => {
        callback(rehydrateConfidential(delta, mappings));
      };
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
