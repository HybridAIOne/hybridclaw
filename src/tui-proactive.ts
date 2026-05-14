function isSchedulerJobSource(source: string | null | undefined): boolean {
  return String(source || '').startsWith('schedule-job:');
}

function isReminderSource(source: string | null | undefined): boolean {
  return String(source || '').startsWith('schedule:');
}

function isFullAutoSource(source: string | null | undefined): boolean {
  const normalized = String(source || '');
  return normalized === 'fullauto' || normalized.startsWith('fullauto:');
}

function isDelegateSource(source: string | null | undefined): boolean {
  const normalized = String(source || '');
  return normalized === 'delegate' || normalized.startsWith('delegate:');
}

function isEvalSource(source: string | null | undefined): boolean {
  const normalized = String(source || '');
  return normalized === 'eval' || normalized.startsWith('eval:');
}

function isGoalContinuationSource(source: string | null | undefined): boolean {
  const normalized = String(source || '');
  return (
    normalized === 'goal-continuation' ||
    normalized.startsWith('goal-continuation:')
  );
}

export function proactiveBadgeLabel(
  source: string | null | undefined,
): string | null {
  if (isSchedulerJobSource(source)) return null;
  if (isFullAutoSource(source)) return 'fullauto';
  if (isGoalContinuationSource(source)) return 'goal';
  if (isDelegateSource(source)) return 'delegate';
  if (isEvalSource(source)) return 'eval';
  if (isReminderSource(source)) return 'reminder';
  if (source === 'heartbeat') return 'heartbeat';
  return 'proactive';
}

export function proactiveInlineLabel(
  source: string | null | undefined,
): string | null {
  if (isGoalContinuationSource(source)) return 'Goal';
  return null;
}

export function proactiveSourceSuffix(
  source: string | null | undefined,
): string {
  if (isSchedulerJobSource(source)) return '';
  if (
    !source ||
    isFullAutoSource(source) ||
    isGoalContinuationSource(source) ||
    isDelegateSource(source) ||
    isEvalSource(source) ||
    source === 'heartbeat'
  )
    return '';
  return `(${source})`;
}
