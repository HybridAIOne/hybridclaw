import type { BrowserFrame, ToolProgressEvent } from '../types/execution.js';

const TOOL_NAME_PATTERN = '([a-zA-Z0-9_.-]+)';
const TOOL_LABEL_PATTERN = '(?:\\s+\\[[^\\]\\r\\n]*\\])*';
const TOOL_RESULT_RE = new RegExp(
  `^\\[tool\\]\\s+${TOOL_NAME_PATTERN}${TOOL_LABEL_PATTERN}\\s+result\\s+\\((\\d+)ms\\):\\s*(.*)$`,
);
const TOOL_START_RE = new RegExp(
  `^\\[tool\\]\\s+${TOOL_NAME_PATTERN}${TOOL_LABEL_PATTERN}:\\s*(.*)$`,
);
const LINE_SAFE_TOOL_PROGRESS_PREFIX = 'json:';

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
      preview: parseToolProgressPreview(resultMatch[3] || ''),
    };
  }

  const startMatch = line.match(TOOL_START_RE);
  if (!startMatch) return null;
  return {
    toolName: startMatch[1] || 'tool',
    phase: 'start',
    preview: parseToolProgressPreview(startMatch[2] || ''),
  };
}

function parseToolProgressPreview(raw: string): string {
  if (!raw.startsWith(LINE_SAFE_TOOL_PROGRESS_PREFIX)) return raw;
  try {
    const parsed = JSON.parse(raw.slice(LINE_SAFE_TOOL_PROGRESS_PREFIX.length));
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}

// Written by the container's browser tools just before the tool's own result
// line (`BROWSER_FRAME_LOG_PREFIX` in container/src/browser-tools.ts).
const BROWSER_FRAME_PREFIX = '[browser-frame] ';

export function parseBrowserFrameLine(line: string): BrowserFrame | null {
  if (!line.startsWith(BROWSER_FRAME_PREFIX)) return null;
  try {
    const parsed = JSON.parse(
      line.slice(BROWSER_FRAME_PREFIX.length),
    ) as Record<string, unknown> | null;
    if (!parsed || typeof parsed.url !== 'string' || !parsed.url) return null;
    return {
      url: parsed.url,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      ...(typeof parsed.frame === 'string' && parsed.frame
        ? { frame: parsed.frame }
        : {}),
    };
  } catch {
    return null;
  }
}
