/**
 * Captures this turn's tool exchanges before context pruning can erase them.
 * Unlike loop detection, it retains ordered model messages for later replay;
 * unexecuted calls receive explicit terminal results, never fabricated success.
 */
import {
  toolResultForHistory,
  validateToolHistory,
} from '../shared/tool-history.js';
import type { ChatMessage } from './types.js';

export class TurnToolHistory {
  private readonly messages: ChatMessage[] = [];
  private readonly replayMessages: ChatMessage[] = [];
  private activeHistory: ChatMessage[] | undefined;

  constructor(private readonly sessionId: string) {}

  retain(history: ChatMessage[]): void {
    this.activeHistory = history;
  }

  recordAssistant(message: ChatMessage): void {
    if (message.tool_calls?.length) {
      this.messages.push(structuredClone(message));
      this.replayMessages.push(message);
    }
  }

  recordResult(message: ChatMessage): ChatMessage {
    this.messages.push(structuredClone(message));
    const visible = toolResultForHistory(message, this.sessionId);
    this.replayMessages.push(visible);
    return visible;
  }

  finish(reason: string, forReplay = false): ChatMessage[] {
    const completed = structuredClone(
      forReplay
        ? this.replayMessages.filter(
            (message) =>
              !this.activeHistory || this.activeHistory.includes(message),
          )
        : this.messages,
    );
    const pending = new Set<string>();
    for (const message of completed) {
      for (const call of message.tool_calls || []) pending.add(call.id);
      if (message.role === 'tool' && message.tool_call_id)
        pending.delete(message.tool_call_id);
    }
    for (const id of pending) {
      completed.push({
        role: 'tool',
        tool_call_id: id,
        content: `Tool not executed: ${reason}`,
      });
    }
    return validateToolHistory(completed);
  }
}
