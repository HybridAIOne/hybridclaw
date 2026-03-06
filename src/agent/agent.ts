import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config/config.js';
import { getExecutor } from './executor.js';
import type {
  ChatMessage,
  ContainerOutput,
  MediaContextItem,
  ScheduledTask,
  ToolProgressEvent,
} from '../types.js';

/** Write full prompt context to data/last_prompt.jsonl for debugging (Pi-Mono style). */
function dumpPrompt(
  sessionId: string,
  messages: ChatMessage[],
  model: string,
  chatbotId: string,
  media?: MediaContextItem[],
  allowedTools?: string[],
  blockedTools?: string[],
): void {
  try {
    const entry = {
      ts: new Date().toISOString(),
      sessionId,
      model,
      chatbotId,
      messages,
      media: Array.isArray(media) ? media : [],
      allowedTools: Array.isArray(allowedTools) ? allowedTools : undefined,
      blockedTools: Array.isArray(blockedTools) ? blockedTools : undefined,
    };
    const filePath = path.join(DATA_DIR, 'last_prompt.jsonl');
    fs.writeFileSync(filePath, `${JSON.stringify(entry)}\n`);
  } catch {
    /* best-effort */
  }
}

export async function runAgent(
  sessionId: string,
  messages: ChatMessage[],
  chatbotId: string,
  enableRag: boolean,
  model: string,
  agentId: string,
  channelId: string,
  scheduledTasks?: ScheduledTask[],
  allowedTools?: string[],
  blockedTools?: string[],
  onTextDelta?: (delta: string) => void,
  onToolProgress?: (event: ToolProgressEvent) => void,
  abortSignal?: AbortSignal,
  media?: MediaContextItem[],
): Promise<ContainerOutput> {
  dumpPrompt(
    sessionId,
    messages,
    model,
    chatbotId,
    media,
    allowedTools,
    blockedTools,
  );
  return getExecutor().exec({
    sessionId,
    messages,
    chatbotId,
    enableRag,
    model,
    agentId,
    channelId,
    scheduledTasks,
    allowedTools,
    blockedTools,
    onTextDelta,
    onToolProgress,
    abortSignal,
    media,
  });
}
