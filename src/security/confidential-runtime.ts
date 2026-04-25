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
}

const NOOP_CONTEXT: ConfidentialRuntimeContext = {
  enabled: false,
  ruleSet: { rules: [], sourcePath: null },
  mappings: createPlaceholderMap(),
  dehydrate: (messages) => messages,
  rehydrate: (text) => text || '',
  wrapDelta: (callback) => callback,
};

export function createConfidentialRuntimeContext(): ConfidentialRuntimeContext {
  if (!isConfidentialRedactionEnabled()) {
    return NOOP_CONTEXT;
  }
  const ruleSet = getConfidentialRuleSet();
  const mappings = createPlaceholderMap();

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
  };
}
