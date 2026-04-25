import { logger } from '../logger.js';
import { getSessionTitle, setSessionTitle } from '../memory/db.js';
import { withSpan } from '../observability/otel.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';

export const SESSION_TITLE_MAX_CHARS = 80;
const TITLE_INPUT_USER_TRUNC = 500;
const TITLE_INPUT_ASSISTANT_TRUNC = 500;

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

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

export interface GenerateSessionTitleParams {
  sessionId: string;
  agentId: string;
  chatbotId: string | null;
  enableRag: boolean;
  model: string;
  userContent: string;
  assistantContent: string;
}

export async function generateSessionTitle(
  params: GenerateSessionTitleParams,
): Promise<string | null> {
  const userSnippet = truncate(params.userContent, TITLE_INPUT_USER_TRUNC);
  const assistantSnippet = truncate(
    params.assistantContent,
    TITLE_INPUT_ASSISTANT_TRUNC,
  );
  if (!userSnippet) return null;

  try {
    const result = await withSpan(
      'hybridclaw.session.title',
      { sessionId: params.sessionId, agentId: params.agentId },
      () =>
        callAuxiliaryModel({
          task: 'session_title',
          agentId: params.agentId,
          fallbackModel: params.model,
          fallbackChatbotId: params.chatbotId ?? undefined,
          fallbackEnableRag: params.enableRag,
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
  } catch (err) {
    logger.warn(
      { sessionId: params.sessionId, err },
      'Session title generation failed',
    );
    return null;
  }
}

export interface MaybeAutoTitleSessionParams
  extends GenerateSessionTitleParams {
  userMessageCount: number;
}

export function maybeAutoTitleSession(
  params: MaybeAutoTitleSessionParams,
): void {
  if (params.userMessageCount > 1) return;
  if (!params.userContent.trim()) return;
  const existing = getSessionTitle(params.sessionId);
  if (existing.title) return;

  void (async () => {
    try {
      const title = await generateSessionTitle(params);
      if (!title) return;
      setSessionTitle(params.sessionId, title, 'auto');
    } catch (err) {
      logger.warn(
        { sessionId: params.sessionId, err },
        'Session title auto-update failed',
      );
    }
  })();
}
