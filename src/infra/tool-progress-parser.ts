import type { ToolProgressEvent } from '../types/execution.js';

const TOOL_NAME_PATTERN = '([a-zA-Z0-9_.-]+)';
const TOOL_LABEL_PATTERN = '(?:\\s+\\[[^\\]\\r\\n]*\\])*';
const TOOL_RESULT_RE = new RegExp(
  `^\\[tool\\]\\s+${TOOL_NAME_PATTERN}${TOOL_LABEL_PATTERN}\\s+result\\s+\\((\\d+)ms\\):\\s*(.*)$`,
);
const TOOL_START_RE = new RegExp(
  `^\\[tool\\]\\s+${TOOL_NAME_PATTERN}${TOOL_LABEL_PATTERN}:\\s*(.*)$`,
);

export type ParsedToolProgressLine = Pick<
  ToolProgressEvent,
  'toolName' | 'phase' | 'durationMs' | 'preview'
>;

export function parseToolProgressLine(
  line: string,
): ParsedToolProgressLine | null {
  const resultMatch = line.match(TOOL_RESULT_RE);
  if (resultMatch) {
    return {
      toolName: resultMatch[1] || 'tool',
      phase: 'finish',
      durationMs: parseInt(resultMatch[2] || '0', 10),
      preview: resultMatch[3] || '',
    };
  }

  const startMatch = line.match(TOOL_START_RE);
  if (!startMatch) return null;
  return {
    toolName: startMatch[1] || 'tool',
    phase: 'start',
    preview: startMatch[2] || '',
  };
}
