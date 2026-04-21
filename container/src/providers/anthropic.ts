import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { collapseSystemMessages } from '../system-messages.js';
import type {
  ChatCompletionResponse,
  ChatContentPart,
  ChatMessage,
  ToolCall,
  ToolDefinition,
} from '../types.js';
import {
  isRecord,
  type NormalizedCallArgs,
  type NormalizedStreamCallArgs,
  ProviderRequestError,
} from './shared.js';
import { readWithIdleTimeout, STREAM_IDLE_TIMEOUT_MS } from './stream-utils.js';

interface ServerSentEvent {
  event: string | null;
  data: string;
}

interface AnthropicTextStreamBlock {
  type: 'text';
  index: number;
  text: string;
}

interface AnthropicToolUseStreamBlock {
  type: 'tool_use';
  index: number;
  id: string;
  name: string;
  inputJson: string;
}

type AnthropicStreamBlock =
  | AnthropicTextStreamBlock
  | AnthropicToolUseStreamBlock;

interface ClaudeCliResult {
  responseId: string;
  text: string;
}

const ANTHROPIC_INFERENCE_TIMEOUT_MS = 300_000;

const CLAUDE_CLI_ENV_ALLOWLIST = [
  'HOME',
  'PATH',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'SSH_AUTH_SOCK',
] as const;

const CLAUDE_CLI_SECRET_ENV_DENYLIST = [
  'HYBRIDAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'MISTRAL_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'DEEPGRAM_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'VLLM_API_KEY',
  'BRAVE_API_KEY',
  'TAVILY_API_KEY',
  'DISCORD_TOKEN',
  'EMAIL_PASSWORD',
  'TELEGRAM_BOT_TOKEN',
  'IMESSAGE_PASSWORD',
  'TWILIO_AUTH_TOKEN',
  'MSTEAMS_APP_PASSWORD',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'WEB_API_TOKEN',
  'GATEWAY_API_TOKEN',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'ZAI_API_KEY',
  'Z_AI_API_KEY',
  'GLM_API_KEY',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'DASHSCOPE_API_KEY',
  'XIAOMI_API_KEY',
  'KILO_API_KEY',
  'KILOCODE_API_KEY',
] as const;

function buildClaudeCliEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CLAUDE_CLI_ENV_ALLOWLIST) {
    const value = sourceEnv[key];
    if (value) env[key] = value;
  }
  env.PATH ||= '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  for (const key of CLAUDE_CLI_SECRET_ENV_DENYLIST) {
    delete env[key];
  }
  return env;
}

function normalizeAnthropicModelName(model: string): string {
  const trimmed = String(model || '').trim();
  if (!trimmed.toLowerCase().startsWith('anthropic/')) return trimmed;
  return trimmed.slice('anthropic/'.length) || trimmed;
}

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '')
    .trim()
    .replace(/\/+$/g, '');
}

function usesClaudeCliTransport(
  args: Pick<NormalizedCallArgs, 'providerMethod'>,
): boolean {
  return args.providerMethod === 'claude-cli';
}

function isAnthropicOAuthToken(apiKey: string): boolean {
  return String(apiKey || '').includes('sk-ant-oat');
}

function buildHeaders(args: {
  apiKey: string;
  requestHeaders?: Record<string, string>;
  stream?: boolean;
}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(isAnthropicOAuthToken(args.apiKey)
      ? { Authorization: `Bearer ${args.apiKey}` }
      : { 'x-api-key': args.apiKey }),
    ...(args.stream ? { Accept: 'text/event-stream' } : {}),
    ...(args.requestHeaders || {}),
  };
}

function normalizeMessageText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function summarizeMessageForClaudeCli(message: ChatMessage): string {
  const text = normalizeMessageText(message.content).trim();
  const imageCount = Array.isArray(message.content)
    ? message.content.filter((part) => part.type === 'image_url').length
    : 0;
  const toolCallSummary =
    message.role === 'assistant' && Array.isArray(message.tool_calls)
      ? message.tool_calls
          .map((toolCall) => {
            const args = toolCall.function.arguments.trim();
            return `- ${toolCall.function.name}${args ? ` ${args}` : ''}`;
          })
          .join('\n')
      : '';
  const parts = [text];
  if (imageCount > 0) {
    parts.push(
      `[${imageCount} image input${imageCount === 1 ? '' : 's'} omitted in claude-cli transport]`,
    );
  }
  if (toolCallSummary) {
    parts.push(`Assistant tool calls:\n${toolCallSummary}`);
  }
  const combined = parts.filter(Boolean).join('\n\n').trim();
  return combined || '[no text content]';
}

function buildClaudeCliPrompt(messages: ChatMessage[]): string {
  const normalized = collapseSystemMessages(messages);
  const transcript = normalized
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const label =
        message.role === 'tool'
          ? `Tool result (${message.tool_call_id || 'unknown'})`
          : message.role[0]?.toUpperCase() + message.role.slice(1);
      return `${label}:\n${summarizeMessageForClaudeCli(message)}`;
    })
    .join('\n\n');
  return [
    'Continue this conversation transcript.',
    transcript,
    'Reply to the latest user request.',
  ]
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function isHostSandboxRuntime(): boolean {
  return process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE === 'host';
}

function extractClaudeCliText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  if (typeof value.result === 'string') return value.result;
  if (typeof value.text === 'string') return value.text;
  if (Array.isArray(value.content)) {
    return value.content.map(extractClaudeCliText).filter(Boolean).join('');
  }
  if (typeof value.type === 'string' && value.type === 'text') {
    return typeof value.text === 'string' ? value.text : '';
  }
  if (isRecord(value.message)) {
    return extractClaudeCliText(value.message);
  }
  return '';
}

async function runClaudeCliCommand(
  args: Pick<NormalizedCallArgs, 'model' | 'messages' | 'providerMethod'> & {
    onTextDelta?: (delta: string) => void;
  },
): Promise<ClaudeCliResult> {
  if (!isHostSandboxRuntime()) {
    throw new Error(
      'Anthropic `--method claude-cli` requires `--sandbox=host`. Switch HybridClaw to host sandbox mode, or use `--method api-key` for container mode.',
    );
  }
  let responseId = 'claude-cli';
  let finalText = '';
  let streamedText = '';
  let stderr = '';
  let buffer = '';

  const systemPrompt = extractSystemPrompt(args.messages);
  const prompt = buildClaudeCliPrompt(args.messages);
  const commandArgs = [
    '-p',
    prompt,
    '--verbose',
    '--output-format',
    'stream-json',
    // HybridClaw's sandbox and approval policy are the enforcement boundary.
    // Claude CLI permissions are bypassed so the wrapper does not add a second,
    // divergent approval system inside the already constrained execution layer.
    '--permission-mode',
    'bypassPermissions',
    '--model',
    normalizeAnthropicModelName(args.model),
    ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
  ];

  const child = spawn('claude', commandArgs, {
    cwd: process.cwd(),
    env: buildClaudeCliEnv(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const payload = JSON.parse(line) as Record<string, unknown>;
        if (typeof payload.session_id === 'string' && payload.session_id) {
          responseId = payload.session_id;
        }
        const text = extractClaudeCliText(payload);
        if (typeof payload.type === 'string' && payload.type === 'result') {
          finalText = text;
          continue;
        }
        if (!text) continue;
        if (text.startsWith(streamedText)) {
          const delta = text.slice(streamedText.length);
          if (delta) args.onTextDelta?.(delta);
          streamedText = text;
          continue;
        }
        streamedText += text;
        args.onTextDelta?.(text);
      } catch {
        streamedText += line;
        args.onTextDelta?.(line);
      }
    }
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });

  if (buffer.trim()) {
    try {
      const payload = JSON.parse(buffer.trim()) as Record<string, unknown>;
      const text = extractClaudeCliText(payload);
      if (typeof payload.type === 'string' && payload.type === 'result') {
        finalText = text || finalText;
      } else if (text) {
        if (text.startsWith(streamedText)) {
          const delta = text.slice(streamedText.length);
          if (delta) args.onTextDelta?.(delta);
          streamedText = text;
        } else {
          streamedText += text;
          args.onTextDelta?.(text);
        }
      }
    } catch {
      streamedText += buffer.trim();
      args.onTextDelta?.(buffer.trim());
    }
  }

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `claude exited with status ${exitCode}.`);
  }

  return {
    responseId,
    text: finalText || streamedText,
  };
}

function parseDataUrlImage(
  url: string,
): { mediaType: string; data: string } | null {
  const match = String(url || '').match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;
  return {
    mediaType: match[1] || 'image/png',
    data: match[2] || '',
  };
}

function convertContentPart(
  part: ChatContentPart,
): Record<string, unknown> | null {
  if (part.type === 'text') {
    const text = part.text.trim();
    return text ? { type: 'text', text } : null;
  }
  if (part.type === 'image_url') {
    const parsed = parseDataUrlImage(part.image_url.url);
    if (!parsed) return null;
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: parsed.mediaType,
        data: parsed.data,
      },
    };
  }
  return null;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function convertMessageContent(
  message: ChatMessage,
): string | Array<Record<string, unknown>> | null {
  if (!Array.isArray(message.content)) {
    const text = normalizeMessageText(message.content).trim();
    return text || null;
  }

  const blocks = message.content
    .map(convertContentPart)
    .filter((part): part is Record<string, unknown> => part !== null);
  return blocks.length > 0 ? blocks : null;
}

function convertMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  const normalized = collapseSystemMessages(messages);
  const converted: Array<Record<string, unknown>> = [];

  for (const message of normalized) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      converted.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id || '',
            content: normalizeMessageText(message.content),
          },
        ],
      });
      continue;
    }

    const blocks: Array<Record<string, unknown>> = [];
    const content = convertMessageContent(message);
    if (typeof content === 'string' && content.trim()) {
      blocks.push({
        type: 'text',
        text: content,
      });
    } else if (Array.isArray(content)) {
      blocks.push(...content);
    }

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments),
        });
      }
    }

    if (blocks.length === 0) continue;
    converted.push({
      role: message.role,
      content: blocks,
    });
  }

  return converted;
}

function extractSystemPrompt(messages: ChatMessage[]): string | undefined {
  const normalized = collapseSystemMessages(messages);
  const system = normalized[0];
  if (system?.role !== 'system') return undefined;
  const text = normalizeMessageText(system.content).trim();
  return text || undefined;
}

function convertTools(
  tools: ToolDefinition[],
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

function buildRequestBody(
  args: NormalizedCallArgs,
  stream: boolean,
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: normalizeAnthropicModelName(args.model),
    max_tokens:
      typeof args.maxTokens === 'number' && args.maxTokens > 0
        ? Math.floor(args.maxTokens)
        : 4096,
    messages: convertMessages(args.messages),
    stream,
  };

  const system = extractSystemPrompt(args.messages);
  if (system) {
    request.system = system;
  }

  const tools = convertTools(args.tools);
  if (tools) {
    request.tools = tools;
    request.tool_choice = { type: 'auto' };
  }

  return request;
}

function mapStopReason(stopReason: string | null | undefined): string {
  if (stopReason === 'tool_use') return 'tool_calls';
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'end_turn' || stopReason === 'pause_turn') return 'stop';
  return stopReason || 'stop';
}

function parseUsage(
  value: unknown,
): ChatCompletionResponse['usage'] | undefined {
  if (!isRecord(value)) return undefined;

  const inputTokens =
    typeof value.input_tokens === 'number' ? value.input_tokens : undefined;
  const outputTokens =
    typeof value.output_tokens === 'number' ? value.output_tokens : undefined;
  const cacheRead =
    typeof value.cache_read_input_tokens === 'number'
      ? value.cache_read_input_tokens
      : undefined;
  const cacheWrite =
    typeof value.cache_creation_input_tokens === 'number'
      ? value.cache_creation_input_tokens
      : undefined;
  const totalTokens =
    [inputTokens, outputTokens, cacheRead, cacheWrite].filter(
      (token): token is number => typeof token === 'number',
    ).length > 0
      ? (inputTokens || 0) +
        (outputTokens || 0) +
        (cacheRead || 0) +
        (cacheWrite || 0)
      : undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cacheRead,
    cacheWrite,
    ...(cacheRead !== undefined
      ? { prompt_tokens_details: { cached_tokens: cacheRead } }
      : {}),
  };
}

function adaptAnthropicResponse(
  payload: unknown,
  fallbackModel: string,
): ChatCompletionResponse {
  const record = payload as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const textParts: Array<{ type: 'text'; text: string }> = [];
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text) textParts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : '',
        type: 'function',
        function: {
          name: typeof block.name === 'string' ? block.name : '',
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  const usage = parseUsage(record.usage);
  const contentValue =
    textParts.length === 0
      ? null
      : textParts.length === 1
        ? textParts[0].text
        : textParts;

  return {
    id: typeof record.id === 'string' ? record.id : 'message',
    model:
      typeof record.model === 'string' && record.model
        ? record.model
        : normalizeAnthropicModelName(fallbackModel),
    choices: [
      {
        message: {
          role: typeof record.role === 'string' ? record.role : 'assistant',
          content: contentValue,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapStopReason(
          typeof record.stop_reason === 'string' ? record.stop_reason : null,
        ),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

function parseServerSentEventBlock(block: string): ServerSentEvent | null {
  const lines = block.split(/\r?\n/);
  const dataLines: string[] = [];
  let event: string | null = null;

  for (const rawLine of lines) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    if (rawLine.startsWith('event:')) {
      event = rawLine.slice('event:'.length).trim() || null;
      continue;
    }
    if (rawLine.startsWith('data:')) {
      dataLines.push(rawLine.slice('data:'.length).trimStart());
    }
  }

  if (dataLines.length === 0) return null;
  return {
    event,
    data: dataLines.join('\n'),
  };
}

function findStreamBlock(
  blocks: AnthropicStreamBlock[],
  index: number,
): AnthropicStreamBlock | undefined {
  return blocks.find((block) => block.index === index);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const trimmed = String(value || '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildStreamResponse(params: {
  id: string;
  model: string;
  blocks: AnthropicStreamBlock[];
  finishReason: string;
  usage?: ChatCompletionResponse['usage'];
}): ChatCompletionResponse {
  return adaptAnthropicResponse(
    {
      id: params.id,
      model: params.model,
      role: 'assistant',
      stop_reason: params.finishReason,
      usage: params.usage,
      content: params.blocks
        .sort((left, right) => left.index - right.index)
        .map((block) =>
          block.type === 'text'
            ? { type: 'text', text: block.text }
            : {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: parseJsonObject(block.inputJson),
              },
        ),
    },
    params.model,
  );
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export async function callAnthropicProvider(
  args: NormalizedCallArgs,
): Promise<ChatCompletionResponse> {
  if (usesClaudeCliTransport(args)) {
    const result = await runClaudeCliCommand(args);
    return {
      id: result.responseId,
      model: normalizeAnthropicModelName(args.model),
      choices: [
        {
          message: {
            role: 'assistant',
            content: result.text,
          },
          finish_reason: 'stop',
        },
      ],
    };
  }

  const response = await fetch(`${normalizeBaseUrl(args.baseUrl)}/messages`, {
    method: 'POST',
    headers: buildHeaders(args),
    body: JSON.stringify(buildRequestBody(args, false)),
    signal: AbortSignal.timeout(ANTHROPIC_INFERENCE_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new ProviderRequestError(
      response.status,
      await readErrorBody(response),
    );
  }

  return adaptAnthropicResponse(await response.json(), args.model);
}

export async function callAnthropicProviderStream(
  args: NormalizedStreamCallArgs,
): Promise<ChatCompletionResponse> {
  if (usesClaudeCliTransport(args)) {
    const result = await runClaudeCliCommand(args);
    return {
      id: result.responseId,
      model: normalizeAnthropicModelName(args.model),
      choices: [
        {
          message: {
            role: 'assistant',
            content: result.text,
          },
          finish_reason: 'stop',
        },
      ],
    };
  }

  const response = await fetch(`${normalizeBaseUrl(args.baseUrl)}/messages`, {
    method: 'POST',
    headers: buildHeaders({ ...args, stream: true }),
    body: JSON.stringify(buildRequestBody(args, true)),
    signal: AbortSignal.timeout(ANTHROPIC_INFERENCE_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new ProviderRequestError(
      response.status,
      await readErrorBody(response),
    );
  }
  if (!response.body) {
    throw new Error('Anthropic stream response body is missing.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const blocks: AnthropicStreamBlock[] = [];
  let usage: ChatCompletionResponse['usage'] | undefined;
  let responseId = 'message';
  let responseModel = normalizeAnthropicModelName(args.model);
  let finishReason = 'stop';
  let buffer = '';

  while (true) {
    const { done, value } = await readWithIdleTimeout(
      reader,
      STREAM_IDLE_TIMEOUT_MS,
    );
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary === -1) break;
      const rawBlock = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const sse = parseServerSentEventBlock(rawBlock);
      if (!sse || !sse.data || sse.data === '[DONE]') continue;

      const event = JSON.parse(sse.data) as Record<string, unknown>;
      args.onActivity?.();

      if (event.type === 'error') {
        const error =
          isRecord(event.error) && typeof event.error.message === 'string'
            ? event.error.message
            : sse.data;
        throw new Error(error);
      }

      if (event.type === 'message_start' && isRecord(event.message)) {
        if (typeof event.message.id === 'string' && event.message.id) {
          responseId = event.message.id;
        }
        if (typeof event.message.model === 'string' && event.message.model) {
          responseModel = event.message.model;
        }
        usage = parseUsage(event.message.usage) || usage;
        continue;
      }

      if (event.type === 'content_block_start') {
        const index = typeof event.index === 'number' ? event.index : -1;
        if (!isRecord(event.content_block)) continue;
        if (event.content_block.type === 'text') {
          blocks.push({
            type: 'text',
            index,
            text:
              typeof event.content_block.text === 'string'
                ? event.content_block.text
                : '',
          });
          continue;
        }
        if (event.content_block.type === 'tool_use') {
          const input =
            isRecord(event.content_block.input) &&
            Object.keys(event.content_block.input).length > 0
              ? JSON.stringify(event.content_block.input)
              : '';
          blocks.push({
            type: 'tool_use',
            index,
            id:
              typeof event.content_block.id === 'string'
                ? event.content_block.id
                : '',
            name:
              typeof event.content_block.name === 'string'
                ? event.content_block.name
                : '',
            inputJson: input,
          });
        }
        continue;
      }

      if (event.type === 'content_block_delta') {
        const index = typeof event.index === 'number' ? event.index : -1;
        const block = findStreamBlock(blocks, index);
        if (!block || !isRecord(event.delta)) continue;

        if (
          block.type === 'text' &&
          event.delta.type === 'text_delta' &&
          typeof event.delta.text === 'string'
        ) {
          block.text += event.delta.text;
          if (event.delta.text) {
            args.onTextDelta(event.delta.text);
          }
          continue;
        }

        if (
          block.type === 'tool_use' &&
          event.delta.type === 'input_json_delta' &&
          typeof event.delta.partial_json === 'string'
        ) {
          block.inputJson += event.delta.partial_json;
        }
        continue;
      }

      if (event.type === 'message_delta') {
        usage = parseUsage(event.usage) || usage;
        if (
          isRecord(event.delta) &&
          typeof event.delta.stop_reason === 'string' &&
          event.delta.stop_reason
        ) {
          finishReason = event.delta.stop_reason;
        }
      }
    }

    if (done) break;
  }

  return buildStreamResponse({
    id: responseId,
    model: responseModel,
    blocks,
    finishReason,
    usage,
  });
}
