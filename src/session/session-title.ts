import { logger } from '../logger.js';
import { setSessionTitle } from '../memory/db.js';
import { withSpan } from '../observability/otel.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import { isAuxiliaryTaskDisabled } from '../providers/task-routing.js';
import { SESSION_TITLE_MAX_CHARS } from './session-title-constants.js';

export { SESSION_TITLE_MAX_CHARS };

const TITLE_INPUT_TRUNC = 500;

const TITLE_SYSTEM_PROMPT = [
  'You generate short titles for chat sessions.',
  "Return ONLY the title text — no quotes, no surrounding punctuation, no prefix like 'Title:'.",
  '3 to 7 words. Title-case.',
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
  assistantContent: string;
}

export async function generateSessionTitle(
  params: GenerateSessionTitleParams,
): Promise<string | null> {
  const userSnippet = params.userContent.trim().slice(0, TITLE_INPUT_TRUNC);
  const assistantSnippet = params.assistantContent
    .trim()
    .slice(0, TITLE_INPUT_TRUNC);
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
            content: `User: ${userSnippet}\n\nAssistant: ${assistantSnippet}`,
          },
        ],
      }),
  );
  return normalizeSessionTitle(result.content);
}

export interface MaybeAutoTitleSessionParams
  extends GenerateSessionTitleParams {
  isFirstTurn: boolean;
}

export function maybeAutoTitleSession(
  params: MaybeAutoTitleSessionParams,
): void {
  if (!params.isFirstTurn) return;
  if (!params.userContent.trim()) return;

  void (async () => {
    try {
      const title = await generateSessionTitle(params);
      if (!title) return;
      setSessionTitle(params.sessionId, title);
    } catch (err) {
      logger.warn(
        { sessionId: params.sessionId, err },
        'Session title auto-update failed',
      );
    }
  })();
}
