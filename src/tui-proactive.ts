export function proactiveBadgeLabel(
  source: string | null | undefined,
): string | null {
  if (source === 'fullauto') return 'fullauto';
  return null;
}

export function proactiveSourceSuffix(
  source: string | null | undefined,
): string {
  if (
    !source ||
    source === 'fullauto' ||
    source === 'command' ||
    source.startsWith('command:')
  ) {
    return '';
  }
  return `(${source})`;
}
