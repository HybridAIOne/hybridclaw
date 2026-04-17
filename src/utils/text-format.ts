export function formatInfo(title: string, body: string): string {
  return `**${title}**\n${body}`;
}

export function formatError(title: string, detail: string): string {
  return `**${title}:** ${detail}`;
}

/**
 * Returns `singular` when `n === 1`, otherwise `plural`. Used anywhere user
 * output needs to swap a noun form based on a count — avoids every caller
 * re-implementing the same ternary with its own edge cases.
 */
export function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}
