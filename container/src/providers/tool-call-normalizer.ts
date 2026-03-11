import type { ToolCall } from '../types.js';

const TOOL_CALL_TAGS = [
  { open: '<tool_call>', close: '</tool_call>' },
  { open: '[tool_call]', close: '[/tool_call]' },
] as const;

const DEEPSEEK_TOOL_CALLS_BEGIN = '<｜tool▁calls▁begin｜>';
const KIMI_K2_START_TOKENS = [
  '<|tool_calls_section_begin|>',
  '<|tool_call_section_begin|>',
] as const;

export type ToolCallTextParser =
  | 'hermes'
  | 'qwen'
  | 'qwen3_coder'
  | 'mistral'
  | 'deepseek_v3'
  | 'deepseek_v3_1'
  | 'kimi_k2';

export interface NormalizeToolCallOptions {
  parser?: ToolCallTextParser | null;
  recoverBlankStructuredNameFromContent?: boolean;
}

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

function extractMistralToolCalls(content: string): {
  content: string | null;
  toolCalls: ToolCall[];
} {
  const match = content.match(/\[TOOL_CALLS\]/i);
  if (!match || typeof match.index !== 'number') {
    return { content, toolCalls: [] };
  }

  const rawContent = content.slice(0, match.index).trim() || null;
  const rawParts = content
    .slice(match.index)
    .split(/\[TOOL_CALLS\]/i)
    .slice(1)
    .map((part) => part.trim())
    .filter(Boolean);
  if (rawParts.length === 0) {
    return { content, toolCalls: [] };
  }

  const toolCalls: ToolCall[] = [];
  const firstPart = rawParts[0];
  const isPreV11 = firstPart.startsWith('[') || firstPart.startsWith('{');

  if (isPreV11) {
    try {
      const parsed = parseJsonCandidate(firstPart);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const toolCall = parseToolCallObject(item);
        if (toolCall) {
          toolCalls.push(toolCall);
        }
      }
    } catch {
      return { content, toolCalls: [] };
    }
  } else {
    for (const rawPart of rawParts) {
      const nameMatch = rawPart.match(
        /^([A-Za-z_][A-Za-z0-9_.-]*)\s*(\{[\s\S]*)$/,
      );
      if (!nameMatch) continue;
      try {
        const toolCall = normalizeToolCallLike({
          function: {
            name: nameMatch[1],
            arguments: parseJsonCandidate(nameMatch[2]),
          },
        });
        if (toolCall) {
          toolCalls.push(toolCall);
        }
      } catch {
        return { content, toolCalls: [] };
      }
    }
  }

  return toolCalls.length > 0
    ? { content: rawContent, toolCalls }
    : { content, toolCalls: [] };
}

function tryConvertParameterValue(value: string): unknown {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'null') return null;
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function extractQwen3CoderToolCalls(content: string): {
  content: string | null;
  toolCalls: ToolCall[];
} {
  if (!content.includes('<function=')) {
    return { content, toolCalls: [] };
  }

  const toolCallBlocks = Array.from(
    content.matchAll(/<tool_call>(.*?)<\/tool_call>|<tool_call>(.*?)$/gs),
  );
  const rawBlocks = toolCallBlocks
    .map((match) => match[1] || match[2] || '')
    .filter(Boolean);
  const blocks = rawBlocks.length > 0 ? rawBlocks : [content];
  const toolCalls: ToolCall[] = [];

  for (const block of blocks) {
    for (const functionMatch of block.matchAll(
      /<function=(.*?)<\/function>|<function=(.*)$/gs,
    )) {
      const functionStr = functionMatch[1] || functionMatch[2] || '';
      const gtIndex = functionStr.indexOf('>');
      if (gtIndex < 0) continue;

      const name = functionStr.slice(0, gtIndex).trim();
      const paramsText = functionStr.slice(gtIndex + 1);
      const parameters: Record<string, unknown> = {};
      for (const paramMatch of paramsText.matchAll(
        /<parameter=(.*?)(?:<\/parameter>|(?=<parameter=)|(?=<\/function>)|$)/gs,
      )) {
        const paramText = paramMatch[1] || '';
        const paramGtIndex = paramText.indexOf('>');
        if (paramGtIndex < 0) continue;
        const paramName = paramText.slice(0, paramGtIndex).trim();
        const paramValue = paramText.slice(paramGtIndex + 1).trim();
        parameters[paramName] = tryConvertParameterValue(paramValue);
      }

      const toolCall = normalizeToolCallLike({
        function: {
          name,
          arguments: parameters,
        },
      });
      if (toolCall) {
        toolCalls.push(toolCall);
      }
    }
  }

  if (toolCalls.length === 0) {
    return { content, toolCalls: [] };
  }

  const toolCallStart = content.indexOf('<tool_call>');
  const functionStart = content.indexOf('<function=');
  const contentStart =
    toolCallStart >= 0
      ? toolCallStart
      : functionStart >= 0
        ? functionStart
        : content.length;
  const visibleContent = content.slice(0, contentStart).trim() || null;
  return {
    content: visibleContent,
    toolCalls,
  };
}

function extractDeepSeekV3ToolCalls(content: string): {
  content: string | null;
  toolCalls: ToolCall[];
} {
  if (!content.includes(DEEPSEEK_TOOL_CALLS_BEGIN)) {
    return { content, toolCalls: [] };
  }

  const toolCalls: ToolCall[] = [];
  for (const match of content.matchAll(
    /<｜tool▁call▁begin｜>(.*?)<｜tool▁sep｜>(.*?)\n```json\n([\s\S]*?)\n```<｜tool▁call▁end｜>/g,
  )) {
    const toolCall = normalizeToolCallLike({
      function: {
        name: match[2]?.trim(),
        arguments: match[3]?.trim(),
      },
    });
    if (toolCall) {
      toolCalls.push(toolCall);
    }
  }

  return toolCalls.length > 0
    ? {
        content:
          content.slice(0, content.indexOf(DEEPSEEK_TOOL_CALLS_BEGIN)).trim() ||
          null,
        toolCalls,
      }
    : { content, toolCalls: [] };
}

function extractDeepSeekV31ToolCalls(content: string): {
  content: string | null;
  toolCalls: ToolCall[];
} {
  if (!content.includes(DEEPSEEK_TOOL_CALLS_BEGIN)) {
    return { content, toolCalls: [] };
  }

  const toolCalls: ToolCall[] = [];
  for (const match of content.matchAll(
    /<｜tool▁call▁begin｜>(.*?)<｜tool▁sep｜>(.*?)<｜tool▁call▁end｜>/g,
  )) {
    const toolCall = normalizeToolCallLike({
      function: {
        name: match[1]?.trim(),
        arguments: match[2]?.trim(),
      },
    });
    if (toolCall) {
      toolCalls.push(toolCall);
    }
  }

  return toolCalls.length > 0
    ? {
        content:
          content.slice(0, content.indexOf(DEEPSEEK_TOOL_CALLS_BEGIN)).trim() ||
          null,
        toolCalls,
      }
    : { content, toolCalls: [] };
}

function extractKimiK2ToolCalls(content: string): {
  content: string | null;
  toolCalls: ToolCall[];
} {
  const startToken = KIMI_K2_START_TOKENS.find((token) =>
    content.includes(token),
  );
  if (!startToken) {
    return { content, toolCalls: [] };
  }

  const toolCalls: ToolCall[] = [];
  for (const match of content.matchAll(
    /<\|tool_call_begin\|>\s*([^<]+:\d+)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g,
  )) {
    const functionId = match[1]?.trim() || '';
    const functionName = functionId.split(':')[0]?.split('.').at(-1) || '';
    const toolCall = normalizeToolCallLike({
      id: functionId,
      function: {
        name: functionName,
        arguments: match[2]?.trim(),
      },
    });
    if (toolCall) {
      toolCalls.push(toolCall);
    }
  }

  return toolCalls.length > 0
    ? {
        content: content.slice(0, content.indexOf(startToken)).trim() || null,
        toolCalls,
      }
    : { content, toolCalls: [] };
}

function parseTextToolCalls(
  parser: ToolCallTextParser | null | undefined,
  responseContent: string,
): { content: string | null; toolCalls: ToolCall[] } {
  switch (parser) {
    case 'hermes':
    case 'qwen':
      return extractTaggedToolCalls(responseContent);
    case 'qwen3_coder':
      return extractQwen3CoderToolCalls(responseContent);
    case 'mistral':
      return extractMistralToolCalls(responseContent);
    case 'deepseek_v3':
      return extractDeepSeekV3ToolCalls(responseContent);
    case 'deepseek_v3_1':
      return extractDeepSeekV31ToolCalls(responseContent);
    case 'kimi_k2':
      return extractKimiK2ToolCalls(responseContent);
    default:
      return { content: responseContent, toolCalls: [] };
  }
}

function recoverBlankStructuredToolNameFromContent(
  structuredToolCalls: ToolCall[],
  responseContent: string | null,
): { content: string | null; toolCalls: ToolCall[] } | null {
  const bareToolName = String(responseContent || '').trim();
  if (
    structuredToolCalls.length !== 1 ||
    !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(bareToolName)
  ) {
    return null;
  }

  const rawCall = structuredToolCalls[0];
  const functionRecord = isRecord(rawCall.function) ? rawCall.function : null;
  const rawCallRecord = rawCall as unknown as Record<string, unknown>;
  const recoveredToolCall = normalizeToolCallLike({
    ...rawCall,
    function: {
      ...functionRecord,
      name: bareToolName,
      arguments: functionRecord?.arguments ?? rawCallRecord.arguments,
    },
  });
  return recoveredToolCall
    ? { content: null, toolCalls: [recoveredToolCall] }
    : null;
}

export function resolveToolCallTextParser(
  model: string | undefined,
): ToolCallTextParser | null {
  const normalizedModel = String(model || '')
    .trim()
    .toLowerCase();
  if (!normalizedModel) return null;

  if (normalizedModel.includes('qwen3') && normalizedModel.includes('coder')) {
    return 'qwen3_coder';
  }
  if (normalizedModel.includes('qwen') || normalizedModel.includes('qwq')) {
    return 'qwen';
  }
  if (
    normalizedModel.includes('mistral') ||
    normalizedModel.includes('ministral') ||
    normalizedModel.includes('devstral')
  ) {
    return 'mistral';
  }
  if (normalizedModel.includes('deepseek')) {
    if (
      normalizedModel.includes('3.1') ||
      normalizedModel.includes('v3.1') ||
      normalizedModel.includes('v31')
    ) {
      return 'deepseek_v3_1';
    }
    return 'deepseek_v3';
  }
  if (normalizedModel.includes('kimi') && normalizedModel.includes('k2')) {
    return 'kimi_k2';
  }
  if (normalizedModel.includes('hermes')) {
    return 'hermes';
  }
  return null;
}

export function normalizeToolCalls(
  toolCalls: ToolCall[] | undefined,
  responseContent: string | null,
  options?: NormalizeToolCallOptions,
): { content: string | null; toolCalls: ToolCall[] } {
  const structuredToolCalls = Array.isArray(toolCalls) ? toolCalls : [];
  if (structuredToolCalls.length > 0) {
    const normalizedToolCalls = structuredToolCalls
      .map((call) => normalizeToolCallLike(call))
      .filter((call): call is ToolCall => call !== null);
    if (normalizedToolCalls.length > 0) {
      return { content: responseContent, toolCalls: normalizedToolCalls };
    }

    if (options?.recoverBlankStructuredNameFromContent) {
      const recovered = recoverBlankStructuredToolNameFromContent(
        structuredToolCalls,
        responseContent,
      );
      if (recovered) {
        return recovered;
      }
    }
  }

  if (!responseContent) {
    return { content: responseContent, toolCalls: [] };
  }

  return parseTextToolCalls(options?.parser, responseContent);
}
