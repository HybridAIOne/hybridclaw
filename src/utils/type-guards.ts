export { asRecord, isRecord } from '@hybridclaw/shared/primitive-values';

export function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
}
