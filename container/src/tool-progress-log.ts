import {
  approvalRuntime,
  type ToolApprovalEvaluation,
} from './tool-approval.js';

// The prefix marks arbitrary preview text encoded as a JSON string.
export const LINE_SAFE_TOOL_PROGRESS_PREFIX = 'json:';
export const TOOL_PROGRESS_PREVIEW_MAX_CHARS = 8_192;
const TOOL_PROGRESS_TRUNCATION_MARKER = '[tool progress truncated]';

function truncateToolProgressText(text: string): string {
  if (text.length <= TOOL_PROGRESS_PREVIEW_MAX_CHARS) return text;
  return `${text.slice(
    0,
    TOOL_PROGRESS_PREVIEW_MAX_CHARS,
  )}\n${TOOL_PROGRESS_TRUNCATION_MARKER}`;
}

export function formatLineSafeToolProgressText(text: string): string {
  return `${LINE_SAFE_TOOL_PROGRESS_PREFIX}${JSON.stringify(
    truncateToolProgressText(text),
  )}`;
}

export function formatToolCallStartProgressText(
  toolName: string,
  argsJson: string,
  approval: ToolApprovalEvaluation,
): string {
  if (approval.tier === 'yellow') {
    const preview =
      toolName === 'web_search'
        ? approval.commandPreview
        : approvalRuntime.formatYellowNarration(approval);
    return formatLineSafeToolProgressText(preview);
  }
  return formatLineSafeToolProgressText(argsJson);
}
