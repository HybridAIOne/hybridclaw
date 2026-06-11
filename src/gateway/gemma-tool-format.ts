import type { ChatMessage, ToolCall } from '../types/api.js';
import { isRecord } from '../utils/type-guards.js';

export interface GemmaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

const GEMMA_QUOTE_MARKER = '<|"|>';
const GEMMA_TOOL_CALL_OPEN = '<|tool_call>';
const GEMMA_TOOL_CALL_CLOSE = '<tool_call|>';
const GEMMA_TOOL_RESPONSE_OPEN = '<|tool_response>';
const GEMMA_TOOL_RESPONSE_CLOSE = '<tool_response|>';

function gemmaToolString(value: string): string {
  return `<|"|>${String(value || '').replace(/<\|"\|>/g, '"')}<|"|>`;
}

function gemmaToolLiteral(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value === 'string') return gemmaToolString(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => gemmaToolLiteral(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${key}:${gemmaToolLiteral(entry)}`)
      .join(',')}}`;
  }
  return gemmaToolString(String(value));
}

export function buildGemmaToolCallInstruction(
  tools: GemmaToolDefinition[],
): string {
  const declarations = tools
    .map(
      (tool) =>
        `<|tool>declaration:${tool.function.name}{description:${gemmaToolString(
          tool.function.description || '',
        )},parameters:${gemmaToolLiteral(tool.function.parameters || {})}}<tool|>`,
    )
    .join('\n');
  return [
    'Available tools are declared below. If a user request requires one of these tools, call it instead of saying it is unavailable.',
    declarations,
    'Emit Gemma tool calls exactly as <|tool_call>call:TOOL_NAME{ARGUMENT_NAME:ARGUMENT_VALUE}<tool_call|><|tool_response> and do not wrap them in Markdown.',
    'Use <|"|>text<|"|> for string argument values.',
  ].join('\n');
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function contentToGemmaText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

function renderGemmaToolCall(toolCall: ToolCall): string {
  return `${GEMMA_TOOL_CALL_OPEN}call:${toolCall.function.name}${gemmaToolLiteral(
    parseJsonValue(toolCall.function.arguments),
  )}${GEMMA_TOOL_CALL_CLOSE}`;
}

function renderGemmaToolResponse(name: string, response: unknown): string {
  return `${GEMMA_TOOL_RESPONSE_OPEN}response:${name}${gemmaToolLiteral(
    response,
  )}${GEMMA_TOOL_RESPONSE_CLOSE}`;
}

function findBalancedBraceEnd(text: string, startIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let gemmaQuoted = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (gemmaQuoted) {
      if (text.startsWith(GEMMA_QUOTE_MARKER, index)) {
        gemmaQuoted = false;
        index += GEMMA_QUOTE_MARKER.length - 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (text.startsWith(GEMMA_QUOTE_MARKER, index)) {
      gemmaQuoted = true;
      index += GEMMA_QUOTE_MARKER.length - 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function replaceGemmaQuotedStrings(text: string): string {
  let out = '';
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(GEMMA_QUOTE_MARKER, cursor);
    if (start < 0) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, start);
    const valueStart = start + GEMMA_QUOTE_MARKER.length;
    const end = text.indexOf(GEMMA_QUOTE_MARKER, valueStart);
    if (end < 0) {
      out += text.slice(start);
      break;
    }
    out += JSON.stringify(text.slice(valueStart, end));
    cursor = end + GEMMA_QUOTE_MARKER.length;
  }
  return out;
}

function splitGemmaSegments(text: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const stack: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }
    if (
      (char === '}' && stack.at(-1) === '{') ||
      (char === ']' && stack.at(-1) === '[')
    ) {
      stack.pop();
      continue;
    }
    if (char === ',' && stack.length === 0) {
      segments.push(text.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(text.slice(start));
  return segments;
}

function findGemmaKeySeparator(text: string): number {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const stack: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }
    if (
      (char === '}' && stack.at(-1) === '{') ||
      (char === ']' && stack.at(-1) === '[')
    ) {
      stack.pop();
      continue;
    }
    if (char === ':' && stack.length === 0) return index;
  }
  return -1;
}

function parseGemmaLiteral(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const body = trimmed.slice(1, -1).trim();
    const objectValue: Record<string, unknown> = {};
    if (!body) return objectValue;
    for (const segment of splitGemmaSegments(body)) {
      const separator = findGemmaKeySeparator(segment);
      if (separator < 1) throw new Error('Invalid Gemma tool arguments');
      const key = segment
        .slice(0, separator)
        .trim()
        .replace(/^["']|["']$/g, '');
      objectValue[key] = parseGemmaLiteral(segment.slice(separator + 1));
    }
    return objectValue;
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const body = trimmed.slice(1, -1).trim();
    return body ? splitGemmaSegments(body).map(parseGemmaLiteral) : [];
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return parseJsonValue(trimmed.replace(/^'/, '"').replace(/'$/, '"'));
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseGemmaToolArguments(text: string): unknown {
  const normalized = replaceGemmaQuotedStrings(text);
  try {
    return JSON.parse(normalized);
  } catch {
    return parseGemmaLiteral(normalized);
  }
}

function isGemmaCallBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;
  const previous = text[index - 1] || '';
  return /\s/.test(previous) || !/[A-Za-z0-9_]/.test(previous);
}

function gemmaToolCallRemovalEnd(text: string, argumentsEnd: number): number {
  const lower = text.toLowerCase();
  let end = argumentsEnd + 1;
  if (lower.startsWith(GEMMA_TOOL_CALL_CLOSE, end)) {
    end += GEMMA_TOOL_CALL_CLOSE.length;
  }
  if (lower.startsWith(GEMMA_TOOL_RESPONSE_OPEN, end)) {
    end += GEMMA_TOOL_RESPONSE_OPEN.length;
  }
  return end;
}

function stripRanges(
  text: string,
  ranges: Array<{ start: number; end: number }>,
): string | null {
  let cursor = 0;
  let out = '';
  for (const range of ranges.sort((left, right) => left.start - right.start)) {
    out += text.slice(cursor, range.start);
    cursor = range.end;
  }
  out += text.slice(cursor);
  const normalized = out.replace(/\n{3,}/g, '\n\n').trim();
  return normalized || null;
}

export function extractGemmaToolCalls(content: string): {
  content: string | null;
  toolCalls: ToolCall[];
} {
  const removals: Array<{ start: number; end: number }> = [];
  const toolCalls: ToolCall[] = [];
  const pattern = /\bcall:\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*(?=\{)/gi;
  let match: RegExpExecArray | null = pattern.exec(content);
  while (match) {
    const start = match.index;
    const markerStart = start - GEMMA_TOOL_CALL_OPEN.length;
    const hasOpenMarker =
      markerStart >= 0 &&
      content.slice(markerStart, start).toLowerCase() === GEMMA_TOOL_CALL_OPEN;
    if (!isGemmaCallBoundary(content, start) && !hasOpenMarker) {
      match = pattern.exec(content);
      continue;
    }
    const argumentsStart = pattern.lastIndex;
    const argumentsEnd = findBalancedBraceEnd(content, argumentsStart);
    if (argumentsEnd < argumentsStart) {
      match = pattern.exec(content);
      continue;
    }
    try {
      const parsed = parseGemmaToolArguments(
        content.slice(argumentsStart, argumentsEnd + 1),
      );
      const argumentObject =
        isRecord(parsed) && !Array.isArray(parsed) ? parsed : {};
      toolCalls.push({
        id: '',
        type: 'function',
        function: {
          name: match[1],
          arguments: JSON.stringify(argumentObject),
        },
      });
      removals.push({
        start: hasOpenMarker ? markerStart : start,
        end: gemmaToolCallRemovalEnd(content, argumentsEnd),
      });
      pattern.lastIndex = gemmaToolCallRemovalEnd(content, argumentsEnd);
    } catch {
      pattern.lastIndex = start + 'call:'.length;
    }
    match = pattern.exec(content);
  }
  return toolCalls.length > 0
    ? { content: stripRanges(content, removals), toolCalls }
    : { content, toolCalls: [] };
}

export function mergeSystemInstruction(
  messages: Array<Record<string, unknown>>,
  instruction: string,
): Array<Record<string, unknown>> {
  const normalizedInstruction = instruction.trim();
  if (!normalizedInstruction) return messages;
  if (messages[0]?.role === 'system') {
    const existing =
      typeof messages[0].content === 'string' ? messages[0].content.trim() : '';
    if (existing.includes(normalizedInstruction)) return messages;
    return [
      {
        ...messages[0],
        content: existing
          ? `${existing}\n\n${normalizedInstruction}`
          : normalizedInstruction,
      },
      ...messages.slice(1),
    ];
  }
  return [{ role: 'system', content: normalizedInstruction }, ...messages];
}

export function buildGemmaRequestMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  let pendingAssistant: { role: 'assistant'; content: string } | null = null;
  let pendingCalls: Array<{
    id: string;
    name: string;
    used: boolean;
  }> = [];
  const flushPendingAssistant = (): void => {
    if (pendingAssistant) result.push(pendingAssistant);
    pendingAssistant = null;
    pendingCalls = [];
  };

  for (const message of messages) {
    if (
      message.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    ) {
      flushPendingAssistant();
      pendingCalls = message.tool_calls.map((toolCall) => ({
        id: toolCall.id || '',
        name: toolCall.function.name,
        used: false,
      }));
      pendingAssistant = {
        role: 'assistant',
        content: [
          contentToGemmaText(message.content).trim(),
          message.tool_calls.map(renderGemmaToolCall).join(''),
        ]
          .filter(Boolean)
          .join('\n'),
      };
      continue;
    }

    if (message.role === 'tool' && pendingAssistant) {
      const responseCall =
        pendingCalls.find(
          (call) =>
            !call.used &&
            call.id &&
            message.tool_call_id &&
            call.id === message.tool_call_id,
        ) || pendingCalls.find((call) => !call.used);
      if (responseCall) {
        responseCall.used = true;
        pendingAssistant.content += renderGemmaToolResponse(
          responseCall.name,
          typeof message.content === 'string'
            ? parseJsonValue(message.content)
            : message.content,
        );
        continue;
      }
    }

    flushPendingAssistant();
    result.push({ ...message });
  }

  flushPendingAssistant();
  return result;
}
