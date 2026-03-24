import { estimateTokenCountFromText } from '../session/token-efficiency.js';
import {
  type ContextReferenceResult,
  parseContextReferences,
  removeReferenceTokens,
} from './parser.js';
import {
  type ContextReferenceUrlFetcher,
  expandReference,
} from './resolver.js';

const DEFAULT_CONTEXT_LENGTH = 128_000;
const SOFT_LIMIT_RATIO = 0.25;
const HARD_LIMIT_RATIO = 0.5;

export interface PreprocessContextReferencesOptions {
  message: string;
  cwd: string;
  contextLength?: number;
  allowedRoot?: string;
  urlFetcher?: ContextReferenceUrlFetcher;
}

function joinSections(sections: Array<string | null | undefined>): string {
  return sections
    .filter((section): section is string => Boolean(section?.trim()))
    .join('\n\n')
    .trim();
}

function normalizeContextLength(contextLength: number | undefined): number {
  if (
    contextLength === undefined ||
    !Number.isFinite(contextLength) ||
    contextLength <= 0
  ) {
    return DEFAULT_CONTEXT_LENGTH;
  }
  return Math.floor(contextLength);
}

export async function preprocessContextReferences(
  params: PreprocessContextReferencesOptions,
): Promise<ContextReferenceResult> {
  const originalMessage =
    typeof params.message === 'string' ? params.message : '';
  const references = parseContextReferences(originalMessage);
  if (references.length === 0) {
    return {
      originalMessage,
      strippedMessage: originalMessage,
      message: originalMessage,
      references,
      warnings: [],
      attachedContext: null,
      contextTokens: 0,
    };
  }

  const resolved = await Promise.all(
    references.map((ref) =>
      expandReference(ref, params.cwd, {
        allowedRoot: params.allowedRoot ?? params.cwd,
        urlFetcher: params.urlFetcher,
      }),
    ),
  );

  const warnings = resolved
    .map(([warning]) => warning)
    .filter((warning): warning is string => Boolean(warning));
  const blocks = resolved
    .map(([, block]) => block)
    .filter((block): block is string => Boolean(block));

  const strippedMessage = removeReferenceTokens(originalMessage, references);
  const attachedContext = blocks.join('\n\n').trim();
  const contextTokens = estimateTokenCountFromText(attachedContext);
  const contextLength = normalizeContextLength(params.contextLength);
  const softLimit = Math.floor(contextLength * SOFT_LIMIT_RATIO);
  const hardLimit = Math.floor(contextLength * HARD_LIMIT_RATIO);

  const finalWarnings = [...warnings];

  if (contextTokens > hardLimit) {
    finalWarnings.push(
      `Context attachments estimated ${contextTokens} tokens, exceeding the hard limit of ${hardLimit}; attached context was omitted.`,
    );
    return {
      originalMessage,
      strippedMessage,
      message: joinSections([
        strippedMessage,
        finalWarnings.length === 0
          ? null
          : [
              '--- Context Warnings ---',
              ...finalWarnings.map((warning) => `- ${warning}`),
            ].join('\n'),
      ]),
      references,
      warnings: finalWarnings,
      attachedContext: null,
      contextTokens: 0,
    };
  }

  if (contextTokens > softLimit) {
    finalWarnings.push(
      `Context attachments estimated ${contextTokens} tokens, exceeding the soft limit of ${softLimit}.`,
    );
  }

  return {
    originalMessage,
    strippedMessage,
    message: joinSections([
      strippedMessage,
      finalWarnings.length === 0
        ? null
        : [
            '--- Context Warnings ---',
            ...finalWarnings.map((warning) => `- ${warning}`),
          ].join('\n'),
      blocks.length === 0
        ? null
        : ['--- Attached Context ---', blocks.join('\n\n')].join('\n'),
    ]),
    references,
    warnings: finalWarnings,
    attachedContext: attachedContext || null,
    contextTokens,
  };
}

export type { ContextReference, ContextReferenceResult } from './parser.js';
export {
  parseContextReferences,
  removeReferenceTokens,
  stripTrailingPunctuation,
} from './parser.js';
export type { ContextReferenceUrlFetcher } from './resolver.js';
