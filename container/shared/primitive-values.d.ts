export function isRecord(value: unknown): value is Record<string, unknown>;
export function asRecord(value: unknown): Record<string, unknown> | null;
export function readString(value: unknown): string;
export function readFiniteNumber(value: unknown): number | null;
export function readFiniteNumberOr(value: unknown, fallback: number): number;
export function parseNonNegativeInteger(value: unknown): number | null;
export function parsePositiveInteger(value: unknown): number | null;
