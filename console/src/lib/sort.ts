function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export function compareText(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  return normalizeText(left).localeCompare(normalizeText(right));
}

export function compareNumber(
  left: number | null | undefined,
  right: number | null | undefined,
): number {
  return (left ?? 0) - (right ?? 0);
}

export function compareBoolean(left: boolean, right: boolean): number {
  return Number(left) - Number(right);
}

export function compareDateTime(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const leftTimestamp = Date.parse(String(left || ''));
  const rightTimestamp = Date.parse(String(right || ''));
  return (
    (Number.isNaN(leftTimestamp) ? 0 : leftTimestamp) -
    (Number.isNaN(rightTimestamp) ? 0 : rightTimestamp)
  );
}
