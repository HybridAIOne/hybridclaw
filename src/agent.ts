/**
 * Agent — always runs through a container for consistent sandboxing.
 */
import { runContainer } from './container-runner.js';
import type { ChatMessage, ContainerOutput } from './types.js';

export async function runAgent(
  sessionId: string,
  messages: ChatMessage[],
  chatbotId: string,
  enableRag: boolean,
  model: string,
  agentId: string,
): Promise<ContainerOutput> {
  return runContainer(sessionId, messages, chatbotId, enableRag, model, agentId);
}
