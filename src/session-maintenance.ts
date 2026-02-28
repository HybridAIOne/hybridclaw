import {
  PRE_COMPACTION_MEMORY_FLUSH_ENABLED,
  PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS,
  PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES,
  SESSION_COMPACTION_ENABLED,
  SESSION_COMPACTION_KEEP_RECENT,
  SESSION_COMPACTION_SUMMARY_MAX_CHARS,
  SESSION_COMPACTION_THRESHOLD,
} from './config.js';
import {
  deleteMessagesBeforeId,
  getCompactionCandidateMessages,
  getSessionById,
  markSessionMemoryFlush,
  updateSessionSummary,
} from './db.js';
import { logger } from './logger.js';
import { loadSkills } from './skills.js';
import type { ChatMessage, StoredMessage } from './types.js';
import { runAgent } from './agent.js';
import { buildSystemPromptFromHooks } from './prompt-hooks.js';

const COMPACTION_SOURCE_MAX_MESSAGES = 240;
const COMPACTION_SOURCE_MAX_CHARS = 80_000;

function formatDateStampInLocalTimezone(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return now.toISOString().slice(0, 10);
}

function normalizeSummary(summary: string): string {
  let text = summary.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-z0-9_-]*\s*/i, '').replace(/```$/i, '').trim();
  }
  if (text.length > SESSION_COMPACTION_SUMMARY_MAX_CHARS) {
    text = `${text.slice(0, SESSION_COMPACTION_SUMMARY_MAX_CHARS)}\n\n...[truncated]`;
  }
  return text;
}

function formatMessagesForPrompt(
  messages: StoredMessage[],
  maxMessages: number,
  maxChars: number,
): string {
  const selected = messages.slice(-Math.max(1, maxMessages));
  const lines: string[] = [];
  let usedChars = 0;

  for (const msg of selected) {
    const role = (msg.role || 'unknown').toUpperCase();
    const compact = msg.content.replace(/\r/g, '').trim();
    const bounded = compact.length > 1_200 ? `${compact.slice(0, 1_200)}\n...[truncated]` : compact;
    const entry = `[${role}] ${bounded}`;
    const bytes = entry.length + 2;
    if (usedChars + bytes > maxChars) break;
    usedChars += bytes;
    lines.push(entry);
  }

  return lines.join('\n\n');
}

function buildSystemPrompt(agentId: string, sessionSummary?: string | null, extra?: string): string {
  return buildSystemPromptFromHooks({
    agentId,
    sessionSummary,
    skills: loadSkills(agentId),
    purpose: 'memory-flush',
    extraSafetyText: extra,
  });
}

async function runPreCompactionMemoryFlush(params: {
  sessionId: string;
  agentId: string;
  chatbotId: string;
  enableRag: boolean;
  model: string;
  channelId: string;
  sessionSummary: string | null;
  olderMessages: StoredMessage[];
}): Promise<void> {
  if (!PRE_COMPACTION_MEMORY_FLUSH_ENABLED) return;

  const transcript = formatMessagesForPrompt(
    params.olderMessages,
    PRE_COMPACTION_MEMORY_FLUSH_MAX_MESSAGES,
    PRE_COMPACTION_MEMORY_FLUSH_MAX_CHARS,
  );
  if (!transcript) return;

  const now = new Date();
  const dateStamp = formatDateStampInLocalTimezone(now);

  const flushPrompt = [
    'Pre-compaction memory flush.',
    `Store durable memories now using MEMORY.md and memory/${dateStamp}.md (create memory/ if needed).`,
    'IMPORTANT: If a file already exists, append new content only and do not overwrite existing entries.',
    'Capture only stable, durable facts, preferences, and decisions worth preserving after compaction.',
    'If there is nothing worth saving, reply MEMORY_FLUSH_SKIPPED.',
    '',
    `Current time: ${now.toISOString()}`,
    '',
    'Conversation excerpt (about to be compacted):',
    transcript,
  ].join('\n');

  const systemPrompt = buildSystemPrompt(
    params.agentId,
    params.sessionSummary,
    'Pre-compaction memory flush turn. The session is near auto-compaction; write durable memory to disk.',
  );

  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: flushPrompt });

  try {
    const output = await runAgent(
      `memory-flush:${params.sessionId}:${Date.now()}`,
      messages,
      params.chatbotId,
      params.enableRag,
      params.model,
      params.agentId,
      params.channelId,
      undefined,
      ['memory'],
    );
    if (output.status === 'error') {
      logger.warn({ sessionId: params.sessionId, error: output.error }, 'Pre-compaction memory flush failed');
      return;
    }
    markSessionMemoryFlush(params.sessionId);
  } catch (err) {
    logger.warn({ sessionId: params.sessionId, err }, 'Pre-compaction memory flush crashed');
  }
}

async function generateCompactionSummary(params: {
  sessionId: string;
  agentId: string;
  chatbotId: string;
  enableRag: boolean;
  model: string;
  channelId: string;
  previousSummary: string | null;
  olderMessages: StoredMessage[];
}): Promise<string | null> {
  const transcript = formatMessagesForPrompt(
    params.olderMessages,
    COMPACTION_SOURCE_MAX_MESSAGES,
    COMPACTION_SOURCE_MAX_CHARS,
  );
  if (!transcript) return null;

  const previous = params.previousSummary?.trim() || '(none)';
  const systemPrompt = [
    'You are compressing conversation history for a long-running AI session.',
    'Return an updated markdown summary that preserves durable context only.',
    'Focus on goals, decisions, constraints, preferences, and open follow-ups.',
    'Do not include low-value chatter, greetings, or transient details.',
    'Return summary text only.',
  ].join(' ');

  const userPrompt = [
    'Existing summary:',
    previous,
    '',
    'Messages to compact:',
    transcript,
    '',
    'Return a single merged summary that should replace the existing summary.',
  ].join('\n');

  const output = await runAgent(
    `compact:${params.sessionId}:${Date.now()}`,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    params.chatbotId,
    params.enableRag,
    params.model,
    params.agentId,
    params.channelId,
    undefined,
    [],
  );

  if (output.status === 'error' || !output.result) {
    logger.warn({ sessionId: params.sessionId, error: output.error }, 'Session compaction summary failed');
    return null;
  }

  const normalized = normalizeSummary(output.result);
  if (!normalized) return null;
  return normalized;
}

export async function maybeCompactSession(params: {
  sessionId: string;
  agentId: string;
  chatbotId: string;
  enableRag: boolean;
  model: string;
  channelId: string;
}): Promise<void> {
  if (!SESSION_COMPACTION_ENABLED) return;

  const session = getSessionById(params.sessionId);
  if (!session) return;

  const threshold = Math.max(SESSION_COMPACTION_THRESHOLD, 20);
  const keepRecent = Math.max(1, Math.min(SESSION_COMPACTION_KEEP_RECENT, threshold - 1));

  if (session.message_count < threshold) return;

  const candidate = getCompactionCandidateMessages(params.sessionId, keepRecent);
  if (!candidate || candidate.olderMessages.length === 0) return;

  await runPreCompactionMemoryFlush({
    ...params,
    sessionSummary: session.session_summary,
    olderMessages: candidate.olderMessages,
  });

  const summary = await generateCompactionSummary({
    ...params,
    previousSummary: session.session_summary,
    olderMessages: candidate.olderMessages,
  });
  if (!summary) return;

  const deleted = deleteMessagesBeforeId(params.sessionId, candidate.cutoffId);
  if (deleted <= 0) return;

  updateSessionSummary(params.sessionId, summary);
  logger.info(
    {
      sessionId: params.sessionId,
      deleted,
      cutoffId: candidate.cutoffId,
      threshold,
      keepRecent,
    },
    'Session compacted',
  );
}
