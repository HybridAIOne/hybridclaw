import { logger } from '../logger.js';
import { setSessionTitle } from '../memory/db.js';
import { withSpan } from '../observability/otel.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import { isAuxiliaryTaskDisabled } from '../providers/task-routing.js';
import { SESSION_TITLE_MAX_CHARS } from './session-title-constants.js';

export { SESSION_TITLE_MAX_CHARS };

const TITLE_USER_INPUT_TRUNC = 500;

const TITLE_SYSTEM_PROMPT = [
  'You generate short titles for chat sessions.',
  "Return ONLY the title text — no quotes, no surrounding punctuation, no prefix like 'Title:'.",
  '3 to 7 words.',
  "Write the title in the language of the user's message: Title-case in English, the language's normal capitalization otherwise.",
  "Describe the user's goal, not the assistant's response.",
].join(' ');

export function normalizeSessionTitle(
  raw: string | null | undefined,
): string | null {
  let text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  text = text.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim();
  if (/^title\s*:/i.test(text)) {
    text = text.replace(/^title\s*:\s*/i, '').trim();
  }
  text = text.replace(/[\s.,;:!?]+$/g, '').trim();
  if (!text) return null;
  if (text.length < 2) return null;
  if (text.toLowerCase() === 'untitled') return null;
  if (text.length > SESSION_TITLE_MAX_CHARS) {
    text = text.slice(0, SESSION_TITLE_MAX_CHARS).trimEnd();
  }
  return text;
}

export interface GenerateSessionTitleParams {
  sessionId: string;
  agentId: string;
  chatbotId: string | null;
  model: string;
  userContent: string;
}

export async function generateSessionTitle(
  params: GenerateSessionTitleParams,
): Promise<string | null> {
  const userSnippet = params.userContent
    .trim()
    .slice(0, TITLE_USER_INPUT_TRUNC);
  if (!userSnippet) return null;
  if (isAuxiliaryTaskDisabled('session_title')) return null;

  const result = await withSpan(
    'hybridclaw.session.title',
    { sessionId: params.sessionId, agentId: params.agentId },
    () =>
      callAuxiliaryModel({
        task: 'session_title',
        agentId: params.agentId,
        fallbackModel: params.model,
        fallbackChatbotId: params.chatbotId ?? undefined,
        fallbackEnableRag: false,
        messages: [
          { role: 'system', content: TITLE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `User: ${userSnippet}`,
          },
        ],
      }),
  );
  return normalizeSessionTitle(result.content);
}

function isTransientTitleGenerationError(err: unknown): boolean {
  const messages: string[] = [];
  if (err instanceof Error) {
    messages.push(err.name, err.message);
    const cause = err.cause;
    if (cause instanceof Error) {
      messages.push(cause.name, cause.message);
    }
  } else {
    messages.push(String(err));
  }
  const normalized = messages.join(' ').toLowerCase();
  return (
    normalized.includes('fetch failed') ||
    normalized.includes('headers timeout') ||
    normalized.includes('headers_time') ||
    normalized.includes('timeout') ||
    normalized.includes('abort')
  );
}

export interface StartSessionTitleParams extends GenerateSessionTitleParams {
  isFirstTurn: boolean;
}

/**
 * A title request started with the turn. The model call runs alongside the
 * reply; the title is stored only when the turn succeeds, never on a failed one.
 */
export interface SessionTitleRequest {
  /** The title if it is already generated; never waits for it. */
  readyTitle(): string | undefined;
  /** Stores the title once it is generated. Call only after a successful turn. */
  persist(): void;
}

export function startSessionTitle(
  params: StartSessionTitleParams,
): SessionTitleRequest | null {
  if (!params.isFirstTurn) return null;
  if (!params.userContent.trim()) return null;

  let ready: string | undefined;
  const generated = generateSessionTitle(params).then(
    (title) => {
      ready = title ?? undefined;
      return title;
    },
    (err: unknown) => {
      const log = isTransientTitleGenerationError(err)
        ? logger.debug.bind(logger)
        : logger.warn.bind(logger);
      log(
        { sessionId: params.sessionId, err },
        'Session title auto-update failed',
      );
      return null;
    },
  );
  return {
    readyTitle: () => ready,
    persist: () => {
      void generated.then((title) => {
        if (!title) return;
        try {
          setSessionTitle(params.sessionId, title);
        } catch (err) {
          logger.warn(
            { sessionId: params.sessionId, err },
            'Session title auto-update failed',
          );
        }
      });
    },
  };
}
