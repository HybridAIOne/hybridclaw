import type { ChatMessage, ChatMessageContent } from './types.js';

function contentToText(content: ChatMessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const chunks: string[] = [];
  for (const part of content) {
    if (part.type !== 'text' || !part.text) continue;
    chunks.push(part.text);
  }
  return chunks.join('\n');
}

export function collapseSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemBlocks: string[] = [];
  const remaining: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role !== 'system') {
      remaining.push(message);
      continue;
    }

    const text = contentToText(message.content).trim();
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
    const existing = contentToText(merged[systemIndex].content).trim();
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
