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
): ChatMessage[] {
  const collapsed = collapseSystemMessages(messages);
  const normalizedInstruction = instruction.trim();
  if (!normalizedInstruction) return collapsed;

  if (collapsed[0]?.role === 'system') {
    const existing = contentToText(collapsed[0].content).trim();
    if (existing.includes(normalizedInstruction)) return collapsed;
    collapsed[0] = {
      role: 'system',
      content: existing
        ? `${existing}\n\n${normalizedInstruction}`
        : normalizedInstruction,
    };
    return collapsed;
  }

  return [{ role: 'system', content: normalizedInstruction }, ...collapsed];
}
