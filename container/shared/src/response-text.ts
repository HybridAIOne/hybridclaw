function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function extractResponseTextContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const chunks: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.trim()) chunks.push(part.trim());
      continue;
    }
    if (!isRecord(part)) continue;
    const text =
      typeof part.text === 'string'
        ? part.text
        : typeof part.output_text === 'string'
          ? part.output_text
          : '';
    if (text.trim()) chunks.push(text.trim());
  }
  return chunks.join('\n').trim();
}
