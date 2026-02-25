/**
 * Agent — always runs through a container for consistent sandboxing.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { runContainer } from './container-runner.js';
import type { ChatMessage, ContainerOutput, ScheduledTask } from './types.js';

/** Write full prompt context to data/last_prompt.jsonl for debugging (Pi-Mono style). */
function dumpPrompt(sessionId: string, messages: ChatMessage[], model: string, chatbotId: string): void {
  try {
    const entry = { ts: new Date().toISOString(), sessionId, model, chatbotId, messages };
    const filePath = path.join(DATA_DIR, 'last_prompt.jsonl');
    fs.writeFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch { /* best-effort */ }
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
): Promise<ContainerOutput> {
  dumpPrompt(sessionId, messages, model, chatbotId);
  return runContainer(sessionId, messages, chatbotId, enableRag, model, agentId, channelId, scheduledTasks, allowedTools);
}
