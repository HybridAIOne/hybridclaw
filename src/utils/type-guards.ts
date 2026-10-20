export { asRecord, isRecord } from '../../container/shared/primitive-values.js';

export function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
}
