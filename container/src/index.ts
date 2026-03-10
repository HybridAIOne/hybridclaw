import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import { TrustedCoworkerApprovalRuntime } from './approval-policy.js';
import { discoverArtifactsSince, inferArtifactMimeType } from './artifacts.js';
import {
  emitRuntimeEvent,
  runAfterToolHooks,
  runBeforeToolHooks,
} from './extensions.js';
import { waitForInput, writeOutput } from './ipc.js';
import { McpClientManager } from './mcp/client-manager.js';
import { McpConfigWatcher } from './mcp/config-watcher.js';
import { callHybridAI, callHybridAIStream } from './model-client.js';
import {
  isRetryableModelError,
  shouldDowngradeStreamToNonStreaming,
} from './model-retry.js';
import { injectRuntimeCapabilitiesMessage } from './runtime-capabilities.js';
import {
  resolveMediaPath,
  resolveWorkspacePath,
  WORKSPACE_ROOT,
  WORKSPACE_ROOT_DISPLAY,
} from './runtime-paths.js';
import {
  accumulateApiUsage,
  createTokenUsageStats,
  estimateMessageTokens,
  estimateTextTokens,
  finalizeTokenUsage,
} from './token-usage.js';
import {
  executeTool,
  getMessageToolDescription,
  getPendingSideEffects,
  resetSideEffects,
  setGatewayContext,
  setMcpClientManager,
  setMediaContext,
  setModelContext,
  setScheduledTasks,
  setSessionContext,
  setWebSearchConfig,
  TOOL_DEFINITIONS,
} from './tools.js';
import type {
  ArtifactMetadata,
  ChatContentPart,
  ChatMessage,
  ChatMessageContent,
  ContainerInput,
  ContainerOutput,
  MediaContextItem,
  ToolDefinition,
  ToolExecution,
} from './types.js';

const MAX_ITERATIONS = 20;
const IDLE_TIMEOUT_MS = parseInt(
  process.env.CONTAINER_IDLE_TIMEOUT || '300000',
  10,
); // 5 min
const RETRY_ENABLED = process.env.HYBRIDCLAW_RETRY_ENABLED !== 'false';
const RETRY_MAX_ATTEMPTS = Math.max(
  1,
  parseInt(process.env.HYBRIDCLAW_RETRY_MAX_ATTEMPTS || '3', 10),
);
const RETRY_BASE_DELAY_MS = Math.max(
  100,
  parseInt(process.env.HYBRIDCLAW_RETRY_BASE_DELAY_MS || '2000', 10),
);
const RETRY_MAX_DELAY_MS = Math.max(
  RETRY_BASE_DELAY_MS,
  parseInt(process.env.HYBRIDCLAW_RETRY_MAX_DELAY_MS || '8000', 10),
);
const RAW_RALPH_MAX_EXTRA_ITERATIONS = Number.parseInt(
  process.env.HYBRIDCLAW_RALPH_MAX_ITERATIONS || '0',
  10,
);
const RALPH_MAX_EXTRA_ITERATIONS = Number.isFinite(
  RAW_RALPH_MAX_EXTRA_ITERATIONS,
)
  ? RAW_RALPH_MAX_EXTRA_ITERATIONS === -1
    ? -1
    : Math.max(0, Math.min(64, RAW_RALPH_MAX_EXTRA_ITERATIONS))
  : 0;
const RALPH_ENABLED = RALPH_MAX_EXTRA_ITERATIONS !== 0;
const NATIVE_VISION_MAX_IMAGES = 8;
const NATIVE_VISION_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DISCORD_CDN_HOST_PATTERNS: RegExp[] = [
  /^cdn\.discordapp\.com$/i,
  /^media\.discordapp\.net$/i,
  /^cdn\.discordapp\.net$/i,
  /^images-ext-\d+\.discordapp\.net$/i,
];
const approvalRuntime = new TrustedCoworkerApprovalRuntime();
let cachedSelectedSkillPath: string | null = null;

/** Auth material received once via stdin, held in memory for the agent lifetime. */
let storedApiKey = '';
let storedRequestHeaders: Record<string, string> = {};
let mcpClientManager: McpClientManager | null = null;
let mcpConfigWatcher: McpConfigWatcher | null = null;

async function syncMcpConfig(
  servers: ContainerInput['mcpServers'],
): Promise<void> {
  const nextServers = servers || {};
  if (!mcpClientManager && Object.keys(nextServers).length === 0) return;
  if (!mcpClientManager) {
    mcpClientManager = new McpClientManager();
    mcpConfigWatcher = new McpConfigWatcher(mcpClientManager);
    setMcpClientManager(mcpClientManager);
  }
  await mcpConfigWatcher?.applyConfig(nextServers);
}

async function shutdownMcp(): Promise<void> {
  mcpConfigWatcher?.stop();
  mcpConfigWatcher = null;
  setMcpClientManager(null);
  if (mcpClientManager) {
    await mcpClientManager.shutdown();
  }
  mcpClientManager = null;
}

function normalizeMessageContentToText(content: ChatMessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type !== 'text') continue;
    if (typeof part.text !== 'string') continue;
    if (part.text.trim()) chunks.push(part.text.trim());
  }
  return chunks.join('\n').trim();
}

function normalizePathSlashes(raw: string): string {
  return raw.replace(/\\/g, '/');
}

function normalizeAllowedLocalImagePath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  return resolveWorkspacePath(trimmed) || resolveMediaPath(trimmed);
}

function inferImageMimeType(
  filePath: string,
  fallbackMime: string | null | undefined,
): string {
  const normalizedFallback = String(fallbackMime || '')
    .trim()
    .toLowerCase();
  if (normalizedFallback.startsWith('image/')) return normalizedFallback;
  const inferred = inferArtifactMimeType(filePath);
  return inferred.startsWith('image/') ? inferred : 'image/png';
}

function isImageMediaItem(item: MediaContextItem): boolean {
  const mimeType = String(item.mimeType || '')
    .trim()
    .toLowerCase();
  if (mimeType.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)$/i.test(item.filename || '');
}

function isSafeDiscordCdnUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return DISCORD_CDN_HOST_PATTERNS.some((pattern) =>
    pattern.test(parsed.hostname),
  );
}

function modelSupportsNativeVision(model: string): boolean {
  const normalized = model.toLowerCase();
  if (!normalized) return false;
  if (
    normalized.includes('gpt-5') ||
    normalized.includes('gpt-4o') ||
    normalized.includes('gpt-4.1') ||
    normalized.includes('o1') ||
    normalized.includes('o3') ||
    normalized.includes('vision') ||
    normalized.includes('multimodal') ||
    normalized.includes('gemini') ||
    normalized.includes('claude-3')
  ) {
    return true;
  }
  return false;
}

async function resolveMediaImagePartUrl(
  item: MediaContextItem,
): Promise<string | null> {
  const localPath = item.path
    ? normalizeAllowedLocalImagePath(item.path)
    : null;
  if (localPath) {
    try {
      const image = await fs.promises.readFile(localPath);
      if (image.length > NATIVE_VISION_MAX_IMAGE_BYTES) {
        console.error(
          `[media] skipping ${localPath}: ${image.length}B exceeds native vision max`,
        );
      } else {
        const mimeType = inferImageMimeType(localPath, item.mimeType);
        const base64 = image.toString('base64');
        return `data:${mimeType};base64,${base64}`;
      }
    } catch (err) {
      console.error(
        `[media] failed to read local media ${localPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const fallbackCandidates = [item.url, item.originalUrl]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  for (const candidate of fallbackCandidates) {
    if (!isSafeDiscordCdnUrl(candidate)) continue;
    return candidate;
  }
  return null;
}

async function injectNativeVisionContent(
  messages: ChatMessage[],
  model: string,
  media: MediaContextItem[] | undefined,
): Promise<ChatMessage[]> {
  if (!Array.isArray(media) || media.length === 0) return messages;
  if (!modelSupportsNativeVision(model)) return messages;

  const mediaSlice = media
    .filter((item) => isImageMediaItem(item))
    .slice(0, NATIVE_VISION_MAX_IMAGES);
  const imageParts: ChatContentPart[] = [];
  for (const item of mediaSlice) {
    const url = await resolveMediaImagePartUrl(item);
    if (!url) continue;
    imageParts.push({ type: 'image_url', image_url: { url } });
  }
  if (imageParts.length === 0) return messages;

  const latestUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return i;
    }
    return -1;
  })();
  if (latestUserIndex < 0) return messages;

  const cloned = messages.map((msg) => ({ ...msg }));
  const existingText = normalizeMessageContentToText(
    cloned[latestUserIndex].content,
  );
  const contentParts: ChatContentPart[] = [];
  const nativeVisionHint =
    '[NativeVision] Image parts are attached in this message. Analyze them directly and skip extra vision tool pre-analysis unless explicitly required.';
  if (existingText) {
    contentParts.push({
      type: 'text',
      text: `${existingText}\n\n${nativeVisionHint}`,
    });
  } else {
    contentParts.push({ type: 'text', text: nativeVisionHint });
  }
  contentParts.push(...imageParts);
  cloned[latestUserIndex] = {
    ...cloned[latestUserIndex],
    content: contentParts,
  };
  console.error(
    `[media] injected ${imageParts.length} native vision image part(s) for model ${model}`,
  );
  return cloned;
}

function parseToolArgs(argsJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function captureSkillSelection(toolName: string, argsJson: string): void {
  if (toolName !== 'read') return;
  const args = parseToolArgs(argsJson);
  const rawPath = String(args?.path || '').trim();
  if (!rawPath) return;
  const normalized = rawPath.replace(/\\/g, '/');
  if (!/(^|\/)skills\/[^/]+\/SKILL\.md$/i.test(normalized)) return;
  cachedSelectedSkillPath = rawPath;
}

function injectSkillCacheHint(messages: ChatMessage[]): ChatMessage[] {
  if (!cachedSelectedSkillPath) return messages;
  const latestPrompt = latestUserPrompt(messages);
  if (!latestPrompt.includes('[Approval already granted]')) return messages;
  if (
    messages.some(
      (message) =>
        message.role === 'system' &&
        normalizeMessageContentToText(message.content).includes(
          '[SkillSelectionCache]',
        ),
    )
  ) {
    return messages;
  }

  const latestUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return i;
    }
    return messages.length;
  })();
  const cloned = messages.map((message) => ({ ...message }));
  cloned.splice(latestUserIndex, 0, {
    role: 'system',
    content: [
      '[SkillSelectionCache]',
      `You already selected skill guidance from \`${cachedSelectedSkillPath}\` earlier in this session.`,
      'Reuse that skill now and do not reread the SKILL.md unless the task scope changed or a missing detail requires it.',
    ].join('\n'),
  });
  return cloned;
}

/**
 * Read a single line from stdin (the initial request JSON containing secrets).
 * Resolves on the first newline — does not consume the entire stream, so docker -i
 * keeps the container alive after the host stops writing.
 */
function readStdinLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        process.stdin.removeListener('data', onData);
        process.stdin.removeListener('error', onError);
        process.stdin.pause();
        resolve(buffer.slice(0, nl));
      }
    };
    const onError = (err: Error) => {
      process.stdin.removeListener('data', onData);
      reject(err);
    };
    process.stdin.on('data', onData);
    process.stdin.on('error', onError);
    process.stdin.resume();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitStreamDelta(delta: string): void {
  if (!delta) return;
  const payload = Buffer.from(delta, 'utf-8').toString('base64');
  console.error(`[stream] ${payload}`);
}

function inferToolError(result: string, blockedReason: string | null): boolean {
  if (blockedReason) return true;
  return /\b(error|failed|denied|forbidden|timed out|timeout|exception|invalid)\b/i.test(
    result,
  );
}

function latestUserPrompt(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const text = normalizeMessageContentToText(message.content)
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    return text.slice(0, 1_200);
  }
  return 'Continue the task';
}

function cloneMessageWithTextContent(
  message: ChatMessage,
  text: string,
): ChatMessage {
  if (typeof message.content === 'string' || message.content == null) {
    return {
      ...message,
      content: text,
    };
  }
  return {
    ...message,
    content: [{ type: 'text', text }],
  };
}

function replaceLatestUserPrompt(
  messages: ChatMessage[],
  prompt: string,
): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const cloned = messages.map((entry) => ({ ...entry }));
    cloned[i] = cloneMessageWithTextContent(cloned[i], prompt);
    return cloned;
  }
  return [...messages, { role: 'user', content: prompt }];
}

function parseRalphChoice(
  content: ChatMessageContent,
): 'CONTINUE' | 'STOP' | null {
  const normalizedContent = normalizeMessageContentToText(content);
  if (!normalizedContent) return null;
  const re = /<choice>\s*([^<]*)\s*<\/choice>/gi;
  let match: RegExpExecArray | null = null;
  let lastChoice: string | null = null;
  while (true) {
    match = re.exec(normalizedContent);
    if (!match) break;
    lastChoice = (match[1] || '').trim().toUpperCase();
  }
  if (lastChoice === 'CONTINUE' || lastChoice === 'STOP') return lastChoice;
  return null;
}

function stripRalphChoiceTags(content: ChatMessageContent): string | null {
  const normalizedContent = normalizeMessageContentToText(content);
  if (!normalizedContent) return null;
  const stripped = normalizedContent
    .replace(/<choice>\s*[^<]*\s*<\/choice>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return stripped || normalizedContent;
}

function buildRalphPrompt(taskPrompt: string, missingChoice: boolean): string {
  const punctuatedPrompt = /[.!?]$/.test(taskPrompt)
    ? taskPrompt
    : `${taskPrompt}.`;
  const lines = [
    `${punctuatedPrompt} (You are running in an automated loop where the same prompt is fed repeatedly. Only choose STOP when the task is fully complete. Including it will stop further iterations. If you are not 100% sure, choose CONTINUE.)`,
    '',
    'Available branches:',
    '- CONTINUE',
    '- STOP',
    '',
    'Reply with a choice using <choice>...</choice>.',
  ];
  if (missingChoice) {
    lines.push('');
    lines.push(
      'Your last response did not include a valid choice. Include exactly one: CONTINUE or STOP.',
    );
  }
  return lines.join('\n');
}

function resolveMaxModelTurns(): number {
  if (!RALPH_ENABLED) return MAX_ITERATIONS;
  if (RALPH_MAX_EXTRA_ITERATIONS < 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(MAX_ITERATIONS, RALPH_MAX_EXTRA_ITERATIONS + 1);
}

function inferMimeType(filePath: string): string {
  return inferArtifactMimeType(filePath);
}

function normalizeArtifactPath(rawPath: unknown): string | null {
  const value = String(rawPath || '').trim();
  if (!value) return null;

  const workspacePath = resolveWorkspacePath(value);
  if (workspacePath) {
    const relative = path
      .relative(WORKSPACE_ROOT, workspacePath)
      .replace(/\\/g, '/');
    return relative
      ? `${WORKSPACE_ROOT_DISPLAY}/${relative}`
      : WORKSPACE_ROOT_DISPLAY;
  }

  const normalized = normalizePathSlashes(value);
  if (path.posix.isAbsolute(normalized)) return null;
  const clean = path.posix.normalize(normalized);
  if (clean === '..' || clean.startsWith('../')) return null;
  return path.posix.join(WORKSPACE_ROOT_DISPLAY, clean);
}

function extractToolArtifacts(
  toolName: string,
  result: string,
): ArtifactMetadata[] {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(result) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    return [];
  }

  if (!parsed || parsed.success !== true) return [];
  const artifacts: ArtifactMetadata[] = [];

  const addArtifact = (
    rawPath: unknown,
    rawFilename?: unknown,
    rawMimeType?: unknown,
  ): void => {
    const normalizedPath = normalizeArtifactPath(rawPath);
    if (!normalizedPath) return;
    const filename =
      typeof rawFilename === 'string' && rawFilename.trim()
        ? rawFilename.trim()
        : path.posix.basename(normalizedPath);
    const mimeType =
      typeof rawMimeType === 'string' && rawMimeType.trim()
        ? rawMimeType.trim()
        : inferMimeType(filename || normalizedPath);
    artifacts.push({ path: normalizedPath, filename, mimeType });
  };

  if (Array.isArray(parsed.artifacts)) {
    for (const item of parsed.artifacts) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      addArtifact(entry.path, entry.filename, entry.mimeType);
    }
    if (artifacts.length > 0) return artifacts;
  }

  if (toolName === 'browser_screenshot' || toolName === 'browser_pdf') {
    addArtifact(parsed.path);
  }
  return artifacts;
}

function normalizeArtifactKey(filePath: string): string {
  return normalizePathSlashes(filePath).toLowerCase();
}

function collectRequestedArtifacts(params: {
  artifacts: ArtifactMetadata[];
  artifactPaths: Set<string>;
  startedAtMs: number;
}): void {
  const discovered = discoverArtifactsSince(WORKSPACE_ROOT, {
    modifiedAfterMs: Math.max(0, params.startedAtMs - 1_000),
    modifiedBeforeMs: Date.now() + 1_000,
    limit: 8,
  });

  for (const artifact of discovered) {
    const normalizedPath = normalizeArtifactPath(artifact.path);
    if (!normalizedPath) continue;
    const key = normalizeArtifactKey(normalizedPath);
    if (params.artifactPaths.has(key)) continue;
    params.artifactPaths.add(key);
    params.artifacts.push({
      path: normalizedPath,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
    });
  }
}

async function callHybridAIWithRetry(params: {
  provider?: 'hybridai' | 'openai-codex';
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  enableRag: boolean;
  requestHeaders?: Record<string, string>;
  history: ChatMessage[];
  tools: ToolDefinition[];
  onTextDelta?: (delta: string) => void;
  maxTokens?: number;
}): Promise<Awaited<ReturnType<typeof callHybridAI>>> {
  const {
    provider,
    baseUrl,
    apiKey,
    model,
    chatbotId,
    enableRag,
    requestHeaders,
    history,
    tools,
    onTextDelta,
    maxTokens,
  } = params;
  let attempt = 0;
  let delayMs = RETRY_BASE_DELAY_MS;

  while (true) {
    attempt += 1;
    const attemptStartedAt = Date.now();
    console.error(
      `[model] call start provider=${provider || 'hybridai'} model=${model} attempt=${attempt} streaming=${Boolean(onTextDelta)} messages=${history.length} tools=${tools.length}`,
    );
    await emitRuntimeEvent({ event: 'before_model_call', attempt });
    try {
      let response: Awaited<ReturnType<typeof callHybridAI>>;
      if (onTextDelta) {
        try {
          response = await callHybridAIStream(
            provider,
            baseUrl,
            apiKey,
            model,
            chatbotId,
            enableRag,
            requestHeaders,
            history,
            tools,
            onTextDelta,
            maxTokens,
          );
        } catch (streamErr) {
          const fallbackEligible = shouldDowngradeStreamToNonStreaming(
            provider,
            streamErr,
          );
          if (!fallbackEligible) throw streamErr;
          response = await callHybridAI(
            provider,
            baseUrl,
            apiKey,
            model,
            chatbotId,
            enableRag,
            requestHeaders,
            history,
            tools,
            maxTokens,
          );
        }
      } else {
        response = await callHybridAI(
          provider,
          baseUrl,
          apiKey,
          model,
          chatbotId,
          enableRag,
          requestHeaders,
          history,
          tools,
          maxTokens,
        );
      }
      console.error(
        `[model] call success provider=${provider || 'hybridai'} model=${model} attempt=${attempt} durationMs=${Date.now() - attemptStartedAt} toolCalls=${response.choices[0]?.message?.tool_calls?.length || 0}`,
      );
      await emitRuntimeEvent({
        event: 'after_model_call',
        attempt,
        toolCallCount: response.choices[0]?.message?.tool_calls?.length || 0,
      });
      return response;
    } catch (err) {
      const retryable =
        RETRY_ENABLED &&
        isRetryableModelError(err) &&
        attempt < RETRY_MAX_ATTEMPTS;
      await emitRuntimeEvent({
        event: retryable ? 'model_retry' : 'model_error',
        attempt,
        retryable,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(
        `[model] call ${retryable ? 'retry' : 'error'} provider=${provider || 'hybridai'} model=${model} attempt=${attempt} durationMs=${Date.now() - attemptStartedAt} retryable=${retryable} error=${err instanceof Error ? err.message : String(err)}`,
      );
      if (!retryable) throw err;
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, RETRY_MAX_DELAY_MS);
    }
  }
}

/**
 * Process a single request: call API, run tool loop, write output.
 */
async function processRequest(
  messages: ChatMessage[],
  apiKey: string,
  baseUrl: string,
  provider: 'hybridai' | 'openai-codex' | undefined,
  model: string,
  chatbotId: string,
  enableRag: boolean,
  requestHeaders: Record<string, string> | undefined,
  tools: ToolDefinition[],
  maxTokens?: number,
  effectiveUserPromptOverride?: string,
): Promise<ContainerOutput> {
  const processStartedAt = Date.now();
  await emitRuntimeEvent({
    event: 'before_agent_start',
    messageCount: messages.length,
  });
  const history: ChatMessage[] = injectRuntimeCapabilitiesMessage(messages);
  const toolsUsed: string[] = [];
  const toolExecutions: ToolExecution[] = [];
  const artifacts: ArtifactMetadata[] = [];
  const artifactPaths = new Set<string>();
  const tokenUsage = createTokenUsageStats();
  const effectiveUserPrompt =
    effectiveUserPromptOverride || latestUserPrompt(messages);
  const ralphSeedPrompt = RALPH_ENABLED ? effectiveUserPrompt : '';
  const maxModelTurns = resolveMaxModelTurns();
  let ralphExtraIterations = 0;
  let iterations = 0;

  while (iterations < maxModelTurns) {
    iterations++;
    tokenUsage.modelCalls += 1;
    tokenUsage.estimatedPromptTokens += estimateMessageTokens(history);

    let response: Awaited<ReturnType<typeof callHybridAIWithRetry>>;
    try {
      response = await callHybridAIWithRetry({
        provider,
        baseUrl,
        apiKey,
        model,
        chatbotId,
        enableRag,
        requestHeaders,
        history,
        tools,
        onTextDelta: emitStreamDelta,
        maxTokens,
      });
    } catch (err) {
      const failed: ContainerOutput = {
        status: 'error',
        result: null,
        toolsUsed,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        toolExecutions,
        tokenUsage: finalizeTokenUsage(tokenUsage),
        error: `API error: ${err instanceof Error ? err.message : String(err)}`,
      };
      await emitRuntimeEvent({
        event: 'turn_end',
        status: failed.status,
        toolsUsed,
      });
      return failed;
    }

    accumulateApiUsage(tokenUsage, response);

    const choice = response.choices[0];
    if (!choice) {
      const failed: ContainerOutput = {
        status: 'error',
        result: null,
        toolsUsed,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        toolExecutions,
        tokenUsage: finalizeTokenUsage(tokenUsage),
        error: 'No response from API',
      };
      await emitRuntimeEvent({
        event: 'turn_end',
        status: failed.status,
        toolsUsed,
      });
      return failed;
    }

    tokenUsage.estimatedCompletionTokens += estimateTextTokens(
      choice.message.content,
    );
    if (choice.message.tool_calls?.length) {
      tokenUsage.estimatedCompletionTokens += estimateTextTokens(
        JSON.stringify(choice.message.tool_calls),
      );
    }

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: choice.message.content,
    };

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      assistantMessage.tool_calls = choice.message.tool_calls;
    }

    history.push(assistantMessage);

    const toolCalls = choice.message.tool_calls || [];
    if (toolCalls.length === 0) {
      if (RALPH_ENABLED) {
        const branchChoice = parseRalphChoice(choice.message.content);
        if (branchChoice === 'STOP') {
          collectRequestedArtifacts({
            artifacts,
            artifactPaths,
            startedAtMs: processStartedAt,
          });
          const completed: ContainerOutput = {
            status: 'success',
            result: stripRalphChoiceTags(choice.message.content),
            toolsUsed: [...new Set(toolsUsed)],
            ...(artifacts.length > 0 ? { artifacts } : {}),
            toolExecutions,
            tokenUsage: finalizeTokenUsage(tokenUsage),
            effectiveUserPrompt,
          };
          await emitRuntimeEvent({
            event: 'turn_end',
            status: completed.status,
            toolsUsed: completed.toolsUsed,
          });
          return completed;
        }

        const canContinue =
          RALPH_MAX_EXTRA_ITERATIONS < 0 ||
          ralphExtraIterations < RALPH_MAX_EXTRA_ITERATIONS;
        if (canContinue) {
          ralphExtraIterations += 1;
          history.push({
            role: 'user',
            content: buildRalphPrompt(ralphSeedPrompt, branchChoice == null),
          });
          console.error(
            `[ralph] continue ${ralphExtraIterations}` +
              (RALPH_MAX_EXTRA_ITERATIONS < 0
                ? ''
                : `/${RALPH_MAX_EXTRA_ITERATIONS}`),
          );
          continue;
        }
      }

      collectRequestedArtifacts({
        artifacts,
        artifactPaths,
        startedAtMs: processStartedAt,
      });
      const completed: ContainerOutput = {
        status: 'success',
        result: stripRalphChoiceTags(choice.message.content),
        toolsUsed: [...new Set(toolsUsed)],
        ...(artifacts.length > 0 ? { artifacts } : {}),
        toolExecutions,
        tokenUsage: finalizeTokenUsage(tokenUsage),
        effectiveUserPrompt,
      };
      await emitRuntimeEvent({
        event: 'turn_end',
        status: completed.status,
        toolsUsed: completed.toolsUsed,
      });
      return completed;
    }

    for (const call of toolCalls) {
      const toolName = call.function.name;
      const approval = approvalRuntime.evaluateToolCall({
        toolName,
        argsJson: call.function.arguments,
        latestUserPrompt: effectiveUserPrompt,
      });

      toolsUsed.push(toolName);
      const toolPreview =
        approval.tier === 'yellow'
          ? approvalRuntime.formatYellowNarration(approval)
          : call.function.arguments.slice(0, 100);
      console.error(`[tool] ${toolName}: ${toolPreview}`);
      const toolStart = Date.now();
      if (approval.decision === 'required') {
        const toolDuration = Date.now() - toolStart;
        const prompt = approvalRuntime.formatApprovalRequest(approval);
        toolExecutions.push({
          name: toolName,
          arguments: call.function.arguments,
          result: prompt,
          durationMs: toolDuration,
          isError: false,
          blocked: true,
          blockedReason: approval.reason,
          approvalTier: approval.tier,
          approvalBaseTier: approval.baseTier,
          approvalDecision: approval.decision,
          approvalActionKey: approval.actionKey,
          approvalReason: approval.reason,
          approvalRequestId: approval.requestId,
        });
        const waitingForApproval: ContainerOutput = {
          status: 'success',
          result: prompt,
          toolsUsed: [...new Set(toolsUsed)],
          ...(artifacts.length > 0 ? { artifacts } : {}),
          toolExecutions,
          tokenUsage: finalizeTokenUsage(tokenUsage),
          effectiveUserPrompt,
        };
        await emitRuntimeEvent({
          event: 'turn_end',
          status: waitingForApproval.status,
          toolsUsed: waitingForApproval.toolsUsed,
        });
        return waitingForApproval;
      }
      if (approval.decision === 'denied') {
        const toolDuration = Date.now() - toolStart;
        const denialText = `Approval denied: ${approval.reason}`;
        toolExecutions.push({
          name: toolName,
          arguments: call.function.arguments,
          result: denialText,
          durationMs: toolDuration,
          isError: true,
          blocked: true,
          blockedReason: approval.reason,
          approvalTier: approval.tier,
          approvalBaseTier: approval.baseTier,
          approvalDecision: approval.decision,
          approvalActionKey: approval.actionKey,
          approvalReason: approval.reason,
          approvalRequestId: approval.requestId,
        });
        const denied: ContainerOutput = {
          status: 'success',
          result: denialText,
          toolsUsed: [...new Set(toolsUsed)],
          ...(artifacts.length > 0 ? { artifacts } : {}),
          toolExecutions,
          tokenUsage: finalizeTokenUsage(tokenUsage),
          effectiveUserPrompt,
        };
        await emitRuntimeEvent({
          event: 'turn_end',
          status: denied.status,
          toolsUsed: denied.toolsUsed,
        });
        return denied;
      }
      if (
        approval.tier === 'yellow' &&
        approval.implicitDelayMs &&
        approval.implicitDelayMs > 0
      ) {
        await sleep(approval.implicitDelayMs);
      }
      const blockedReason = await runBeforeToolHooks(
        toolName,
        call.function.arguments,
      );
      const result = blockedReason
        ? `Tool blocked by security hook: ${blockedReason}`
        : await executeTool(toolName, call.function.arguments);
      const toolDuration = Date.now() - toolStart;
      const isError = inferToolError(result, blockedReason);
      const succeeded = !blockedReason && !isError;
      if (succeeded) {
        captureSkillSelection(toolName, call.function.arguments);
      }
      approvalRuntime.afterToolExecution(approval, succeeded);
      await runAfterToolHooks(toolName, call.function.arguments, result);
      console.error(
        `[tool] ${toolName} result (${toolDuration}ms): ${result.slice(0, 100)}`,
      );
      toolExecutions.push({
        name: toolName,
        arguments: call.function.arguments,
        result,
        durationMs: toolDuration,
        isError,
        blocked: Boolean(blockedReason),
        blockedReason: blockedReason || undefined,
        approvalTier: approval.tier,
        approvalBaseTier: approval.baseTier,
        approvalDecision: blockedReason ? 'denied' : approval.decision,
        approvalActionKey: approval.actionKey,
        approvalReason: approval.reason,
        approvalRequestId: approval.requestId,
      });
      for (const artifact of extractToolArtifacts(toolName, result)) {
        const artifactKey = normalizeArtifactKey(artifact.path);
        if (artifactPaths.has(artifactKey)) continue;
        artifactPaths.add(artifactKey);
        artifacts.push(artifact);
      }
      history.push({ role: 'tool', content: result, tool_call_id: call.id });

      // Bail on fatal filesystem/system errors — retrying won't help
      if (/EROFS|EPERM|EACCES|read-only file system/i.test(result)) {
        const failed: ContainerOutput = {
          status: 'error',
          result: null,
          toolsUsed,
          ...(artifacts.length > 0 ? { artifacts } : {}),
          toolExecutions,
          tokenUsage: finalizeTokenUsage(tokenUsage),
          error: result,
          effectiveUserPrompt,
        };
        await emitRuntimeEvent({
          event: 'turn_end',
          status: failed.status,
          toolsUsed,
        });
        return failed;
      }
    }
  }

  const lastAssistant = history.filter((m) => m.role === 'assistant').pop();
  collectRequestedArtifacts({
    artifacts,
    artifactPaths,
    startedAtMs: processStartedAt,
  });
  const completed: ContainerOutput = {
    status: 'success',
    result:
      stripRalphChoiceTags(lastAssistant?.content || null) ||
      'Max tool iterations reached.',
    toolsUsed: [...new Set(toolsUsed)],
    ...(artifacts.length > 0 ? { artifacts } : {}),
    toolExecutions,
    tokenUsage: finalizeTokenUsage(tokenUsage),
    effectiveUserPrompt,
  };
  await emitRuntimeEvent({
    event: 'turn_end',
    status: completed.status,
    toolsUsed: completed.toolsUsed,
  });
  return completed;
}

/**
 * Main loop: read first request from stdin (with secrets), then poll IPC for follow-ups.
 */
function resolveTools(input: ContainerInput): ToolDefinition[] {
  const mcpTools = mcpClientManager?.getAllToolDefinitions() || [];
  let tools = [...TOOL_DEFINITIONS, ...mcpTools];
  if (input.allowedTools) {
    const allowed = new Set(input.allowedTools);
    tools = tools.filter((tool) => allowed.has(tool.function.name));
  }
  if (Array.isArray(input.blockedTools) && input.blockedTools.length > 0) {
    const blocked = new Set(
      input.blockedTools
        .map((name) => String(name || '').trim())
        .filter(Boolean),
    );
    tools = tools.filter((tool) => !blocked.has(tool.function.name));
  }
  tools = tools.map((tool) => {
    if (tool.function.name !== 'message') return tool;
    return {
      ...tool,
      function: {
        ...tool.function,
        description: getMessageToolDescription(input.channelId),
      },
    };
  });
  // Sort alphabetically for deterministic tool ordering (request/cache stability)
  tools.sort((a, b) => a.function.name.localeCompare(b.function.name));
  return tools;
}

function shouldRetryWithoutNativeVision(error: string | undefined): boolean {
  const normalized = String(error || '').toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('image_url') ||
    normalized.includes('unsupported image') ||
    normalized.includes('unsupported content') ||
    normalized.includes('vision') ||
    normalized.includes('multimodal') ||
    normalized.includes('content part')
  );
}

async function main(): Promise<void> {
  console.error(
    `[hybridclaw-agent] started, idle timeout ${IDLE_TIMEOUT_MS}ms`,
  );

  // First request arrives via stdin (contains apiKey — never written to disk)
  const stdinData = await readStdinLine();
  const firstInput: ContainerInput = JSON.parse(stdinData);
  storedApiKey = firstInput.apiKey;
  storedRequestHeaders = { ...(firstInput.requestHeaders || {}) };

  console.error(
    `[hybridclaw-agent] processing first request (${firstInput.messages.length} messages)`,
  );

  await syncMcpConfig(firstInput.mcpServers);
  resetSideEffects();
  setScheduledTasks(firstInput.scheduledTasks);
  setSessionContext(firstInput.sessionId);
  setGatewayContext(
    firstInput.gatewayBaseUrl,
    firstInput.gatewayApiToken,
    firstInput.channelId,
    firstInput.configuredDiscordChannels,
  );
  setWebSearchConfig(firstInput.webSearch);
  setModelContext(
    firstInput.provider,
    firstInput.baseUrl,
    storedApiKey,
    firstInput.model,
    firstInput.chatbotId,
    storedRequestHeaders,
  );
  setMediaContext(firstInput.media);
  const firstMessages = await injectNativeVisionContent(
    firstInput.messages,
    firstInput.model,
    firstInput.media,
  );
  const firstPrelude = approvalRuntime.handleApprovalResponse(firstMessages);
  const firstPromptOverride = firstPrelude?.replayPrompt;
  const firstPreparedMessages = firstPromptOverride
    ? replaceLatestUserPrompt(firstMessages, firstPromptOverride)
    : firstMessages;
  const firstMessagesForRequest = injectSkillCacheHint(firstPreparedMessages);

  let firstOutput: ContainerOutput;
  if (firstPrelude?.immediateMessage && !firstPromptOverride) {
    firstOutput = {
      status: 'success',
      result: firstPrelude.immediateMessage,
      toolsUsed: [],
      toolExecutions: [],
      effectiveUserPrompt: latestUserPrompt(firstMessagesForRequest),
    };
    console.error('[approval] resolved user response without model run');
  } else {
    firstOutput = await processRequest(
      firstMessagesForRequest,
      storedApiKey,
      firstInput.baseUrl,
      firstInput.provider,
      firstInput.model,
      firstInput.chatbotId,
      firstInput.enableRag,
      storedRequestHeaders,
      resolveTools(firstInput),
      firstInput.maxTokens,
      firstPromptOverride,
    );
    if (
      firstMessagesForRequest !== firstInput.messages &&
      firstOutput.status === 'error' &&
      shouldRetryWithoutNativeVision(firstOutput.error)
    ) {
      console.error(
        '[media] native vision injection rejected by model; retrying without image parts',
      );
      const firstRetryMessages = firstPromptOverride
        ? replaceLatestUserPrompt(firstInput.messages, firstPromptOverride)
        : firstInput.messages;
      const firstRetryMessagesWithSkillCache =
        injectSkillCacheHint(firstRetryMessages);
      firstOutput = await processRequest(
        firstRetryMessagesWithSkillCache,
        storedApiKey,
        firstInput.baseUrl,
        firstInput.provider,
        firstInput.model,
        firstInput.chatbotId,
        firstInput.enableRag,
        firstInput.requestHeaders,
        resolveTools(firstInput),
        firstInput.maxTokens,
        firstPromptOverride,
      );
    }
  }

  firstOutput.sideEffects = getPendingSideEffects();
  writeOutput(firstOutput);
  console.error(
    `[hybridclaw-agent] first request complete: ${firstOutput.status}`,
  );

  // Subsequent requests come via IPC file polling
  while (true) {
    const input = await waitForInput(IDLE_TIMEOUT_MS);

    if (!input) {
      console.error('[hybridclaw-agent] idle timeout, exiting');
      await shutdownMcp();
      process.exit(0);
    }

    // Use stored apiKey — IPC file no longer contains it
    const apiKey = input.apiKey || storedApiKey;
    const requestHeaders =
      input.requestHeaders && Object.keys(input.requestHeaders).length > 0
        ? input.requestHeaders
        : storedRequestHeaders;
    if (input.apiKey) storedApiKey = input.apiKey;
    if (input.requestHeaders && Object.keys(input.requestHeaders).length > 0) {
      storedRequestHeaders = { ...input.requestHeaders };
    }

    console.error(
      `[hybridclaw-agent] processing request (${input.messages.length} messages)`,
    );

    await syncMcpConfig(input.mcpServers);
    resetSideEffects();
    setScheduledTasks(input.scheduledTasks);
    setSessionContext(input.sessionId);
    setGatewayContext(
      input.gatewayBaseUrl,
      input.gatewayApiToken,
      input.channelId,
      input.configuredDiscordChannels,
    );
    setWebSearchConfig(input.webSearch);
    setModelContext(
      input.provider,
      input.baseUrl,
      apiKey,
      input.model,
      input.chatbotId,
      requestHeaders,
    );
    setMediaContext(input.media);
    const preparedMessages = await injectNativeVisionContent(
      input.messages,
      input.model,
      input.media,
    );
    const prelude = approvalRuntime.handleApprovalResponse(preparedMessages);
    const promptOverride = prelude?.replayPrompt;
    const messagesForRequest = promptOverride
      ? replaceLatestUserPrompt(preparedMessages, promptOverride)
      : preparedMessages;
    const messagesForRequestWithSkillCache =
      injectSkillCacheHint(messagesForRequest);

    if (prelude?.immediateMessage && !promptOverride) {
      const immediate: ContainerOutput = {
        status: 'success',
        result: prelude.immediateMessage,
        toolsUsed: [],
        toolExecutions: [],
        effectiveUserPrompt: latestUserPrompt(messagesForRequestWithSkillCache),
      };
      immediate.sideEffects = getPendingSideEffects();
      writeOutput(immediate);
      console.error('[approval] resolved user response without model run');
      continue;
    }

    let output = await processRequest(
      messagesForRequestWithSkillCache,
      apiKey,
      input.baseUrl,
      input.provider,
      input.model,
      input.chatbotId,
      input.enableRag,
      requestHeaders,
      resolveTools(input),
      input.maxTokens,
      promptOverride,
    );
    if (
      messagesForRequestWithSkillCache !== input.messages &&
      output.status === 'error' &&
      shouldRetryWithoutNativeVision(output.error)
    ) {
      console.error(
        '[media] native vision injection rejected by model; retrying without image parts',
      );
      const retryMessages = promptOverride
        ? replaceLatestUserPrompt(input.messages, promptOverride)
        : input.messages;
      const retryMessagesWithSkillCache = injectSkillCacheHint(retryMessages);
      output = await processRequest(
        retryMessagesWithSkillCache,
        apiKey,
        input.baseUrl,
        input.provider,
        input.model,
        input.chatbotId,
        input.enableRag,
        requestHeaders,
        resolveTools(input),
        input.maxTokens,
        promptOverride,
      );
    }

    output.sideEffects = getPendingSideEffects();
    writeOutput(output);
    console.error(`[hybridclaw-agent] request complete: ${output.status}`);
  }
}

main().catch((err) => {
  console.error('Container agent fatal error:', err);
  void shutdownMcp().finally(() => {
    writeOutput({
      status: 'error',
      result: null,
      toolsUsed: [],
      error: `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  });
});
