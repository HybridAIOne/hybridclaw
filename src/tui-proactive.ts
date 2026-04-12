export function proactiveBadgeLabel(
  source: string | null | undefined,
): string | null {
  if (source === 'fullauto') return 'fullauto';
  if (source === 'eval') return 'eval';
  return 'reminder';
}

export function proactiveSourceSuffix(
  source: string | null | undefined,
): string {
  if (!source || source === 'fullauto' || source === 'eval') return '';
  return `(${source})`;
}
