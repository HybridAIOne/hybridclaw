/**
 * System-message shaping for providers that accept one system block: collapse
 * every system message into the first slot, or merge an instruction into an
 * existing one. Always returns shallow copies; inputs are never mutated.
 */
import type { ChatMessage } from '@hybridclaw/contracts/agent-io';
import { chatContentText } from './message-text.ts';

export function collapseSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemBlocks: string[] = [];
  const remaining: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role !== 'system') {
      remaining.push(message);
      continue;
    }

    const text = chatContentText(message.content).trim();
    if (text) systemBlocks.push(text);
  }

  if (systemBlocks.length === 0) {
    return messages.map((message) => ({ ...message }));
  }

  return [
    {
      role: 'system',
      content: systemBlocks.join('\n\n'),
    },
    ...remaining.map((message) => ({ ...message })),
  ];
}

export function mergeSystemMessage(
  messages: ChatMessage[],
  instruction: string,
  target: 'first' | 'last' = 'first',
): ChatMessage[] {
  const merged = messages.map((message) => ({ ...message }));
  const normalizedInstruction = instruction.trim();
  if (!normalizedInstruction) return merged;

  let systemIndex = -1;
  if (target === 'first') {
    systemIndex = merged.findIndex((message) => message.role === 'system');
  } else {
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      if (merged[index].role !== 'system') continue;
      systemIndex = index;
      break;
    }
  }
  if (systemIndex >= 0) {
    const existing = chatContentText(merged[systemIndex].content).trim();
    if (existing.includes(normalizedInstruction)) return merged;
    merged[systemIndex] = {
      role: 'system',
      content: existing
        ? `${existing}\n\n${normalizedInstruction}`
        : normalizedInstruction,
    };
    return merged;
  }

  return [{ role: 'system', content: normalizedInstruction }, ...merged];
}
