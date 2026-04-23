function isSchedulerJobSource(source: string | null | undefined): boolean {
  return String(source || '').startsWith('schedule-job:');
}

function isDelegateSource(source: string | null | undefined): boolean {
  const normalized = String(source || '');
  return normalized === 'delegate' || normalized.startsWith('delegate:');
}

export function proactiveBadgeLabel(
  source: string | null | undefined,
): string | null {
  if (isSchedulerJobSource(source)) return null;
  if (source === 'fullauto') return 'fullauto';
  if (isDelegateSource(source)) return 'delegate';
  if (source === 'eval') return 'eval';
  return 'reminder';
}

export function proactiveSourceSuffix(
  source: string | null | undefined,
): string {
  if (isSchedulerJobSource(source)) return '';
  if (
    !source ||
    source === 'fullauto' ||
    isDelegateSource(source) ||
    source === 'eval'
  )
    return '';
  return `(${source})`;
}
