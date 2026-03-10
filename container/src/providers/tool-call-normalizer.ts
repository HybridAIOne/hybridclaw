import type { ToolCall } from '../types.js';

const TOOL_CALL_TAGS = [
  { open: '<tool_call>', close: '</tool_call>' },
  { open: '[tool_call]', close: '[/tool_call]' },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function findCodeFenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const pattern = /```[\s\S]*?```/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    ranges.push([match.index, match.index + match[0].length]);
    match = pattern.exec(text);
  }
  return ranges;
}

function isProtectedIndex(
  index: number,
  ranges: Array<[number, number]>,
): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function normalizeToolName(rawName: string): string {
  const trimmed = String(rawName || '').trim();
  if (
    /^tool\.call$/i.test(trimmed) ||
    /^tool_call(?:[<>].*)?$/i.test(trimmed)
  ) {
    return trimmed;
  }
  return trimmed.replace(/^(?:tools?|tool)\./i, '');
}

function isWrapperToolName(name: string): boolean {
  const normalized = String(name || '')
    .trim()
    .toLowerCase();
  return (
    normalized === 'tool_call' ||
    normalized === 'tool.call' ||
    normalized.startsWith('tool_call>') ||
    normalized.startsWith('tool_call<')
  );
}

function stripControlCharacters(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping C0 control chars from LLM output
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, '$1');
}

function balanceJsonDelimiters(text: string): string {
  const stack: string[] = [];
  let out = '';
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      out += char;
      continue;
    }

    if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack.at(-1) === expected) {
        stack.pop();
        out += char;
      }
      continue;
    }

    out += char;
  }

  while (stack.length > 0) {
    out += stack.pop() === '{' ? '}' : ']';
  }

  return out;
}

function repairJsonLike(text: string): string {
  return balanceJsonDelimiters(
    removeTrailingCommas(stripControlCharacters(String(text || ''))),
  );
}

function extractJsonCandidate(text: string): string | null {
  const source = String(text || '');
  const start = source.search(/[{[]/);
  if (start < 0) return null;

  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }
    if (char === '}' || char === ']') {
      if (stack.length > 0) stack.pop();
      if (stack.length === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return source.slice(start);
}

function parseJsonCandidate(text: string): unknown {
  const candidate = extractJsonCandidate(text) || String(text || '').trim();
  return JSON.parse(repairJsonLike(candidate));
}

function normalizeArguments(rawArguments: unknown): string {
  if (rawArguments == null) return '{}';
  if (typeof rawArguments === 'string') {
    const trimmed = rawArguments.trim();
    return trimmed || '{}';
  }
  return JSON.stringify(rawArguments);
}

function unwrapToolNameAndArguments(
  rawName: unknown,
  rawArguments: unknown,
  depth = 0,
): { name: string; arguments: string } | null {
  if (depth > 4) return null;
  const name = normalizeToolName(typeof rawName === 'string' ? rawName : '');
  if (!name) return null;

  if (isWrapperToolName(name)) {
    let parsed: unknown;
    try {
      parsed =
        typeof rawArguments === 'string' || isRecord(rawArguments)
          ? isRecord(rawArguments)
            ? rawArguments
            : parseJsonCandidate(rawArguments)
          : rawArguments;
    } catch {
      parsed = null;
    }
    if (isRecord(parsed) && typeof parsed.name === 'string') {
      return unwrapToolNameAndArguments(
        parsed.name,
        parsed.arguments,
        depth + 1,
      );
    }
  }

  return {
    name,
    arguments: normalizeArguments(rawArguments),
  };
}

function normalizeToolCallLike(rawToolCall: unknown): ToolCall | null {
  if (!isRecord(rawToolCall)) return null;
  const functionRecord = isRecord(rawToolCall.function)
    ? rawToolCall.function
    : null;
  const normalized = unwrapToolNameAndArguments(
    functionRecord?.name ?? rawToolCall.name,
    functionRecord?.arguments ?? rawToolCall.arguments,
  );
  if (!normalized) return null;
  return {
    id:
      typeof rawToolCall.id === 'string' && rawToolCall.id.trim()
        ? rawToolCall.id.trim()
        : '',
    type: 'function',
    function: normalized,
  };
}

function parseToolCallObject(raw: unknown): ToolCall | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.function)) {
    return normalizeToolCallLike(raw);
  }
  if (typeof raw.name === 'string') {
    return normalizeToolCallLike({
      id: typeof raw.id === 'string' ? raw.id : '',
      function: {
        name: raw.name,
        arguments: raw.arguments,
      },
    });
  }
  return null;
}

function parseEmbeddedToolCall(payloadText: string): ToolCall | null {
  try {
    const parsed = parseToolCallObject(parseJsonCandidate(payloadText));
    if (parsed) return parsed;
  } catch {
    // Fall through to name-prefixed recovery.
  }

  const namePrefixedMatch = payloadText.match(
    /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*(\{[\s\S]*)$/,
  );
  if (!namePrefixedMatch) return null;

  try {
    const argumentsPayload = parseJsonCandidate(namePrefixedMatch[2]);
    return normalizeToolCallLike({
      function: {
        name: namePrefixedMatch[1],
        arguments: argumentsPayload,
      },
    });
  } catch {
    return null;
  }
}

function stripMarkedRanges(
  text: string,
  ranges: Array<{ start: number; end: number }>,
): string | null {
  if (ranges.length === 0) {
    return text.trim() ? text.trim() : null;
  }
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

function extractTaggedToolCalls(content: string): {
  content: string | null;
  toolCalls: ToolCall[];
} {
  const lower = content.toLowerCase();
  const protectedRanges = findCodeFenceRanges(content);
  const removals: Array<{ start: number; end: number }> = [];
  const toolCalls: ToolCall[] = [];

  let cursor = 0;
  while (cursor < content.length) {
    let nextTag: {
      open: string;
      close: string;
      start: number;
      openLength: number;
    } | null = null;

    for (const tag of TOOL_CALL_TAGS) {
      let start = lower.indexOf(tag.open, cursor);
      while (start >= 0 && isProtectedIndex(start, protectedRanges)) {
        start = lower.indexOf(tag.open, start + 1);
      }
      if (start < 0) continue;
      if (!nextTag || start < nextTag.start) {
        nextTag = {
          open: tag.open,
          close: tag.close,
          start,
          openLength: tag.open.length,
        };
      }
    }

    if (!nextTag) break;

    let closeIndex = lower.indexOf(
      nextTag.close,
      nextTag.start + nextTag.openLength,
    );
    while (closeIndex >= 0 && isProtectedIndex(closeIndex, protectedRanges)) {
      closeIndex = lower.indexOf(nextTag.close, closeIndex + 1);
    }

    const payloadStart = nextTag.start + nextTag.openLength;
    const payloadEnd = closeIndex >= 0 ? closeIndex : content.length;
    const payload = content.slice(payloadStart, payloadEnd);
    const parsed = parseEmbeddedToolCall(payload);
    if (!parsed) {
      cursor = payloadStart;
      continue;
    }

    toolCalls.push(parsed);
    removals.push({
      start: nextTag.start,
      end: closeIndex >= 0 ? closeIndex + nextTag.close.length : content.length,
    });
    cursor =
      closeIndex >= 0 ? closeIndex + nextTag.close.length : content.length;
  }

  return {
    content: stripMarkedRanges(content, removals),
    toolCalls,
  };
}

export function normalizeToolCalls(
  toolCalls: ToolCall[] | undefined,
  responseContent: string | null,
): { content: string | null; toolCalls: ToolCall[] } {
  const normalizedToolCalls = Array.isArray(toolCalls)
    ? toolCalls
        .map((call) => normalizeToolCallLike(call))
        .filter((call): call is ToolCall => call !== null)
    : [];
  if (normalizedToolCalls.length > 0) {
    return { content: responseContent, toolCalls: normalizedToolCalls };
  }

  if (!responseContent) {
    return { content: responseContent, toolCalls: [] };
  }

  const extracted = extractTaggedToolCalls(responseContent);
  if (extracted.toolCalls.length > 0) {
    return extracted;
  }

  return { content: responseContent, toolCalls: [] };
}
