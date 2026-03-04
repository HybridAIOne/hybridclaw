const CONTROL_COMMAND_RE = /^\/(stop|pause|clear|cancel|resume)\b/i;

export const DEFAULT_DEBOUNCE_MS = 2_500;
export const DEFAULT_DEBOUNCE_MAX_BUFFER = 5;

export function resolveInboundDebounceMs(
  globalDebounceMs: number,
  channelOverrideMs?: number,
): number {
  const selected = channelOverrideMs ?? globalDebounceMs;
  return Math.max(0, Math.floor(selected));
}

export function shouldDebounceInbound(params: {
  content: string;
  hasAttachments: boolean;
  isPrefixedCommand: boolean;
}): boolean {
  const normalized = params.content.trim();
  if (!normalized) return false;
  if (params.hasAttachments) return false;
  if (params.isPrefixedCommand) return false;
  if (CONTROL_COMMAND_RE.test(normalized)) return false;
  return true;
}
