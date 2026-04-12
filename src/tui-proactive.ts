function isSchedulerJobSource(source: string | null | undefined): boolean {
  return String(source || '').startsWith('schedule-job:');
}

export function proactiveBadgeLabel(
  source: string | null | undefined,
): string | null {
  if (isSchedulerJobSource(source)) return null;
  if (source === 'fullauto') return 'fullauto';
  if (source === 'eval') return 'eval';
  return 'reminder';
}

export function proactiveSourceSuffix(
  source: string | null | undefined,
): string {
  if (isSchedulerJobSource(source)) return '';
  if (!source || source === 'fullauto' || source === 'eval') return '';
  return `(${source})`;
}
