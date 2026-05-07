export function parseToolArgsJson(
  argsJson: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseToolArgsJsonOrThrow(
  argsJson: string,
  message: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}
