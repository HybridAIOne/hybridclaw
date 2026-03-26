import type { SessionShowMode } from '../types/session.js';
import type { GatewayChatResult } from './gateway-types.js';

export const DEFAULT_SESSION_SHOW_MODE: SessionShowMode = 'all';

export function isSessionShowMode(
  value: string | null | undefined,
): value is SessionShowMode {
  return (
    value === 'all' ||
    value === 'thinking' ||
    value === 'tools' ||
    value === 'none'
  );
}

export function normalizeSessionShowMode(
  value: string | null | undefined,
): SessionShowMode {
  const normalized = value?.trim().toLowerCase();
  return isSessionShowMode(normalized) ? normalized : DEFAULT_SESSION_SHOW_MODE;
}

export function sessionShowModeShowsThinking(mode: SessionShowMode): boolean {
  return mode === 'all' || mode === 'thinking';
}

export function sessionShowModeShowsActivity(mode: SessionShowMode): boolean {
  return mode !== 'none';
}

export function sessionShowModeShowsTools(mode: SessionShowMode): boolean {
  return mode === 'all' || mode === 'tools';
}

export function describeSessionShowMode(mode: SessionShowMode): string {
  switch (mode) {
    case 'thinking':
      return 'Show thinking only.';
    case 'tools':
      return 'Show tool activity only.';
    case 'none':
      return 'Hide thinking and tool activity.';
    default:
      return 'Show thinking and tool activity.';
  }
}

export function filterGatewayChatResultForSessionShowMode(
  result: GatewayChatResult,
  mode: SessionShowMode,
): GatewayChatResult {
  if (sessionShowModeShowsTools(mode)) {
    return result;
  }

  return {
    ...result,
    toolsUsed: [],
    toolExecutions: (result.toolExecutions || []).map((execution) => {
      const preserveApprovalPrompt = execution.approvalDecision === 'required';
      return {
        ...execution,
        name: '',
        arguments: '',
        result: preserveApprovalPrompt ? execution.result : '',
      };
    }),
  };
}
