/**
 * Agent — always runs through a container for consistent sandboxing.
 */
import { runContainer } from './container-runner.js';
import type { ChatMessage, ContainerOutput, ScheduledTask } from './types.js';

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
  return runContainer(sessionId, messages, chatbotId, enableRag, model, agentId, channelId, scheduledTasks, allowedTools);
}
