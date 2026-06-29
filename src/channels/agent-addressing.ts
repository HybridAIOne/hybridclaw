// Unlike the gateway-side slugify, this keeps the label's original case so
// channel text stays readable; the gateway resolver lowercases handles before
// alias matching, so case never affects routing.
function slugifyAgentLabel(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/^@+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function formatNativeAgentMention(label: string): string {
  const slug = slugifyAgentLabel(label);
  return slug ? `@${slug}` : '';
}

export function normalizeNativeAgentAddressingText(text: string): string {
  if (!text.startsWith('@')) return text;
  return text
    .replace(/^@["']([^"']+)["'](?=\s|$)/u, (_match, label: string) => {
      return formatNativeAgentMention(label);
    })
    .replace(/^@\[([^\]]+)\](?=\s|$)/u, (_match, label: string) => {
      return formatNativeAgentMention(label);
    });
}
