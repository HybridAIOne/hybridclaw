import { runAgent } from './agent.js';
import type { ChatMessage } from './types.js';

export async function runIsolatedScheduledTask(params: {
  taskId: number;
  prompt: string;
  channelId: string;
  chatbotId: string;
  model: string;
  agentId: string;
  onResult: (result: string) => void | Promise<void>;
  onError: (error: unknown) => void;
}): Promise<void> {
  const { taskId, prompt, channelId, chatbotId, model, agentId, onResult, onError } = params;
  const cronSessionId = `cron:${taskId}`;
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

  try {
    const output = await runAgent(cronSessionId, messages, chatbotId, false, model, agentId, channelId, undefined, ['cron']);
    if (output.status === 'success' && output.result) {
      await onResult(output.result);
    }
  } catch (error) {
    onError(error);
  }
}
