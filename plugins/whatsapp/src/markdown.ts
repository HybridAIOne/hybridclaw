const FENCE_PLACEHOLDER = '\u0000WA_FENCE_';
const INLINE_CODE_PLACEHOLDER = '\u0000WA_CODE_';
const BOLD_PLACEHOLDER = '\u0000WA_BOLD_';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function restorePlaceholders(
  text: string,
  placeholder: string,
  segments: string[],
): string {
  return text.replace(
    new RegExp(`${escapeRegExp(placeholder)}(\\d+)`, 'g'),
    (_match, index: string) => segments[Number(index)] ?? '',
  );
}

export function markdownToWhatsApp(text: string): string {
  if (!text) return text;

  const fences: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    fences.push(match);
    return `${FENCE_PLACEHOLDER}${fences.length - 1}`;
  });

  const inlineCodes: string[] = [];
  result = result.replace(/`[^`\n]+`/g, (match) => {
    inlineCodes.push(match);
    return `${INLINE_CODE_PLACEHOLDER}${inlineCodes.length - 1}`;
  });

  const boldSegments: string[] = [];
  result = result.replace(/\*\*(.+?)\*\*/g, (_match, content: string) => {
    boldSegments.push(`*${content}*`);
    return `${BOLD_PLACEHOLDER}${boldSegments.length - 1}`;
  });
  result = result.replace(/__(.+?)__/g, (_match, content: string) => {
    boldSegments.push(`*${content}*`);
    return `${BOLD_PLACEHOLDER}${boldSegments.length - 1}`;
  });

  result = result.replace(/~~(.+?)~~/g, '~$1~');
  result = result.replace(
    /(^|[^\w*])\*(\S(?:[^*\n]*?\S)?)\*(?=($|[^\w*]))/g,
    '$1_$2_',
  );

  result = restorePlaceholders(result, BOLD_PLACEHOLDER, boldSegments);
  result = restorePlaceholders(result, INLINE_CODE_PLACEHOLDER, inlineCodes);
  result = restorePlaceholders(result, FENCE_PLACEHOLDER, fences);

  return result;
}
