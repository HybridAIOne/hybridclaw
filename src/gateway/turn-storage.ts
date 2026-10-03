/**
 * Writes one finished chat turn to every store that keeps it: the session's
 * messages, the canonical cross-channel memory and the session transcript.
 *
 * The stores agree on order: the user's message, then each note they sent
 * while the turn ran (`steerNotes`, as user messages of their own), then the
 * reply. NOT the audit trail or compaction; `recordSuccessfulTurn` and
 * `recordErrorTurn` in gateway-service.ts decide those and what the reply is.
 */
import { logger } from '../logger.js';
import {
  memoryService,
  type StoreTurnParams,
} from '../memory/memory-service.js';
import { appendSessionTranscript } from '../session/session-transcripts.js';
import type { ChatMessage } from '../types/api.js';
import type { MediaContextItem } from '../types/container.js';
import type { ArtifactMetadata } from '../types/execution.js';

export function storeTurnMessages(opts: {
  sessionId: string;
  agentId: string;
  channelId: string;
  userId: string;
  username: string | null;
  canonicalScopeId: string;
  userContent: string;
  userMedia?: readonly MediaContextItem[];
  userDynamicContext?: string | null;
  steerNotes?: readonly string[];
  assistantContent: string;
  artifacts?: ArtifactMetadata[] | null;
  /** For the transcript. */
  toolHistory?: ChatMessage[];
  /** Stored with the reply, for replay in later turns. */
  toolHistoryForReplay?: ChatMessage[];
  replaceBuiltInMemory?: boolean;
}): { userMessageId: number; assistantMessageId: number } {
  const steerNotes = opts.steerNotes ?? [];
  const user = {
    userId: opts.userId,
    username: opts.username,
    content: opts.userContent,
    media: opts.userMedia,
    dynamicContext: opts.userDynamicContext,
  };
  const assistant = {
    userId: 'assistant',
    username: null,
    agentId: opts.agentId,
    content: opts.assistantContent,
    artifacts: opts.artifacts,
    toolHistory: opts.toolHistoryForReplay,
  };
  const storedTurn =
    opts.replaceBuiltInMemory === true
      ? storeMessagesOnly(opts.sessionId, user, steerNotes, assistant)
      : memoryService.storeTurn({
          sessionId: opts.sessionId,
          user,
          steerNotes,
          assistant,
        });
  if (opts.replaceBuiltInMemory !== true && opts.canonicalScopeId.trim()) {
    try {
      memoryService.appendCanonicalMessages({
        agentId: opts.agentId,
        userId: opts.canonicalScopeId,
        newMessages: [
          ...[opts.userContent, ...steerNotes].map((content) => ({
            role: 'user' as const,
            content,
            sessionId: opts.sessionId,
            channelId: opts.channelId,
          })),
          {
            role: 'assistant',
            content: opts.assistantContent,
            sessionId: opts.sessionId,
            channelId: opts.channelId,
          },
        ],
      });
    } catch (err) {
      logger.debug(
        {
          sessionId: opts.sessionId,
          canonicalScopeId: opts.canonicalScopeId,
          err,
        },
        'Failed to append canonical session memory',
      );
    }
  }
  for (const content of [opts.userContent, ...steerNotes]) {
    appendSessionTranscript(opts.agentId, {
      sessionId: opts.sessionId,
      channelId: opts.channelId,
      role: 'user',
      userId: opts.userId,
      username: opts.username,
      content,
    });
  }
  appendSessionTranscript(opts.agentId, {
    sessionId: opts.sessionId,
    channelId: opts.channelId,
    role: 'assistant',
    userId: 'assistant',
    username: null,
    content: opts.assistantContent,
    toolHistory: opts.toolHistory,
  });
  return storedTurn;
}

/** A plugin memory layer replaces built-in memory: the messages, nothing else. */
function storeMessagesOnly(
  sessionId: string,
  user: StoreTurnParams['user'],
  steerNotes: readonly string[],
  assistant: StoreTurnParams['assistant'],
): { userMessageId: number; assistantMessageId: number } {
  const userMessageId = memoryService.storeMessage({
    sessionId,
    role: 'user',
    ...user,
  });
  for (const content of steerNotes) {
    memoryService.storeMessage({
      sessionId,
      userId: user.userId,
      username: user.username,
      role: 'user',
      content,
    });
  }
  return {
    userMessageId,
    assistantMessageId: memoryService.storeMessage({
      sessionId,
      role: 'assistant',
      ...assistant,
      userId: assistant.userId || 'assistant',
      username: assistant.username ?? null,
    }),
  };
}
