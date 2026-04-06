import type { IncomingMessage } from 'node:http';
import type { MediaContextItem } from '../types/container.js';

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
        type: 'server_error',
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

function assertNoClientToolConfig(body: OpenAIChatCompletionRequestBody): void {
  if (
    body.tools !== undefined ||
    body.tool_choice !== undefined ||
    body.functions !== undefined ||
    body.function_call !== undefined
  ) {
    throw new OpenAICompatibleRequestError(
      400,
      'Client-defined tools/functions are not supported on `/v1/chat/completions`.',
      {
        code: 'unsupported_feature',
      },
    );
  }
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

function buildRemoteMediaItem(params: {
  rawUrl: unknown;
  type: 'image_url' | 'audio_url';
  paramPrefix: string;
  mediaIndex: number;
}): MediaContextItem {
  const url = normalizeOptionalString(params.rawUrl);
  if (!url) {
    throw new OpenAICompatibleRequestError(
      400,
      `Missing \`${params.paramPrefix}.url\`.`,
      {
        param: `${params.paramPrefix}.url`,
      },
    );
  }
  return {
    path: null,
    url,
    originalUrl: url,
    filename: deriveFilenameFromUrl(url, `${params.type}-${params.mediaIndex}`),
    sizeBytes: 0,
    mimeType: deriveMimeTypeFromUrl(url, params.type),
  };
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

function parseMessageContent(params: {
  message: OpenAIChatCompletionMessage;
  index: number;
  extractMedia: boolean;
}): {
  text: string;
  media: MediaContextItem[];
} {
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
      const mediaItem = buildRemoteMediaItem({
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
      const mediaItem = buildRemoteMediaItem({
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

function buildMediaOnlyPrompt(media: MediaContextItem[]): string {
  if (media.length === 0) return '';
  const filenames = media.map((item) => item.filename || 'attachment');
  return media.length === 1
    ? `Attached file: ${filenames[0]}`
    : `Attached files: ${filenames.join(', ')}`;
}

function serializeMessageForHistory(
  message: OpenAIChatCompletionMessage,
  index: number,
): {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
} | null {
  const role = normalizeOpenAIRole(message.role, index);
  const { text } = parseMessageContent({
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
  assertNoClientToolConfig(body);

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
  const finalIndex = parsedMessages.length - 1;
  const finalMessage = parsedMessages[finalIndex];
  if (normalizeOpenAIRole(finalMessage?.role, finalIndex) !== 'user') {
    throw new OpenAICompatibleRequestError(
      400,
      'The final chat message must have role `user`.',
      {
        param: `messages[${finalIndex}].role`,
        code: 'unsupported_value',
      },
    );
  }

  const current = parseMessageContent({
    message: finalMessage,
    index: finalIndex,
    extractMedia: true,
  });
  const prompt = current.text || buildMediaOnlyPrompt(current.media);
  if (!prompt) {
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
    wantsStream: body.stream === true,
    includeUsage: normalizeIncludeUsage(body.stream_options),
    priorMessages: parsedMessages
      .slice(0, -1)
      .map((message, index) => serializeMessageForHistory(message, index))
      .filter(
        (message): message is NonNullable<typeof message> => message != null,
      ),
    prompt,
    media: current.media,
  };
}
