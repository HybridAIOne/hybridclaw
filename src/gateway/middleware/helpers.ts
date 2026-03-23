import { isAudioMediaItem } from '../../media/audio-transcription.js';
import { resolveSessionResetChannelKind } from '../../session/session-reset.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from '../../session/token-efficiency.js';
import type {
  ChatMessage,
  ContainerOutput,
  MediaContextItem,
  StoredMessage,
  TokenUsageStats,
  ToolExecution,
} from '../../types.js';
import type {
  GatewayChatRequestLike,
  GatewaySuccessResultState,
  MediaToolPolicy,
} from './types.js';

const IMAGE_QUESTION_RE =
  /(what(?:'s| is)? on (?:the )?(?:image|picture|photo|screenshot)|describe (?:this|the) (?:image|picture|photo)|image|picture|photo|screenshot|ocr|diagram|chart|grafik|bild|foto|was steht|was ist auf dem bild)/i;
const BROWSER_TAB_RE =
  /(browser|tab|current tab|web page|website|seite im browser|aktuellen tab)/i;

const GATEWAY_TURN_LOOP_WARNING_PREFIX = '[Loop warning]';
const GATEWAY_TURN_LOOP_GUARD_PREFIX = '[Loop guard]';

export function resolveChannelType(
  req: Pick<GatewayChatRequestLike, 'channelId' | 'source'>,
): string | undefined {
  const source = String(req.source || '')
    .trim()
    .toLowerCase();
  if (
    source === 'discord' ||
    source === 'whatsapp' ||
    source === 'email' ||
    source === 'msteams'
  ) {
    return source;
  }
  const inferredChannelType = resolveSessionResetChannelKind(req.channelId);
  if (
    inferredChannelType === 'discord' ||
    inferredChannelType === 'whatsapp' ||
    inferredChannelType === 'email'
  ) {
    return inferredChannelType;
  }
  return source && source !== 'unknown' ? source : undefined;
}

export function normalizeMediaContextItems(
  raw: GatewayChatRequestLike['media'],
): MediaContextItem[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const normalized: MediaContextItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const path =
      typeof item.path === 'string' && item.path.trim()
        ? item.path.trim()
        : null;
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const originalUrl =
      typeof item.originalUrl === 'string' ? item.originalUrl.trim() : '';
    const filename =
      typeof item.filename === 'string' ? item.filename.trim() : '';
    if (!url || !originalUrl || !filename) continue;
    const sizeBytes =
      typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes)
        ? Math.max(0, Math.floor(item.sizeBytes))
        : 0;
    const mimeType =
      typeof item.mimeType === 'string' && item.mimeType.trim()
        ? item.mimeType.trim().toLowerCase()
        : null;
    normalized.push({
      path,
      url,
      originalUrl,
      mimeType,
      sizeBytes,
      filename,
    });
  }
  return normalized;
}

function isImageMediaItem(item: MediaContextItem): boolean {
  const mimeType = String(item.mimeType || '')
    .trim()
    .toLowerCase();
  if (mimeType.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|tiff?)$/i.test(
    item.filename || '',
  );
}

export function buildMediaPromptContext(media: MediaContextItem[]): string {
  if (media.length === 0) return '';
  const mediaPaths = media
    .map((item) => item.path)
    .filter((path): path is string => Boolean(path));
  const imagePaths = media
    .filter((item) => isImageMediaItem(item) && item.path)
    .map((item) => item.path as string);
  const audioPaths = media
    .filter((item) => isAudioMediaItem(item) && item.path)
    .map((item) => item.path as string);
  const documentPaths = media
    .filter(
      (item) => !isImageMediaItem(item) && !isAudioMediaItem(item) && item.path,
    )
    .map((item) => item.path as string);
  const mediaUrls = media.map((item) => item.url);
  const mediaTypes = media.map((item) => item.mimeType || 'unknown');
  const payload = media.map((item, index) => ({
    order: index + 1,
    path: item.path,
    mime: item.mimeType || 'unknown',
    size: item.sizeBytes,
    filename: item.filename,
    original_url: item.originalUrl,
    url: item.url,
  }));
  return [
    '[MediaContext]',
    `MediaPaths: ${JSON.stringify(mediaPaths)}`,
    `ImageMediaPaths: ${JSON.stringify(imagePaths)}`,
    `AudioMediaPaths: ${JSON.stringify(audioPaths)}`,
    `DocumentMediaPaths: ${JSON.stringify(documentPaths)}`,
    `MediaUrls: ${JSON.stringify(mediaUrls)}`,
    `MediaTypes: ${JSON.stringify(mediaTypes)}`,
    `MediaItems: ${JSON.stringify(payload)}`,
    'Prefer current-turn attachments and file inputs over `message` reads, `glob`, `find`, or workspace-wide discovery.',
    'When the user asks about current-turn image attachments, use `vision_analyze` with local image paths from `ImageMediaPaths` first.',
    'When the user asks about current-turn PDF/document attachments, prefer the injected `<file>` content or the supplied local path before reading chat history.',
    'Use MediaUrls as fallback when a local path is missing or fails to open.',
    'Use `browser_vision` only for questions about the active browser tab/page.',
    '',
    '',
  ].join('\n');
}

function isImageQuestion(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  return IMAGE_QUESTION_RE.test(normalized);
}

function isExplicitBrowserTabQuestion(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  return BROWSER_TAB_RE.test(normalized);
}

export function resolveMediaToolPolicy(
  content: string,
  media: MediaContextItem[],
): MediaToolPolicy {
  const imageMedia = media.filter((item) => isImageMediaItem(item));
  if (imageMedia.length === 0) {
    return {
      blockedTools: undefined,
      prioritizeVisionTool: false,
    };
  }

  const imageQuestion = isImageQuestion(content);
  const explicitBrowserTab = isExplicitBrowserTabQuestion(content);
  if (imageQuestion && !explicitBrowserTab) {
    return {
      blockedTools: ['browser_vision'],
      prioritizeVisionTool: true,
    };
  }

  return {
    blockedTools: undefined,
    prioritizeVisionTool: false,
  };
}

export function extractUsageCostUsd(tokenUsage?: TokenUsageStats): number {
  if (!tokenUsage) return 0;
  const costCarrier = tokenUsage as unknown as Record<string, unknown>;
  const value = firstNumber([
    costCarrier.costUsd,
    costCarrier.costUSD,
    costCarrier.cost_usd,
    costCarrier.estimatedCostUsd,
    costCarrier.estimated_cost_usd,
  ]);
  if (value == null) return 0;
  return Math.max(0, value);
}

export function formatCanonicalContextPrompt(params: {
  summary: string | null;
  recentMessages: Array<{
    role: string;
    content: string;
    session_id: string;
    channel_id: string | null;
  }>;
}): string | null {
  const sections: string[] = [];
  const summary = (params.summary || '').trim();
  if (summary) {
    sections.push(['### Canonical Session Summary', summary].join('\n'));
  }

  if (params.recentMessages.length > 0) {
    const lines = params.recentMessages.slice(-6).map((entry) => {
      const role = (entry.role || 'user').trim().toLowerCase();
      const who = role === 'assistant' ? 'Assistant' : 'User';
      const from = entry.channel_id?.trim()
        ? `${entry.channel_id.trim()} (${entry.session_id})`
        : entry.session_id;
      const compact = entry.content.replace(/\s+/g, ' ').trim();
      const short =
        compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
      return `- ${who} [${from}]: ${short}`;
    });
    sections.push(
      [
        '### Cross-Channel Recall',
        'Recent context from other sessions/channels for this user:',
        ...lines,
      ].join('\n'),
    );
  }

  const merged = sections.join('\n\n').trim();
  return merged || null;
}

export function formatPluginPromptContext(sections: string[]): string | null {
  const normalized = sections
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (normalized.length === 0) return null;
  return normalized.join('\n\n');
}

function buildStoredTurnMessages(params: {
  sessionId: string;
  userId: string;
  username: string | null;
  userContent: string;
  resultText: string;
}): StoredMessage[] {
  const timestamp = new Date().toISOString();
  return [
    {
      id: 0,
      session_id: params.sessionId,
      user_id: params.userId,
      username: params.username,
      role: 'user',
      content: params.userContent,
      created_at: timestamp,
    },
    {
      id: 0,
      session_id: params.sessionId,
      user_id: 'assistant',
      username: null,
      role: 'assistant',
      content: params.resultText,
      created_at: timestamp,
    },
  ];
}

export function buildGatewaySuccessResultState(params: {
  request: Pick<GatewayChatRequestLike, 'sessionId' | 'userId' | 'username'>;
  output: ContainerOutput;
  pluginsUsed?: string[];
  toolExecutions: ToolExecution[];
  userContent: string;
  resultText: string;
}): GatewaySuccessResultState {
  return {
    resultText: params.resultText,
    storedTurnMessages: buildStoredTurnMessages({
      sessionId: params.request.sessionId,
      userId: params.request.userId,
      username: params.request.username,
      userContent: params.userContent,
      resultText: params.resultText,
    }),
    finalResult: {
      status: 'success',
      result: params.resultText,
      toolsUsed: params.output.toolsUsed || [],
      pluginsUsed: params.pluginsUsed,
      memoryCitations: params.output.memoryCitations,
      artifacts: params.output.artifacts,
      toolExecutions: params.toolExecutions,
      pendingApproval: params.output.pendingApproval,
      tokenUsage: params.output.tokenUsage,
      effectiveUserPrompt: params.output.effectiveUserPrompt,
    },
  };
}

export function buildTokenUsageAuditPayload(
  messages: ChatMessage[],
  resultText: string | null | undefined,
  tokenUsage?: TokenUsageStats,
): Record<string, number | boolean> {
  const promptChars = messages.reduce((total, message) => {
    const content = typeof message.content === 'string' ? message.content : '';
    return total + content.length;
  }, 0);
  const completionChars = (resultText || '').length;

  const fallbackEstimatedPromptTokens =
    estimateTokenCountFromMessages(messages);
  const fallbackEstimatedCompletionTokens = estimateTokenCountFromText(
    resultText || '',
  );
  const estimatedPromptTokens =
    tokenUsage?.estimatedPromptTokens || fallbackEstimatedPromptTokens;
  const estimatedCompletionTokens =
    tokenUsage?.estimatedCompletionTokens || fallbackEstimatedCompletionTokens;
  const estimatedTotalTokens =
    tokenUsage?.estimatedTotalTokens ||
    estimatedPromptTokens + estimatedCompletionTokens;

  const apiUsageAvailable = tokenUsage?.apiUsageAvailable === true;
  const apiPromptTokens = tokenUsage?.apiPromptTokens || 0;
  const apiCompletionTokens = tokenUsage?.apiCompletionTokens || 0;
  const apiTotalTokens =
    tokenUsage?.apiTotalTokens || apiPromptTokens + apiCompletionTokens;
  const apiCacheUsageAvailable = tokenUsage?.apiCacheUsageAvailable === true;
  const apiCacheReadTokens = tokenUsage?.apiCacheReadTokens || 0;
  const apiCacheWriteTokens = tokenUsage?.apiCacheWriteTokens || 0;
  const promptTokens = apiUsageAvailable
    ? apiPromptTokens
    : estimatedPromptTokens;
  const completionTokens = apiUsageAvailable
    ? apiCompletionTokens
    : estimatedCompletionTokens;
  const totalTokens = apiUsageAvailable ? apiTotalTokens : estimatedTotalTokens;

  return {
    modelCalls: tokenUsage ? Math.max(1, tokenUsage.modelCalls) : 0,
    promptChars,
    completionChars,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedPromptTokens,
    estimatedCompletionTokens,
    estimatedTotalTokens,
    apiUsageAvailable,
    apiPromptTokens,
    apiCompletionTokens,
    apiTotalTokens,
    ...(apiCacheUsageAvailable
      ? {
          apiCacheUsageAvailable,
          apiCacheReadTokens,
          apiCacheWriteTokens,
          cacheReadTokens: apiCacheReadTokens,
          cacheReadInputTokens: apiCacheReadTokens,
          cacheWriteTokens: apiCacheWriteTokens,
          cacheWriteInputTokens: apiCacheWriteTokens,
        }
      : {}),
  };
}

function stripGatewayTurnLoopNotice(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith(GATEWAY_TURN_LOOP_WARNING_PREFIX) &&
        !trimmed.startsWith(GATEWAY_TURN_LOOP_GUARD_PREFIX)
      );
    })
    .join('\n')
    .trim();
}

function normalizeGatewayTurnLoopText(text: string): string {
  return stripGatewayTurnLoopNotice(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function countConsecutiveMatchingTurns(params: {
  history: StoredMessage[];
  userContent: string;
  resultText: string;
}): number {
  const targetUser = normalizeGatewayTurnLoopText(params.userContent);
  const targetAssistant = normalizeGatewayTurnLoopText(params.resultText);
  if (!targetUser || !targetAssistant) return 1;

  const pairs: Array<{ user: string; assistant: string }> = [];
  const chronologicalHistory = [...params.history].reverse();
  let pendingUser: string | null = null;

  for (const message of chronologicalHistory) {
    if (message.role === 'user') {
      pendingUser = message.content;
      continue;
    }
    if (message.role !== 'assistant' || pendingUser == null) continue;
    pairs.push({
      user: pendingUser,
      assistant: message.content,
    });
    pendingUser = null;
  }

  let count = 1;
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    const pair = pairs[index];
    if (!pair) continue;
    if (
      normalizeGatewayTurnLoopText(pair.user) !== targetUser ||
      normalizeGatewayTurnLoopText(pair.assistant) !== targetAssistant
    ) {
      break;
    }
    count += 1;
  }

  return count;
}

export function isClarificationRequest(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || !normalized.includes('?')) return false;
  if (normalized.length > 700) return false;

  const lower = normalized.toLowerCase();
  const clarificationPatterns = [
    /\bcan you (?:clarify|confirm|provide|share|tell)\b/,
    /\bcould you (?:clarify|confirm|provide|share|tell)\b/,
    /\bplease (?:clarify|confirm|provide|share)\b/,
    /\bto proceed\b/,
    /\bbefore i can\b/,
    /\bi need (?:to know|more|the)\b/,
    /^(what|which|where|when)\b/,
    /\bdo you want me to\b/,
  ];
  if (!clarificationPatterns.some((pattern) => pattern.test(lower))) {
    return false;
  }

  const sentenceCount = normalized
    .split(/[.!?]+/)
    .map((entry) => entry.trim())
    .filter(Boolean).length;
  return sentenceCount <= 3;
}

function firstNumber(values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}
