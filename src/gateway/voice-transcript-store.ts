/**
 * Persists realtime voice transcripts into session history as regular
 * user/assistant messages tagged `source: 'voice'`, mirrored into the
 * workspace session transcript. Shared by the webchat voice surface and the
 * phone-call realtime runtime.
 */

import { memoryService } from '../memory/memory-service.js';
import { appendSessionTranscript } from '../session/session-transcripts.js';

export const VOICE_MESSAGE_SOURCE = 'voice';

export function persistVoiceTranscript(params: {
  sessionId: string;
  channelId: string;
  agentId: string;
  userId: string;
  username: string | null;
  role: 'user' | 'assistant';
  text: string;
}): void {
  const { sessionId, channelId, agentId, role, text } = params;
  const userId = role === 'user' ? params.userId : 'assistant';
  const username = role === 'user' ? params.username : null;
  // Spoken turns can arrive before any consult runs, so the session row must
  // exist even for a voice-first conversation.
  memoryService.getOrCreateSession(sessionId, null, channelId, agentId);
  memoryService.storeMessage({
    sessionId,
    userId,
    username,
    role,
    content: text,
    agentId: role === 'assistant' ? agentId : undefined,
    source: VOICE_MESSAGE_SOURCE,
  });
  appendSessionTranscript(agentId, {
    sessionId,
    channelId,
    role,
    userId,
    username,
    content: text,
  });
}
