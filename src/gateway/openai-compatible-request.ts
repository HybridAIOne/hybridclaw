import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import type { ChatMessage, ToolCall } from '../types/api.js';
import type { MediaContextItem } from '../types/container.js';
import type {
  OpenAICompatibleToolChoice,
  OpenAICompatibleToolDefinition,
} from './openai-compatible-model.js';

const MAX_REQUEST_BYTES = 1_000_000;

type OpenAIChatCompletionRequestBody = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  stream_options?: unknown;
  user?: unknown;
  n?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  functions?: unknown;
  function_call?: unknown;
};

type OpenAIChatCompletionMessage = {
  role?: unknown;
  name?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
};

type OpenAIChatCompletionContentPart = {
  type?: unknown;
  text?: unknown;
  image_url?: { url?: unknown } | unknown;
  audio_url?: { url?: unknown } | unknown;
};

export interface ParsedOpenAICompatibleChatRequest {
  model: string;
  user: string;
  wantsStream: boolean;
  includeUsage: boolean;
  usesClientTools: boolean;
  messages: ChatMessage[];
  tools: OpenAICompatibleToolDefinition[];
  toolChoice?: OpenAICompatibleToolChoice;
  priorMessages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
  }>;
  prompt: string;
  media: MediaContextItem[];
}

export class OpenAICompatibleRequestError extends Error {
  statusCode: number;
  type: string;
  param?: string;
  code?: string;

  constructor(
    statusCode: number,
    message: string,
    options?: {
      type?: string;
      param?: string;
      code?: string;
    },
  ) {
    super(message);
    this.statusCode = statusCode;
    this.type = options?.type || 'invalid_request_error';
    this.param = options?.param;
    this.code = options?.code;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new OpenAICompatibleRequestError(413, 'Request body too large.', {
        type: 'invalid_request_error',
        code: 'request_too_large',
      });
    }
    chunks.push(buffer);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<OpenAIChatCompletionRequestBody> {
  const body = await readRequestBody(req);
  if (body.length === 0) return {};
  const raw = body.toString('utf-8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as OpenAIChatCompletionRequestBody;
  } catch {
    throw new OpenAICompatibleRequestError(400, 'Invalid JSON body', {
      code: 'invalid_json',
    });
  }
}

function normalizeOpenAIRole(
  value: unknown,
  index: number,
): 'system' | 'user' | 'assistant' | 'tool' {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'developer') return 'system';
  if (
    normalized === 'system' ||
    normalized === 'user' ||
    normalized === 'assistant' ||
    normalized === 'tool'
  ) {
    return normalized;
  }
  throw new OpenAICompatibleRequestError(
    400,
    `Unsupported \`messages[${index}].role\`.`,
    {
      param: `messages[${index}].role`,
    },
  );
}

function normalizeRequestedChoiceCount(value: unknown): void {
  if (value == null) return;
  if (value === 1) return;
  if (typeof value === 'string' && value.trim() === '1') return;
  throw new OpenAICompatibleRequestError(
    400,
    'Only `n=1` is supported on `/v1/chat/completions`.',
    {
      param: 'n',
      code: 'unsupported_value',
    },
  );
}

function normalizeIncludeUsage(value: unknown): boolean {
  if (value == null) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpenAICompatibleRequestError(
      400,
      'Invalid `stream_options` object.',
      {
        param: 'stream_options',
      },
    );
  }
  return (value as { include_usage?: unknown }).include_usage === true;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  if (parts[0] === 0) return true;
  if (parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
  if (parts[0] >= 224) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}

function isPrivateIp(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/, '');
  const version = net.isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version === 6) return isPrivateIpv6(normalized);
  return false;
}

async function assertAllowedRemoteMediaUrl(
  rawUrl: string,
  param: string,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new OpenAICompatibleRequestError(400, `Invalid \`${param}.url\`.`, {
      param: `${param}.url`,
      code: 'invalid_url',
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OpenAICompatibleRequestError(
      400,
      `Unsupported \`${param}.url\` protocol: ${parsed.protocol}`,
      {
        param: `${param}.url`,
        code: 'unsupported_value',
      },
    );
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw new OpenAICompatibleRequestError(
      400,
      `Blocked \`${param}.url\`: private or loopback host.`,
      {
        param: `${param}.url`,
        code: 'invalid_url',
      },
    );
  }

  if (net.isIP(hostname) > 0 && isPrivateIp(hostname)) {
    throw new OpenAICompatibleRequestError(
      400,
      `Blocked \`${param}.url\`: private or loopback host.`,
      {
        param: `${param}.url`,
        code: 'invalid_url',
      },
    );
  }

  try {
    const resolved = await lookup(hostname, { all: true, verbatim: true });
    if (resolved.some((entry) => isPrivateIp(entry.address))) {
      throw new OpenAICompatibleRequestError(
        400,
        `Blocked \`${param}.url\`: private or loopback host.`,
        {
          param: `${param}.url`,
          code: 'invalid_url',
        },
      );
    }
  } catch (error) {
    if (error instanceof OpenAICompatibleRequestError) throw error;
    throw new OpenAICompatibleRequestError(
      400,
      `Unable to validate \`${param}.url\`.`,
      {
        param: `${param}.url`,
        code: 'invalid_url',
      },
    );
  }

  return parsed.toString();
}

function deriveFilenameFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split('/').pop() || '';
    const normalized = decodeURIComponent(lastSegment).trim();
    return normalized || fallback;
  } catch {
    return fallback;
  }
}

function deriveMimeTypeFromUrl(
  url: string,
  type: 'image_url' | 'audio_url',
): string | null {
  const lower = url.toLowerCase();
  if (type === 'image_url') {
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    return 'image/*';
  }
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  return 'audio/*';
}

async function buildRemoteMediaItem(params: {
  rawUrl: unknown;
  type: 'image_url' | 'audio_url';
  paramPrefix: string;
  mediaIndex: number;
}): Promise<MediaContextItem> {
  const rawUrl = normalizeOptionalString(params.rawUrl);
  if (!rawUrl) {
    throw new OpenAICompatibleRequestError(
      400,
      `Missing \`${params.paramPrefix}.url\`.`,
      {
        param: `${params.paramPrefix}.url`,
      },
    );
  }
  const url = await assertAllowedRemoteMediaUrl(rawUrl, params.paramPrefix);
  return {
    path: null,
    url,
    originalUrl: url,
    filename: deriveFilenameFromUrl(url, `${params.type}-${params.mediaIndex}`),
    sizeBytes: 0,
    mimeType: deriveMimeTypeFromUrl(url, params.type),
  };
}

async function parseMessageContent(params: {
  message: OpenAIChatCompletionMessage;
  index: number;
  extractMedia: boolean;
}): Promise<{
  text: string;
  media: MediaContextItem[];
}> {
  const content = params.message.content;
  if (content == null) return { text: '', media: [] };
  if (typeof content === 'string') return { text: content, media: [] };
  if (!Array.isArray(content)) {
    throw new OpenAICompatibleRequestError(
      400,
      `Invalid \`messages[${params.index}].content\`.`,
      {
        param: `messages[${params.index}].content`,
      },
    );
  }

  const textParts: string[] = [];
  const media: MediaContextItem[] = [];
  for (const [partIndex, entry] of content.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new OpenAICompatibleRequestError(
        400,
        `Invalid \`messages[${params.index}].content[${partIndex}]\`.`,
        {
          param: `messages[${params.index}].content[${partIndex}]`,
        },
      );
    }
    const part = entry as OpenAIChatCompletionContentPart;
    const type = normalizeOptionalString(part.type);
    if (type === 'text') {
      textParts.push(typeof part.text === 'string' ? part.text : '');
      continue;
    }
    if (type === 'image_url') {
      const mediaItem = await buildRemoteMediaItem({
        rawUrl: (part.image_url as { url?: unknown } | undefined)?.url,
        type: 'image_url',
        paramPrefix: `messages[${params.index}].content[${partIndex}].image_url`,
        mediaIndex: media.length + 1,
      });
      if (params.extractMedia) {
        media.push(mediaItem);
      } else {
        textParts.push(`[Image: ${mediaItem.url}]`);
      }
      continue;
    }
    if (type === 'audio_url') {
      const mediaItem = await buildRemoteMediaItem({
        rawUrl: (part.audio_url as { url?: unknown } | undefined)?.url,
        type: 'audio_url',
        paramPrefix: `messages[${params.index}].content[${partIndex}].audio_url`,
        mediaIndex: media.length + 1,
      });
      if (params.extractMedia) {
        media.push(mediaItem);
      } else {
        textParts.push(`[Audio: ${mediaItem.url}]`);
      }
      continue;
    }
    throw new OpenAICompatibleRequestError(
      400,
      `Unsupported \`messages[${params.index}].content[${partIndex}].type\`: ${type || '(empty)'}.`,
      {
        param: `messages[${params.index}].content[${partIndex}].type`,
      },
    );
  }

  return {
    text: textParts.join('\n').trim(),
    media,
  };
}

async function normalizeMessageContent(
  message: OpenAIChatCompletionMessage,
  index: number,
): Promise<ChatMessage['content']> {
  const content = message.content;
  if (content == null) return null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    throw new OpenAICompatibleRequestError(
      400,
      `Invalid \`messages[${index}].content\`.`,
      {
        param: `messages[${index}].content`,
      },
    );
  }

  const normalizedParts: NonNullable<ChatMessage['content']> = [];
  for (const [partIndex, entry] of content.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new OpenAICompatibleRequestError(
        400,
        `Invalid \`messages[${index}].content[${partIndex}]\`.`,
        {
          param: `messages[${index}].content[${partIndex}]`,
        },
      );
    }
    const part = entry as OpenAIChatCompletionContentPart;
    const type = normalizeOptionalString(part.type);
    if (type === 'text') {
      normalizedParts.push({
        type: 'text',
        text: typeof part.text === 'string' ? part.text : '',
      });
      continue;
    }
    if (type === 'image_url') {
      const mediaItem = await buildRemoteMediaItem({
        rawUrl: (part.image_url as { url?: unknown } | undefined)?.url,
        type: 'image_url',
        paramPrefix: `messages[${index}].content[${partIndex}].image_url`,
        mediaIndex: partIndex + 1,
      });
      normalizedParts.push({
        type: 'image_url',
        image_url: {
          url: mediaItem.url || '',
        },
      });
      continue;
    }
    if (type === 'audio_url') {
      const mediaItem = await buildRemoteMediaItem({
        rawUrl: (part.audio_url as { url?: unknown } | undefined)?.url,
        type: 'audio_url',
        paramPrefix: `messages[${index}].content[${partIndex}].audio_url`,
        mediaIndex: partIndex + 1,
      });
      normalizedParts.push({
        type: 'audio_url',
        audio_url: {
          url: mediaItem.url || '',
        },
      });
      continue;
    }
    throw new OpenAICompatibleRequestError(
      400,
      `Unsupported \`messages[${index}].content[${partIndex}].type\`: ${type || '(empty)'}.`,
      {
        param: `messages[${index}].content[${partIndex}].type`,
      },
    );
  }

  return normalizedParts;
}

function normalizeToolCall(value: unknown, paramPrefix: string): ToolCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpenAICompatibleRequestError(400, `Invalid \`${paramPrefix}\`.`, {
      param: paramPrefix,
    });
  }
  const record = value as {
    id?: unknown;
    type?: unknown;
    function?: { name?: unknown; arguments?: unknown } | unknown;
  };
  const functionValue =
    record.function && typeof record.function === 'object'
      ? (record.function as { name?: unknown; arguments?: unknown })
      : null;
  const name = normalizeOptionalString(functionValue?.name);
  if (!name) {
    throw new OpenAICompatibleRequestError(
      400,
      `Missing \`${paramPrefix}.function.name\`.`,
      {
        param: `${paramPrefix}.function.name`,
      },
    );
  }
  return {
    id: normalizeOptionalString(record.id) || '',
    type: 'function',
    function: {
      name,
      arguments:
        typeof functionValue?.arguments === 'string'
          ? functionValue.arguments
          : JSON.stringify(functionValue?.arguments || {}),
    },
  };
}

function normalizeToolDefinitions(
  body: OpenAIChatCompletionRequestBody,
): OpenAICompatibleToolDefinition[] {
  const sources = [body.tools, body.functions].filter(
    (value) => value !== undefined,
  );
  if (sources.length === 0) return [];
  if (sources.length > 1) {
    throw new OpenAICompatibleRequestError(
      400,
      'Use either `tools` or `functions`, not both.',
      {
        code: 'unsupported_value',
      },
    );
  }
  const rawDefinitions = sources[0];
  if (!Array.isArray(rawDefinitions)) {
    throw new OpenAICompatibleRequestError(
      400,
      'Invalid tool/function definition array.',
      {
        code: 'invalid_type',
      },
    );
  }

  return rawDefinitions.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new OpenAICompatibleRequestError(
        400,
        `Invalid tool/function definition at index ${index}.`,
        {
          param: `tools[${index}]`,
        },
      );
    }
    const record = entry as {
      type?: unknown;
      function?:
        | {
            name?: unknown;
            description?: unknown;
            parameters?: unknown;
          }
        | unknown;
      name?: unknown;
      description?: unknown;
      parameters?: unknown;
    };
    const functionValue =
      record.function && typeof record.function === 'object'
        ? (record.function as {
            name?: unknown;
            description?: unknown;
            parameters?: unknown;
          })
        : record;
    const name = normalizeOptionalString(functionValue.name);
    if (!name) {
      throw new OpenAICompatibleRequestError(
        400,
        `Missing tool/function name at index ${index}.`,
        {
          param: `tools[${index}].function.name`,
        },
      );
    }
    return {
      type: 'function',
      function: {
        name,
        ...(typeof functionValue.description === 'string' &&
        functionValue.description.trim()
          ? { description: functionValue.description }
          : {}),
        ...(functionValue.parameters &&
        typeof functionValue.parameters === 'object' &&
        !Array.isArray(functionValue.parameters)
          ? {
              parameters: functionValue.parameters as Record<string, unknown>,
            }
          : {}),
      },
    };
  });
}

function normalizeToolChoice(
  body: OpenAIChatCompletionRequestBody,
): OpenAICompatibleToolChoice | undefined {
  const rawToolChoice =
    body.tool_choice !== undefined ? body.tool_choice : body.function_call;
  if (rawToolChoice === undefined) return undefined;
  if (
    rawToolChoice === 'auto' ||
    rawToolChoice === 'none' ||
    rawToolChoice === 'required'
  ) {
    return rawToolChoice;
  }
  if (typeof rawToolChoice === 'string') {
    if (rawToolChoice.trim().toLowerCase() === 'auto') return 'auto';
    if (rawToolChoice.trim().toLowerCase() === 'none') return 'none';
    if (rawToolChoice.trim().toLowerCase() === 'required') return 'required';
  }
  if (
    rawToolChoice &&
    typeof rawToolChoice === 'object' &&
    !Array.isArray(rawToolChoice)
  ) {
    const record = rawToolChoice as {
      type?: unknown;
      function?: { name?: unknown } | unknown;
      name?: unknown;
    };
    const functionValue =
      record.function && typeof record.function === 'object'
        ? (record.function as { name?: unknown })
        : record;
    const name = normalizeOptionalString(functionValue.name);
    if (name) {
      return {
        type: 'function',
        function: { name },
      };
    }
  }
  throw new OpenAICompatibleRequestError(400, 'Invalid tool/function choice.', {
    param: body.tool_choice !== undefined ? 'tool_choice' : 'function_call',
  });
}
function formatToolCallsForHistory(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const lines: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const typed = entry as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown } | unknown;
    };
    const functionValue =
      typed.function && typeof typed.function === 'object'
        ? (typed.function as { name?: unknown; arguments?: unknown })
        : null;
    const name = normalizeOptionalString(functionValue?.name) || 'unnamed_tool';
    const argumentsText =
      typeof functionValue?.arguments === 'string'
        ? functionValue.arguments
        : '';
    const callId = normalizeOptionalString(typed.id);
    lines.push(
      `Tool call ${callId || index + 1}: ${name}${argumentsText ? ` ${argumentsText}` : ''}`.trim(),
    );
  }
  return lines;
}

function buildMediaOnlyPrompt(media: MediaContextItem[]): string {
  if (media.length === 0) return '';
  const filenames = media.map((item) => item.filename || 'attachment');
  return media.length === 1
    ? `Attached file: ${filenames[0]}`
    : `Attached files: ${filenames.join(', ')}`;
}

async function serializeMessageForHistory(
  message: OpenAIChatCompletionMessage,
  index: number,
): Promise<{
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
} | null> {
  const role = normalizeOpenAIRole(message.role, index);
  const { text } = await parseMessageContent({
    message,
    index,
    extractMedia: false,
  });
  const name = normalizeOptionalString(message.name);
  const toolCallId = normalizeOptionalString(message.tool_call_id);
  const toolCallLines = formatToolCallsForHistory(message.tool_calls);
  const content = [
    name ? `[name:${name}]` : '',
    toolCallId ? `[tool_call_id:${toolCallId}]` : '',
    text,
    toolCallLines.join('\n'),
  ]
    .filter((value) => value)
    .join('\n')
    .trim();
  return content ? { role, content } : null;
}

export async function readOpenAICompatibleChatRequest(
  req: IncomingMessage,
): Promise<ParsedOpenAICompatibleChatRequest> {
  const body = await readJsonBody(req);
  const wantsStream = body.stream === true;
  const model = normalizeOptionalString(body.model);
  if (!model) {
    throw new OpenAICompatibleRequestError(
      400,
      'Missing `model` in request body.',
      {
        param: 'model',
      },
    );
  }

  normalizeRequestedChoiceCount(body.n);
  const tools = normalizeToolDefinitions(body);
  const toolChoice = normalizeToolChoice(body);
  const usesClientTools = tools.length > 0 || toolChoice !== undefined;
  if (body.stream_options !== undefined && !wantsStream) {
    throw new OpenAICompatibleRequestError(
      400,
      '`stream_options` requires `stream: true`.',
      {
        param: 'stream_options',
        code: 'unsupported_value',
      },
    );
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new OpenAICompatibleRequestError(
      400,
      'Missing non-empty `messages` array in request body.',
      {
        param: 'messages',
      },
    );
  }

  const parsedMessages = body.messages as OpenAIChatCompletionMessage[];
  const normalizedMessages = await Promise.all(
    parsedMessages.map(async (message, index) => {
      const role = normalizeOpenAIRole(message.role, index);
      const content = await normalizeMessageContent(message, index);
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls.map((entry, toolIndex) =>
            normalizeToolCall(
              entry,
              `messages[${index}].tool_calls[${toolIndex}]`,
            ),
          )
        : undefined;
      return {
        role,
        content,
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(role === 'tool' && normalizeOptionalString(message.tool_call_id)
          ? { tool_call_id: normalizeOptionalString(message.tool_call_id) }
          : {}),
      } satisfies ChatMessage;
    }),
  );
  const finalIndex = parsedMessages.length - 1;
  const finalMessage = parsedMessages[finalIndex];
  const finalRole = normalizeOpenAIRole(finalMessage?.role, finalIndex);
  if (!usesClientTools && finalRole !== 'user') {
    throw new OpenAICompatibleRequestError(
      400,
      'The final chat message must have role `user`.',
      {
        param: `messages[${finalIndex}].role`,
        code: 'unsupported_value',
      },
    );
  }

  const current = await parseMessageContent({
    message: finalMessage,
    index: finalIndex,
    extractMedia: true,
  });
  const prompt = current.text || buildMediaOnlyPrompt(current.media);
  if (!usesClientTools && !prompt) {
    throw new OpenAICompatibleRequestError(
      400,
      'The final `user` message must include text or supported media URLs.',
      {
        param: `messages[${finalIndex}].content`,
      },
    );
  }

  return {
    model,
    user: normalizeOptionalString(body.user) || 'openai',
    wantsStream,
    includeUsage: normalizeIncludeUsage(body.stream_options),
    usesClientTools,
    messages: normalizedMessages,
    tools,
    ...(toolChoice ? { toolChoice } : {}),
    priorMessages: (
      await Promise.all(
        parsedMessages
          .slice(0, -1)
          .map((message, index) => serializeMessageForHistory(message, index)),
      )
    ).filter(
      (message): message is NonNullable<typeof message> => message != null,
    ),
    prompt,
    media: current.media,
  };
}
