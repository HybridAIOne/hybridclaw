export function formatInfo(title: string, body: string): string {
  return `**${title}**\n${body}`;
}

export function formatError(title: string, detail: string): string {
  return `**${title}:** ${detail}`;
}

export function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}
