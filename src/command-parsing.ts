export interface CommandArgOptions {
  trim?: boolean;
  lower?: boolean;
  required?: boolean;
  defaultValue?: string;
}

export function normalizeArg(
  raw: unknown,
  options: CommandArgOptions = {},
): string {
  const fallback = options.defaultValue ?? '';
  const missing = raw == null || raw === '';
  let value = missing ? fallback : String(raw);
  if (options.trim) value = value.trim();
  if (options.lower) value = value.toLowerCase();
  if (options.required && !value) {
    throw new Error('Missing required command argument');
  }
  return value;
}

export function getArg(
  args: readonly unknown[],
  index: number,
  options: CommandArgOptions = {},
): string {
  return normalizeArg(args[index], options);
}

export function parseIdArg(
  args: readonly unknown[],
  index: number,
  options: Pick<CommandArgOptions, 'defaultValue' | 'required'> = {},
): string {
  return getArg(args, index, { ...options, trim: true });
}

export function parseLowerArg(
  args: readonly unknown[],
  index: number,
  options: Pick<CommandArgOptions, 'defaultValue' | 'required'> = {},
): string {
  return getArg(args, index, { ...options, trim: true, lower: true });
}

export function parseIntegerArg(
  args: readonly unknown[],
  index: number,
): number | null {
  const raw = parseIdArg(args, index);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}
