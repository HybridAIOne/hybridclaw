function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function extractResponseTextContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const chunks = [];
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
