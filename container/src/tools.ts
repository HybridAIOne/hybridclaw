import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BROWSER_TOOL_DEFINITIONS,
  executeBrowserTool,
  setBrowserModelContext,
} from './browser-tools.js';
import {
  DISCORD_MEDIA_CACHE_ROOT,
  DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
  replaceWorkspaceRootInOutput,
  resolveMediaPath,
  resolveWorkspaceGlobPattern,
  resolveWorkspacePath,
  stripWorkspaceRootPrefix,
  WORKSPACE_ROOT,
  WORKSPACE_ROOT_DISPLAY,
} from './runtime-paths.js';
import type {
  DelegationSideEffect,
  DelegationTaskSpec,
  MediaContextItem,
  ScheduleSideEffect,
  ToolDefinition,
} from './types.js';
import type { WebSearchRuntimeConfig } from './web-search.js';

// --- Exec safety deny-list (defense-in-depth, adapted from PicoClaw) ---

const DENY_PATTERNS: RegExp[] = [
  /\brm\s+-[rf]{1,2}\b/, // rm -r, rm -f, rm -rf
  /(^|[;&|]\s*)mkfs(?:\.[a-z0-9_+-]+)?\b/, // mkfs command at segment start
  /(^|[;&|]\s*)format(?:\.com|\.exe)?\b/, // format command at segment start (Windows)
  /\bdd\s+if=/, // raw disk I/O
  /:\(\)\s*\{.*\};\s*:/, // fork bomb :(){ :|:& };:
  /\|\s*(sh|bash|zsh)\b/, // pipe to shell
  /;\s*rm\s+-[rf]/, // chained rm after semicolon
  /&&\s*rm\s+-[rf]/, // chained rm after &&
  /\|\|\s*rm\s+-[rf]/, // chained rm after ||
  /\bcurl\b.*\|\s*(sh|bash)/, // curl | sh
  /\bwget\b.*\|\s*(sh|bash)/, // wget | sh
  /\beval\b/, // eval execution
  /\bsource\s+.*\.sh\b/, // source shell scripts
  /\bpkill\b/, // process killing
  /\bkillall\b/, // process killing
  /\bkill\s+-9\b/, // force kill
  /\b(shutdown|reboot|poweroff)\b/, // system power control
  />\s*\/dev\/sd[a-z]\b/, // write to block devices
];

function guardCommand(command: string): string | null {
  const lower = command.toLowerCase();
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(lower)) {
      return 'Command blocked by safety guard (dangerous pattern detected)';
    }
  }
  return null;
}

// --- Side-effect accumulator for host-processed actions ---

type ScheduledTaskInfo = {
  id: number;
  cronExpr: string;
  runAt: string | null;
  everyMs: number | null;
  prompt: string;
  enabled: number;
  lastRun: string | null;
  createdAt: string;
};

let pendingSchedules: ScheduleSideEffect[] = [];
let pendingDelegations: DelegationSideEffect[] = [];
let injectedTasks: ScheduledTaskInfo[] = [];
let currentSessionId = '';
let gatewayBaseUrl = '';
let gatewayApiToken = '';
let gatewayChannelId = '';
let currentModelProvider: 'hybridai' | 'openai-codex' = 'hybridai';
let currentModelBaseUrl = '';
let currentModelApiKey = '';
let currentModelName = '';
let currentChatbotId = '';
let currentModelHeaders: Record<string, string> = {};
let currentMediaContext: MediaContextItem[] = [];
let currentWebSearchConfig: WebSearchRuntimeConfig | undefined;
const MAX_PENDING_DELEGATIONS = 3;
const MAX_DELEGATION_BATCH_ITEMS = 6;
const VISION_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const VISION_FETCH_TIMEOUT_MS = 12_000;
const CODEX_VISION_INSTRUCTIONS =
  'You are Codex, a coding assistant. Analyze the provided image and answer the user question using only visible evidence. If text is unreadable or missing, say so.';
const VISION_LOCAL_SCRATCH_ROOTS = Array.from(
  new Set(
    ['/tmp', '/private/tmp', os.tmpdir()].map((entry) => path.resolve(entry)),
  ),
);
const DISCORD_CDN_HOST_PATTERNS: RegExp[] = [
  /^cdn\.discordapp\.com$/i,
  /^media\.discordapp\.net$/i,
  /^cdn\.discordapp\.net$/i,
  /^images-ext-\d+\.discordapp\.net$/i,
];

type DiscordMessageToolAction =
  | 'read'
  | 'member-info'
  | 'channel-info'
  | 'send'
  | 'react'
  | 'quote-reply'
  | 'edit'
  | 'delete'
  | 'pin'
  | 'unpin'
  | 'thread-create'
  | 'thread-reply';

const MESSAGE_TOOL_ACTION_LIST =
  'read, member-info, channel-info, send, react, quote-reply, edit, delete, pin, unpin, thread-create, thread-reply';
const MESSAGE_TOOL_DESCRIPTION_BASE =
  'Send messages, DMs, read channel history, and look up member info in Discord. Use this when asked to send/post/DM/notify someone, read messages, or look up users.';
let gatewayConfiguredChannels: string[] = [];

function normalizeConfiguredChannelList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (!/^\d{16,22}$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function getMessageToolDescription(channelId?: string): string {
  const explicitChannelId = readStringValue(channelId);
  const activeChannelId =
    explicitChannelId || readStringValue(gatewayChannelId);
  const configuredChannels = normalizeConfiguredChannelList(
    gatewayConfiguredChannels,
  );
  const otherChannels = configuredChannels
    .filter((id) => !activeChannelId || id !== activeChannelId)
    .slice(0, 6);
  if (activeChannelId) {
    const withOthers =
      otherChannels.length > 0
        ? ` Other configured channels: ${otherChannels.map((id) => `${id} (${MESSAGE_TOOL_ACTION_LIST})`).join(', ')}.`
        : '';
    return `${MESSAGE_TOOL_DESCRIPTION_BASE} Current channel (${activeChannelId}) supports: ${MESSAGE_TOOL_ACTION_LIST}. Omit channelId/to to target the current channel for read/channel-info/send.${withOthers}`;
  }
  const withOthers =
    configuredChannels.length > 0
      ? ` Configured channels: ${configuredChannels.map((id) => `${id} (${MESSAGE_TOOL_ACTION_LIST})`).join(', ')}.`
      : '';
  return `${MESSAGE_TOOL_DESCRIPTION_BASE} Supports actions: ${MESSAGE_TOOL_ACTION_LIST}.${withOthers}`;
}

export function resetSideEffects(): void {
  pendingSchedules = [];
  pendingDelegations = [];
}

export function getPendingSideEffects():
  | {
      schedules?: ScheduleSideEffect[];
      delegations?: DelegationSideEffect[];
    }
  | undefined {
  if (pendingSchedules.length === 0 && pendingDelegations.length === 0)
    return undefined;
  return {
    schedules: pendingSchedules.length > 0 ? pendingSchedules : undefined,
    delegations: pendingDelegations.length > 0 ? pendingDelegations : undefined,
  };
}

export function setScheduledTasks(
  tasks: ScheduledTaskInfo[] | undefined,
): void {
  injectedTasks = tasks || [];
}

export function setSessionContext(sessionId: string): void {
  currentSessionId = String(sessionId || '');
}

export function setGatewayContext(
  baseUrl?: string,
  apiToken?: string,
  channelId?: string,
  configuredChannels?: string[],
): void {
  gatewayBaseUrl = String(baseUrl || '').trim();
  gatewayApiToken = String(apiToken || '').trim();
  gatewayChannelId = String(channelId || '').trim();
  gatewayConfiguredChannels =
    normalizeConfiguredChannelList(configuredChannels);
}

export function setModelContext(
  provider: 'hybridai' | 'openai-codex' | undefined,
  baseUrl: string,
  apiKey: string,
  model: string,
  chatbotId: string,
  requestHeaders?: Record<string, string>,
): void {
  currentModelProvider = provider || 'hybridai';
  currentModelBaseUrl = String(baseUrl || '').trim();
  currentModelApiKey = String(apiKey || '').trim();
  currentModelName = String(model || '').trim();
  currentChatbotId = String(chatbotId || '').trim();
  currentModelHeaders = { ...(requestHeaders || {}) };
  setBrowserModelContext(
    provider,
    baseUrl,
    apiKey,
    model,
    chatbotId,
    requestHeaders,
  );
}

export function setMediaContext(media?: MediaContextItem[]): void {
  currentMediaContext = Array.isArray(media) ? media : [];
}

export function setWebSearchConfig(config?: WebSearchRuntimeConfig): void {
  currentWebSearchConfig = config
    ? {
        ...config,
        fallbackProviders: [...config.fallbackProviders],
      }
    : undefined;
}

function readStringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPositiveNumberValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolveDiscordMessageAction(
  rawAction: unknown,
): DiscordMessageToolAction | null {
  const normalized = readStringValue(rawAction)?.toLowerCase();
  if (!normalized) return null;
  const compact = normalized.replace(/[\s_-]+/g, '');
  if (
    compact === 'read' ||
    compact === 'readmessages' ||
    compact === 'history' ||
    compact === 'fetch'
  ) {
    return 'read';
  }
  if (compact === 'memberinfo' || compact === 'lookup' || compact === 'whois') {
    return 'member-info';
  }
  if (compact === 'channelinfo') return 'channel-info';
  if (
    compact === 'react' ||
    compact === 'reaction' ||
    compact === 'reactions'
  ) {
    return 'react';
  }
  if (
    compact === 'quotereply' ||
    compact === 'replymessage' ||
    compact === 'replyto'
  ) {
    return 'quote-reply';
  }
  if (compact === 'edit' || compact === 'update') return 'edit';
  if (compact === 'delete' || compact === 'remove') return 'delete';
  if (compact === 'pin') return 'pin';
  if (compact === 'unpin') return 'unpin';
  if (compact === 'threadcreate' || compact === 'createthread') {
    return 'thread-create';
  }
  if (compact === 'threadreply' || compact === 'replythread') {
    return 'thread-reply';
  }
  if (
    compact === 'send' ||
    compact === 'sendmessage' ||
    compact === 'dm' ||
    compact === 'post' ||
    compact === 'reply' ||
    compact === 'respond'
  ) {
    return 'send';
  }
  return null;
}

function normalizeDiscordMessageTarget(value: unknown): string | undefined {
  const raw = readStringValue(value);
  if (!raw) return undefined;
  const withoutProviderPrefix = raw.replace(/^(discord|user):/i, '').trim();
  if (!withoutProviderPrefix) return undefined;
  const userMention = withoutProviderPrefix.match(/^<@!?(\d{16,22})>$/);
  if (userMention) return userMention[1];
  const channelMention = withoutProviderPrefix.match(/^<#(\d{16,22})>$/);
  if (channelMention) return channelMention[1];
  return withoutProviderPrefix;
}

function resolveDiscordMessageChannelTarget(
  args: Record<string, unknown>,
): string {
  const resolved =
    normalizeDiscordMessageTarget(args.channelId) ||
    normalizeDiscordMessageTarget(args.to) ||
    normalizeDiscordMessageTarget(args.target) ||
    normalizeDiscordMessageTarget(gatewayChannelId);
  return resolved || '';
}

function resolveDiscordMessageExplicitChannelTarget(
  args: Record<string, unknown>,
): string {
  const resolved =
    normalizeDiscordMessageTarget(args.channelId) ||
    normalizeDiscordMessageTarget(args.to) ||
    normalizeDiscordMessageTarget(args.target);
  return resolved || '';
}

function resolveDiscordMessageSendUserLookupTarget(
  args: Record<string, unknown>,
): string {
  const resolved =
    normalizeDiscordMessageTarget(args.user) ||
    normalizeDiscordMessageTarget(args.username);
  return resolved || '';
}

function resolveDiscordMessageUserTarget(
  args: Record<string, unknown>,
): string {
  const resolved =
    normalizeDiscordMessageTarget(args.userId) ||
    normalizeDiscordMessageTarget(args.memberId) ||
    normalizeDiscordMessageTarget(args.user) ||
    normalizeDiscordMessageTarget(args.username);
  return resolved || '';
}

function resolveDiscordRequestingUserId(args: Record<string, unknown>): string {
  const resolved =
    normalizeDiscordMessageTarget(args.asUserId) ||
    normalizeDiscordMessageTarget(args.userId);
  return resolved || '';
}

function resolveDiscordGuildId(value: unknown): string {
  const resolved =
    normalizeDiscordMessageTarget(value) || readStringValue(value);
  return resolved || '';
}

function resolveGatewayDiscordActionUrl(): string | null {
  const base = gatewayBaseUrl.replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/api/discord/action`;
}

async function callGatewayDiscordAction(
  payload: Record<string, unknown>,
): Promise<string> {
  const url = resolveGatewayDiscordActionUrl();
  if (!url) {
    return 'Error: Discord actions are unavailable because gatewayBaseUrl is not configured.';
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (gatewayApiToken) {
    headers.Authorization = `Bearer ${gatewayApiToken}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return `Error: Discord action request failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const rawText = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    const maybe = JSON.parse(rawText) as unknown;
    if (maybe && typeof maybe === 'object' && !Array.isArray(maybe)) {
      parsed = maybe as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    if (parsed) {
      const structured: Record<string, unknown> = {
        ok: false,
        status: response.status,
        ...parsed,
      };
      if (
        typeof structured.error !== 'string' ||
        structured.error.trim().length === 0
      ) {
        structured.error = rawText || `HTTP ${response.status}`;
      }
      return JSON.stringify(structured, null, 2);
    }
    return JSON.stringify(
      {
        ok: false,
        status: response.status,
        error: rawText || `HTTP ${response.status}`,
      },
      null,
      2,
    );
  }

  if (parsed) return JSON.stringify(parsed, null, 2);
  return rawText || JSON.stringify({ ok: true }, null, 2);
}

function normalizeDelegationTask(
  raw: unknown,
  fallbackModel?: string,
): DelegationTaskSpec | null {
  if (typeof raw === 'string') {
    const prompt = raw.trim();
    if (!prompt) return null;
    return fallbackModel ? { prompt, model: fallbackModel } : { prompt };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const task = raw as Record<string, unknown>;
  const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : '';
  if (!prompt) return null;

  const label = typeof task.label === 'string' ? task.label.trim() : '';
  const model =
    typeof task.model === 'string' ? task.model.trim() : fallbackModel || '';
  const normalized: DelegationTaskSpec = { prompt };
  if (label) normalized.label = label;
  if (model) normalized.model = model;
  return normalized;
}

function normalizeDelegationTaskList(params: {
  raw: unknown;
  fallbackModel?: string;
  fieldName: 'tasks' | 'chain';
}): { tasks: DelegationTaskSpec[]; error?: string } {
  const { raw, fallbackModel, fieldName } = params;
  if (raw == null) return { tasks: [] };
  if (!Array.isArray(raw)) {
    return {
      tasks: [],
      error: `Error: "${fieldName}" must be an array of task objects.`,
    };
  }
  if (raw.length === 0) {
    return {
      tasks: [],
      error: `Error: "${fieldName}" must contain at least one task.`,
    };
  }
  if (raw.length > MAX_DELEGATION_BATCH_ITEMS) {
    return {
      tasks: [],
      error: `Error: "${fieldName}" exceeds max items (${MAX_DELEGATION_BATCH_ITEMS}).`,
    };
  }

  const tasks: DelegationTaskSpec[] = [];
  for (let i = 0; i < raw.length; i++) {
    const normalized = normalizeDelegationTask(raw[i], fallbackModel);
    if (!normalized) {
      return {
        tasks: [],
        error: `Error: "${fieldName}[${i}]" must include a non-empty "prompt".`,
      };
    }
    tasks.push(normalized);
  }

  return { tasks };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractVisionTextContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.trim()) chunks.push(part.trim());
      continue;
    }
    const obj = asRecord(part);
    if (!obj) continue;
    const text = typeof obj.text === 'string' ? obj.text : '';
    if (text.trim()) chunks.push(text.trim());
  }
  return chunks.join('\n').trim();
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

function normalizeVisionLocalPath(rawPath: string): string | null {
  const normalized = String(rawPath || '').trim();
  if (!normalized) return null;

  const workspacePath = resolveWorkspacePath(normalized);
  if (workspacePath) return workspacePath;

  const mediaPath = resolveMediaPath(normalized);
  if (mediaPath) return mediaPath;

  const resolved = path.resolve(normalized);
  for (const root of VISION_LOCAL_SCRATCH_ROOTS) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      return resolved;
    }
  }

  return null;
}

function isKnownDiscordMediaPath(localPath: string): boolean {
  const knownPaths = currentMediaContext
    .map((entry) => (typeof entry.path === 'string' ? entry.path.trim() : ''))
    .filter(Boolean)
    .map((entryPath) => normalizeVisionLocalPath(entryPath))
    .filter((value): value is string => Boolean(value));
  if (knownPaths.length === 0) return true;
  return knownPaths.includes(localPath);
}

function inferImageMimeTypeFromPath(
  localPath: string,
  fallbackMime?: string | null,
): string {
  const normalizedFallback = String(fallbackMime || '')
    .trim()
    .toLowerCase();
  if (normalizedFallback.startsWith('image/')) return normalizedFallback;
  const ext = path.posix.extname(localPath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  return 'image/png';
}

async function readVisionImageFromLocalPath(
  localPath: string,
): Promise<{ buffer: Buffer; mimeType: string; source: string }> {
  const normalizedPath = normalizeVisionLocalPath(localPath);
  if (!normalizedPath) {
    throw new Error(
      `local image path must be under ${WORKSPACE_ROOT_DISPLAY}, ${DISCORD_MEDIA_CACHE_ROOT_DISPLAY}, or a local temp directory`,
    );
  }
  if (
    normalizedPath.startsWith(`${DISCORD_MEDIA_CACHE_ROOT}/`) &&
    !isKnownDiscordMediaPath(normalizedPath)
  ) {
    throw new Error(
      'requested local image is not part of current media context',
    );
  }
  if (!fs.existsSync(normalizedPath)) {
    throw new Error(`local image not found: ${normalizedPath}`);
  }
  const stat = fs.statSync(normalizedPath);
  if (!stat.isFile()) {
    throw new Error(`local image path is not a file: ${normalizedPath}`);
  }
  if (stat.size <= 0) {
    throw new Error(`local image is empty: ${normalizedPath}`);
  }
  if (stat.size > VISION_IMAGE_MAX_BYTES) {
    throw new Error(
      `local image exceeds max size (${VISION_IMAGE_MAX_BYTES} bytes)`,
    );
  }
  const buffer = fs.readFileSync(normalizedPath);
  const mediaHint = currentMediaContext.find((entry) => {
    const normalizedEntryPath = entry.path
      ? normalizeVisionLocalPath(entry.path)
      : null;
    return normalizedEntryPath === normalizedPath;
  });
  const mimeType = inferImageMimeTypeFromPath(
    normalizedPath,
    mediaHint?.mimeType,
  );
  if (!mimeType.startsWith('image/')) {
    throw new Error(`unsupported local image type: ${mimeType}`);
  }
  return {
    buffer,
    mimeType,
    source: normalizedPath,
  };
}

async function readVisionImageFromUrl(
  rawUrl: string,
): Promise<{ buffer: Buffer; mimeType: string; source: string }> {
  if (!isSafeDiscordCdnUrl(rawUrl)) {
    throw new Error(
      'remote image URL is blocked (only Discord CDN HTTPS URLs are allowed)',
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(rawUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`image download failed (${response.status})`);
    }
    const mimeType = String(response.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!mimeType.startsWith('image/')) {
      throw new Error(`remote URL is not an image (${mimeType || 'unknown'})`);
    }
    const contentLength = Number.parseInt(
      response.headers.get('content-length') || '',
      10,
    );
    if (
      Number.isFinite(contentLength) &&
      contentLength > VISION_IMAGE_MAX_BYTES
    ) {
      throw new Error(
        `remote image exceeds max size (${VISION_IMAGE_MAX_BYTES} bytes)`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > VISION_IMAGE_MAX_BYTES) {
      throw new Error(
        `remote image exceeds max size (${VISION_IMAGE_MAX_BYTES} bytes)`,
      );
    }
    return {
      buffer,
      mimeType,
      source: rawUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}

function visionModelContextError(): string | null {
  if (!currentModelApiKey)
    return 'vision_analyze is not configured: missing API key context.';
  if (!currentModelBaseUrl)
    return 'vision_analyze is not configured: missing base URL context.';
  if (!currentModelName)
    return 'vision_analyze is not configured: missing model context.';
  if (currentModelProvider !== 'openai-codex' && !currentChatbotId)
    return 'vision_analyze is not configured: missing chatbot_id context.';
  return null;
}

function normalizeCodexModelName(model: string): string {
  const trimmed = String(model || '').trim();
  if (!trimmed.toLowerCase().startsWith('openai-codex/')) return trimmed;
  return trimmed.slice('openai-codex/'.length) || trimmed;
}

function buildModelRequestHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${currentModelApiKey}`,
    ...currentModelHeaders,
  };
}

function extractCodexOutputText(payload: Record<string, unknown>): string {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.type !== 'message' || !Array.isArray(record.content)) continue;
    for (const contentItem of record.content) {
      if (
        contentItem &&
        typeof contentItem === 'object' &&
        !Array.isArray(contentItem)
      ) {
        const contentRecord = contentItem as Record<string, unknown>;
        const text =
          typeof contentRecord.text === 'string'
            ? contentRecord.text
            : typeof contentRecord.output_text === 'string'
              ? contentRecord.output_text
              : '';
        if (text) chunks.push(text);
      }
    }
  }
  return chunks.join('\n').trim();
}

async function callVisionModel(
  question: string,
  imageDataUrl: string,
): Promise<{ model: string; analysis: string }> {
  const contextError = visionModelContextError();
  if (contextError) throw new Error(contextError);

  const response = await fetch(
    currentModelProvider === 'openai-codex'
      ? `${currentModelBaseUrl}/responses`
      : `${currentModelBaseUrl}/v1/chat/completions`,
    {
      method: 'POST',
      headers: buildModelRequestHeaders(),
      body: JSON.stringify(
        currentModelProvider === 'openai-codex'
          ? {
              model: normalizeCodexModelName(currentModelName),
              instructions: CODEX_VISION_INSTRUCTIONS,
              input: [
                {
                  role: 'user',
                  content: [
                    { type: 'input_text', text: question },
                    { type: 'input_image', image_url: imageDataUrl },
                  ],
                },
              ],
            }
          : {
              model: currentModelName,
              chatbot_id: currentChatbotId,
              enable_rag: false,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: question },
                    { type: 'image_url', image_url: { url: imageDataUrl } },
                  ],
                },
              ],
            },
      ),
    },
  );

  const rawText = await response.text();
  if (!response.ok) {
    const detail =
      rawText.length > 600 ? `${rawText.slice(0, 600)}...` : rawText;
    throw new Error(
      `vision API request failed (${response.status}): ${detail}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('vision API returned non-JSON response');
  }
  const record = asRecord(parsed);
  const choices = record?.choices;
  if (currentModelProvider === 'openai-codex') {
    if (!record) {
      throw new Error('vision API response did not include a JSON object');
    }
    const analysis = extractCodexOutputText(record);
    if (!analysis) {
      throw new Error('vision API response did not include text output');
    }
    return {
      model: currentModelName,
      analysis,
    };
  }
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('vision API response did not include choices');
  }
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const analysis = extractVisionTextContent(message?.content);
  if (!analysis) {
    throw new Error('vision API returned empty analysis');
  }
  return {
    model: currentModelName,
    analysis,
  };
}

async function runVisionAnalyze(
  args: Record<string, unknown>,
): Promise<string> {
  const question = readStringValue(args.question);
  if (!question) return 'Error: question is required';

  const imageRef =
    readStringValue(args.image_url) ||
    readStringValue(args.imageUrl) ||
    readStringValue(args.path);
  const fallbackUrl =
    readStringValue(args.fallback_url) ||
    readStringValue(args.fallbackUrl) ||
    readStringValue(args.original_url);
  if (!imageRef) return 'Error: image_url is required';

  const candidates = [imageRef, fallbackUrl].filter((value): value is string =>
    Boolean(value),
  );
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const isRemote = /^https?:\/\//i.test(candidate);
      const image = isRemote
        ? await readVisionImageFromUrl(candidate)
        : await readVisionImageFromLocalPath(candidate);
      const dataUrl = `data:${image.mimeType};base64,${image.buffer.toString('base64')}`;
      const vision = await callVisionModel(question, dataUrl);
      return JSON.stringify(
        {
          success: true,
          model: vision.model,
          analysis: vision.analysis,
          source: image.source,
          mime_type: image.mimeType,
          size_bytes: image.buffer.length,
        },
        null,
        2,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      errors.push(`${candidate}: ${detail}`);
    }
  }

  return `Error: vision_analyze failed. ${errors.join(' | ') || 'No candidate image sources succeeded.'}`;
}

const PREVIEW_MAX_OUTPUT_LINES = 6;
const PREVIEW_MAX_LINE_LENGTH = 200;
const BASH_MAX_OUTPUT_LINES = 400;
const BASH_MAX_OUTPUT_BYTES = 128 * 1024;
const BASH_EXEC_DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;
const BASH_EXEC_MIN_TIMEOUT_MS = 1_000;
const BASH_EXEC_MAX_TIMEOUT_MS = 15 * 60 * 1000;
const BASH_EXEC_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 50 * 1024;

function abbreviatePreview(text: string): string {
  const lines = text.split('\n');
  const truncated = lines
    .slice(0, PREVIEW_MAX_OUTPUT_LINES)
    .map((line) =>
      line.length > PREVIEW_MAX_LINE_LENGTH
        ? `${line.slice(0, PREVIEW_MAX_LINE_LENGTH)}...`
        : line,
    );
  if (lines.length > PREVIEW_MAX_OUTPUT_LINES) {
    truncated.push(
      `... (${lines.length - PREVIEW_MAX_OUTPUT_LINES} more lines)`,
    );
  }
  return truncated.join('\n');
}

type ReadTruncationResult = {
  content: string;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  outputLines: number;
  firstLineExceedsLimit: boolean;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncateReadContent(
  content: string,
  maxLines = READ_MAX_LINES,
  maxBytes = READ_MAX_BYTES,
): ReadTruncationResult {
  const lines = content.split('\n');
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      outputLines: lines.length,
      firstLineExceedsLimit: false,
    };
  }

  const firstLine = lines[0] ?? '';
  if (Buffer.byteLength(firstLine, 'utf-8') > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      outputLines: 0,
      firstLineExceedsLimit: true,
    };
  }

  const out: string[] = [];
  let bytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (i > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    out.push(line);
    bytes += lineBytes;
  }

  if (out.length >= maxLines && bytes <= maxBytes) truncatedBy = 'lines';
  return {
    content: out.join('\n'),
    truncated: true,
    truncatedBy,
    outputLines: out.length,
    firstLineExceedsLimit: false,
  };
}

function formatBashOutput(content: string): string {
  const raw = content || '(no output)';
  const totalLines = raw.split('\n').length;
  const truncation = truncateReadContent(
    raw,
    BASH_MAX_OUTPUT_LINES,
    BASH_MAX_OUTPUT_BYTES,
  );
  if (!truncation.truncated) return raw;

  if (truncation.firstLineExceedsLimit) {
    return `[Command output truncated: first line exceeds ${formatBytes(BASH_MAX_OUTPUT_BYTES)}. Consider narrowing command output.]`;
  }

  const shownLines = truncation.outputLines;
  if (truncation.truncatedBy === 'bytes') {
    return `${truncation.content}\n\n[Output truncated at ${formatBytes(BASH_MAX_OUTPUT_BYTES)} after ${shownLines}/${totalLines} lines]`;
  }
  return `${truncation.content}\n\n[Output truncated after ${shownLines}/${totalLines} lines]`;
}

function normalizeTimeoutNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampTimeoutMs(rawMs: number): number {
  const rounded = Math.floor(rawMs);
  if (rounded < BASH_EXEC_MIN_TIMEOUT_MS) return BASH_EXEC_MIN_TIMEOUT_MS;
  if (rounded > BASH_EXEC_MAX_TIMEOUT_MS) return BASH_EXEC_MAX_TIMEOUT_MS;
  return rounded;
}

function resolveBashTimeoutMs(args: Record<string, unknown>): number {
  const timeoutMs = normalizeTimeoutNumber(args.timeoutMs);
  if (timeoutMs != null) return clampTimeoutMs(timeoutMs);

  const timeoutSeconds = normalizeTimeoutNumber(args.timeoutSeconds);
  if (timeoutSeconds != null) return clampTimeoutMs(timeoutSeconds * 1000);

  return BASH_EXEC_DEFAULT_TIMEOUT_MS;
}

function safeJoin(userPath: string): string {
  const resolved = resolveWorkspacePath(userPath);
  if (resolved) return resolved;
  throw new Error(`Path escapes workspace: ${userPath}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globPatternToRegExp(pattern: string): RegExp {
  let regex = '^';

  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index];
    if (ch === '*') {
      const next = pattern[index + 1];
      const afterNext = pattern[index + 2];
      if (next === '*') {
        if (afterNext === '/') {
          regex += '(?:[^/]+/)*';
          index += 2;
          continue;
        }
        regex += '.*';
        index += 1;
        continue;
      }
      regex += '[^/]*';
      continue;
    }
    if (ch === '?') {
      regex += '[^/]';
      continue;
    }
    if (ch === '{') {
      const end = pattern.indexOf('}', index + 1);
      if (end > index) {
        const body = pattern
          .slice(index + 1, end)
          .split(',')
          .map((part) => escapeRegExp(part))
          .join('|');
        regex += `(?:${body})`;
        index = end;
        continue;
      }
    }
    regex += escapeRegExp(ch);
  }

  regex += '$';
  return new RegExp(regex);
}

const MEMORY_ROOT_FILES = new Set(['MEMORY.md', 'USER.md']);
const DAILY_MEMORY_FILE_RE = /^memory\/\d{4}-\d{2}-\d{2}\.md$/;
const ROOT_MEMORY_CHAR_LIMITS: Record<string, number> = {
  'MEMORY.md': 12_000,
  'USER.md': 8_000,
};
const DAILY_MEMORY_CHAR_LIMIT = 24_000;

function normalizeDateStamp(input: string): string | null {
  const trimmed = input.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function currentDateStamp(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (year && month && day) return `${year}-${month}-${day}`;
  return new Date().toISOString().slice(0, 10);
}

function normalizeMemoryFilePath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return null;
  const normalized = rawPath.trim().replace(/\\/g, '/');
  const workspaceRelative = stripWorkspaceRootPrefix(normalized).replace(
    /^\.?\//,
    '',
  );
  const sanitized = workspaceRelative || normalized;
  if (MEMORY_ROOT_FILES.has(sanitized)) return sanitized;
  if (DAILY_MEMORY_FILE_RE.test(sanitized)) return sanitized;
  return null;
}

function resolveMemoryFilePath(args: Record<string, unknown>): string | null {
  const direct =
    normalizeMemoryFilePath(args.file_path) ||
    normalizeMemoryFilePath(args.path);
  if (direct) return direct;

  const target =
    typeof args.target === 'string' ? args.target.trim().toLowerCase() : '';
  if (target === 'memory') return 'MEMORY.md';
  if (target === 'user') return 'USER.md';
  if (target === 'daily') {
    const date =
      typeof args.date === 'string' ? normalizeDateStamp(args.date) : null;
    return `memory/${date || currentDateStamp()}.md`;
  }

  return 'MEMORY.md';
}

function listMemoryFiles(): string[] {
  const files: string[] = [];
  for (const rootFile of MEMORY_ROOT_FILES) {
    const abs = safeJoin(rootFile);
    if (fs.existsSync(abs)) files.push(rootFile);
  }

  const dailyDir = safeJoin('memory');
  if (fs.existsSync(dailyDir)) {
    for (const entry of fs.readdirSync(dailyDir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(entry)) continue;
      files.push(`memory/${entry}`);
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function memoryCharLimit(relativePath: string): number {
  return ROOT_MEMORY_CHAR_LIMITS[relativePath] || DAILY_MEMORY_CHAR_LIMIT;
}

interface TranscriptRow {
  sessionId: string;
  channelId?: string;
  role: string;
  userId?: string;
  username?: string | null;
  content: string;
  createdAt?: string;
}

type SessionSearchCandidate = {
  sessionId: string;
  filePath: string;
  rows: TranscriptRow[];
  matchIndexes: number[];
  score: number;
  mtimeMs: number;
};

const SESSION_TRANSCRIPTS_DIR = '.session-transcripts';
const SESSION_SEARCH_MAX_FILES = 300;
const SESSION_SEARCH_MAX_RESULTS = 5;
const SESSION_SEARCH_MAX_ROWS_PER_SESSION = 2_000;
const SESSION_SEARCH_SNIPPET_CONTEXT = 1;
const SESSION_SEARCH_MAX_SNIPPETS = 8;

function parseRoleFilter(value: unknown): Set<string> | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const roles = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return roles.length > 0 ? new Set(roles) : null;
}

function truncateInline(text: string, max = 240): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}...`;
}

function collectTranscriptRows(filePath: string): TranscriptRow[] {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const parsed: TranscriptRow[] = [];
  const lines = raw.split('\n').filter(Boolean);
  const start = Math.max(0, lines.length - SESSION_SEARCH_MAX_ROWS_PER_SESSION);
  for (let i = start; i < lines.length; i++) {
    try {
      const row = JSON.parse(lines[i]) as Partial<TranscriptRow>;
      if (
        typeof row.sessionId !== 'string' ||
        typeof row.role !== 'string' ||
        typeof row.content !== 'string'
      ) {
        continue;
      }
      parsed.push({
        sessionId: row.sessionId,
        channelId:
          typeof row.channelId === 'string' ? row.channelId : undefined,
        role: row.role,
        userId: typeof row.userId === 'string' ? row.userId : undefined,
        username: row.username == null ? null : String(row.username),
        content: row.content,
        createdAt:
          typeof row.createdAt === 'string' ? row.createdAt : undefined,
      });
    } catch {
      // Skip malformed row
    }
  }
  return parsed;
}

function scoreTranscript(
  rows: TranscriptRow[],
  query: string,
  roleFilter: Set<string> | null,
): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
  if (terms.length === 0) terms.push(query.toLowerCase());

  let score = 0;
  for (const row of rows) {
    const role = row.role.toLowerCase();
    if (roleFilter && !roleFilter.has(role)) continue;
    const haystack = row.content.toLowerCase();
    if (haystack.includes(query.toLowerCase())) score += 6;
    for (const term of terms) {
      if (haystack.includes(term)) score += 2;
    }
  }
  return score;
}

function findMatchIndexes(
  rows: TranscriptRow[],
  query: string,
  roleFilter: Set<string> | null,
): number[] {
  const lower = query.toLowerCase();
  const terms = lower
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
  if (terms.length === 0) terms.push(lower);

  const indexes: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const role = rows[i].role.toLowerCase();
    if (roleFilter && !roleFilter.has(role)) continue;
    const content = rows[i].content.toLowerCase();
    if (
      content.includes(lower) ||
      terms.some((term) => content.includes(term))
    ) {
      indexes.push(i);
    }
  }
  return indexes;
}

function summarizeSessionCandidate(
  candidate: SessionSearchCandidate,
  query: string,
): Record<string, unknown> {
  const rows = candidate.rows;
  const snippets: string[] = [];
  const seenIndexes = new Set<number>();

  for (const idx of candidate.matchIndexes) {
    const from = Math.max(0, idx - SESSION_SEARCH_SNIPPET_CONTEXT);
    const to = Math.min(rows.length - 1, idx + SESSION_SEARCH_SNIPPET_CONTEXT);
    for (let i = from; i <= to; i++) {
      if (seenIndexes.has(i)) continue;
      seenIndexes.add(i);
      const line = `[${rows[i].role.toUpperCase()}] ${truncateInline(rows[i].content)}`;
      snippets.push(line);
      if (snippets.length >= SESSION_SEARCH_MAX_SNIPPETS) break;
    }
    if (snippets.length >= SESSION_SEARCH_MAX_SNIPPETS) break;
  }

  const userMatches: string[] = [];
  const assistantMatches: string[] = [];
  for (const idx of candidate.matchIndexes) {
    const row = rows[idx];
    const role = row.role.toLowerCase();
    if (role === 'user' && userMatches.length < 2) {
      userMatches.push(truncateInline(row.content));
    } else if (role === 'assistant' && assistantMatches.length < 2) {
      assistantMatches.push(truncateInline(row.content));
    }
  }

  const firstTs =
    rows.find((row) => typeof row.createdAt === 'string')?.createdAt || null;
  const lastTs =
    [...rows].reverse().find((row) => typeof row.createdAt === 'string')
      ?.createdAt || null;
  const summaryParts = [
    `Matched ${candidate.matchIndexes.length} turn(s) for "${query}".`,
    userMatches.length > 0 ? `User focus: ${userMatches.join(' | ')}` : '',
    assistantMatches.length > 0
      ? `Assistant outcomes: ${assistantMatches.join(' | ')}`
      : '',
  ].filter(Boolean);

  return {
    session_id: candidate.sessionId,
    match_count: candidate.matchIndexes.length,
    first_message_at: firstTs,
    last_message_at: lastTs,
    summary: summaryParts.join(' '),
    snippets,
  };
}

export async function executeTool(
  name: string,
  argsJson: string,
): Promise<string> {
  try {
    const args = JSON.parse(argsJson);

    switch (name) {
      case 'read': {
        if (typeof args.path !== 'string' || args.path.trim() === '') {
          return 'Error: path is required';
        }
        const filePath = safeJoin(args.path);
        if (!fs.existsSync(filePath))
          return `Error: File not found: ${args.path}`;
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const totalFileLines = lines.length;

        const rawOffset =
          typeof args.offset === 'number' && Number.isFinite(args.offset)
            ? args.offset
            : 1;
        const startLine = Math.max(1, Math.floor(rawOffset));
        if (startLine > totalFileLines) {
          return `Error: Offset ${startLine} is beyond end of file (${totalFileLines} lines total)`;
        }

        const rawLimit =
          typeof args.limit === 'number' &&
          Number.isFinite(args.limit) &&
          args.limit > 0
            ? Math.floor(args.limit)
            : undefined;

        let selected = lines.slice(startLine - 1);
        let userLimitedLines: number | undefined;
        if (rawLimit !== undefined) {
          selected = selected.slice(0, rawLimit);
          userLimitedLines = selected.length;
        }

        const selectedContent = selected.join('\n');
        const truncation = truncateReadContent(selectedContent);
        if (truncation.firstLineExceedsLimit) {
          const firstSelectedLine = selected[0] ?? '';
          const firstLineSize = formatBytes(
            Buffer.byteLength(firstSelectedLine, 'utf-8'),
          );
          return `[Line ${startLine} is ${firstLineSize}, exceeds ${formatBytes(READ_MAX_BYTES)} limit. Use bash: sed -n '${startLine}p' ${args.path} | head -c ${READ_MAX_BYTES}]`;
        }

        if (truncation.truncated) {
          const endLine = startLine + truncation.outputLines - 1;
          const nextOffset = endLine + 1;
          if (truncation.truncatedBy === 'lines') {
            return `${truncation.content}\n\n[Showing lines ${startLine}-${endLine} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
          }
          return `${truncation.content}\n\n[Showing lines ${startLine}-${endLine} of ${totalFileLines} (${formatBytes(READ_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
        }

        if (userLimitedLines !== undefined) {
          const linesFromStart = startLine - 1 + userLimitedLines;
          if (linesFromStart < totalFileLines) {
            const remaining = totalFileLines - linesFromStart;
            const nextOffset = startLine + userLimitedLines;
            return `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
          }
        }

        return truncation.content;
      }

      case 'write': {
        const filePath = safeJoin(args.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, args.contents);
        return `Wrote ${args.contents.length} bytes to ${args.path}`;
      }

      case 'edit': {
        const filePath = safeJoin(args.path);
        if (!fs.existsSync(filePath))
          return `Error: File not found: ${args.path}`;
        let content = fs.readFileSync(filePath, 'utf-8');
        const count = args.count || 1;
        for (let i = 0; i < count; i++) {
          const idx = content.indexOf(args.old);
          if (idx === -1) {
            if (i === 0) return `Error: Text not found in ${args.path}`;
            break;
          }
          content =
            content.slice(0, idx) +
            args.new +
            content.slice(idx + args.old.length);
        }
        fs.writeFileSync(filePath, content);
        return `Edited ${args.path} (${count} replacement${count > 1 ? 's' : ''})`;
      }

      case 'delete': {
        const filePath = safeJoin(args.path);
        if (!fs.existsSync(filePath))
          return `Error: File not found: ${args.path}`;
        fs.unlinkSync(filePath);
        return `Deleted ${args.path}`;
      }

      case 'glob': {
        const pattern = String(args.pattern || '').trim();
        try {
          const normalizedWorkspacePattern =
            resolveWorkspaceGlobPattern(pattern);
          if (!normalizedWorkspacePattern) {
            return 'Error: glob only searches inside the workspace or configured external bind mounts. For other absolute paths, use bash.';
          }
          const matcher = globPatternToRegExp(
            normalizedWorkspacePattern.replace(/\\/g, '/'),
          );
          const cmd = `find "${WORKSPACE_ROOT.replace(/"/g, '\\"')}" -type f 2>/dev/null | head -5000`;
          const result = execSync(cmd, { timeout: 10000, encoding: 'utf-8' });
          if (!result.trim()) return 'No files found.';
          const files = result
            .trim()
            .split('\n')
            .map((filePath) => filePath.trim())
            .filter(Boolean)
            .filter((filePath) => matcher.test(filePath.replace(/\\/g, '/')))
            .slice(0, 50)
            .map((filePath) => replaceWorkspaceRootInOutput(filePath));
          if (files.length === 0) return 'No files found.';
          return abbreviatePreview(files.join('\n'));
        } catch {
          return 'No files found.';
        }
      }

      case 'grep': {
        const searchPath = args.path ? safeJoin(args.path) : WORKSPACE_ROOT;
        try {
          const cmd = `rg --no-heading --line-number "${args.pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -30`;
          const result = execSync(cmd, { timeout: 10000, encoding: 'utf-8' });
          if (!result.trim()) return 'No matches found.';
          // Convert absolute paths to relative
          return abbreviatePreview(replaceWorkspaceRootInOutput(result));
        } catch {
          return 'No matches found.';
        }
      }

      case 'bash': {
        const blocked = guardCommand(args.command);
        if (blocked) return blocked;
        const timeoutMs = resolveBashTimeoutMs(args);
        try {
          // Strip secrets from subprocess environment (belt-and-suspenders)
          const cleanEnv = { ...process.env };
          delete cleanEnv.HYBRIDAI_API_KEY;
          const result = execSync(args.command, {
            timeout: timeoutMs,
            encoding: 'utf-8',
            cwd: WORKSPACE_ROOT,
            maxBuffer: BASH_EXEC_MAX_BUFFER_BYTES,
            env: cleanEnv,
          });
          return formatBashOutput(
            replaceWorkspaceRootInOutput(result || '(no output)'),
          );
        } catch (err: unknown) {
          const execErr = err as {
            code?: string | number;
            signal?: string;
            stdout?: string | Buffer;
            stderr?: string | Buffer;
            message?: string;
          };

          const stdout =
            typeof execErr.stdout === 'string'
              ? execErr.stdout
              : Buffer.isBuffer(execErr.stdout)
                ? execErr.stdout.toString('utf-8')
                : '';
          const stderr =
            typeof execErr.stderr === 'string'
              ? execErr.stderr
              : Buffer.isBuffer(execErr.stderr)
                ? execErr.stderr.toString('utf-8')
                : '';
          const combinedOutput = [stdout, stderr]
            .filter(Boolean)
            .join('\n')
            .trim();

          const errorMessage = execErr.message || 'Command failed';
          const timeoutLikely =
            execErr.code === 'ETIMEDOUT' ||
            /ETIMEDOUT|timed out/i.test(errorMessage) ||
            (execErr.signal === 'SIGTERM' && /spawnSync/i.test(errorMessage));
          const summary = timeoutLikely
            ? `Command timed out after ${timeoutMs}ms`
            : errorMessage;

          if (!combinedOutput) return `Error: ${summary}`;
          return `Error: ${summary}\n\n${formatBashOutput(replaceWorkspaceRootInOutput(combinedOutput))}`;
        }
      }

      case 'memory': {
        const action =
          typeof args.action === 'string'
            ? args.action.trim().toLowerCase()
            : 'read';
        const relativePath = resolveMemoryFilePath(args);
        if (!relativePath) {
          return 'Error: memory file_path must be MEMORY.md, USER.md, or memory/YYYY-MM-DD.md';
        }

        const filePath = safeJoin(relativePath);
        if (action === 'list') {
          const files = listMemoryFiles();
          if (files.length === 0) {
            return 'No memory files found yet. Use action="append" with MEMORY.md or memory/YYYY-MM-DD.md.';
          }
          return files.join('\n');
        }

        if (action === 'search') {
          const query =
            typeof args.query === 'string'
              ? args.query.trim().toLowerCase()
              : '';
          if (!query) return 'Error: query is required for memory search';
          const files = listMemoryFiles();
          const matches: string[] = [];
          for (const rel of files) {
            const abs = safeJoin(rel);
            let lines: string[] = [];
            try {
              lines = fs.readFileSync(abs, 'utf-8').split('\n');
            } catch {
              continue;
            }
            for (let i = 0; i < lines.length; i++) {
              if (!lines[i].toLowerCase().includes(query)) continue;
              const trimmed = lines[i].trim();
              matches.push(`${rel}:${i + 1}: ${trimmed}`);
              if (matches.length >= 40) break;
            }
            if (matches.length >= 40) break;
          }
          return matches.length > 0
            ? matches.join('\n')
            : `No memory matches for "${query}".`;
        }

        if (action === 'read') {
          if (!fs.existsSync(filePath)) {
            return `${relativePath}\n\n(empty)`;
          }
          const content = fs.readFileSync(filePath, 'utf-8');
          return `${relativePath}\n\n${content || '(empty)'}`;
        }

        if (action === 'append') {
          const content =
            typeof args.content === 'string' ? args.content.trim() : '';
          if (!content) return 'Error: content is required for memory append';

          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          const existing = fs.existsSync(filePath)
            ? fs.readFileSync(filePath, 'utf-8')
            : '';
          let next = existing.replace(/\s+$/, '');
          if (next.length > 0) next += '\n\n';
          next += `${content}\n`;
          const limit = memoryCharLimit(relativePath);
          if (next.length > limit) {
            return `Error: ${relativePath} would exceed ${limit} chars. Shorten content or remove older entries first.`;
          }
          fs.writeFileSync(filePath, next, 'utf-8');
          return `Appended ${content.length} chars to ${relativePath}`;
        }

        if (action === 'write') {
          const content = typeof args.content === 'string' ? args.content : '';
          const limit = memoryCharLimit(relativePath);
          if (content.length > limit) {
            return `Error: ${relativePath} exceeds ${limit} char limit.`;
          }
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content, 'utf-8');
          return `Wrote ${content.length} chars to ${relativePath}`;
        }

        if (action === 'replace') {
          const oldText =
            typeof args.old_text === 'string' ? args.old_text : '';
          const newText =
            typeof args.new_text === 'string' ? args.new_text : '';
          if (!oldText) return 'Error: old_text is required for memory replace';
          if (!fs.existsSync(filePath))
            return `Error: File not found: ${relativePath}`;
          const content = fs.readFileSync(filePath, 'utf-8');
          if (!content.includes(oldText))
            return `Error: old_text not found in ${relativePath}`;
          const next = content.replace(oldText, newText);
          const limit = memoryCharLimit(relativePath);
          if (next.length > limit) {
            return `Error: replacement would exceed ${limit} chars for ${relativePath}.`;
          }
          fs.writeFileSync(filePath, next, 'utf-8');
          return `Updated ${relativePath}`;
        }

        if (action === 'remove') {
          const oldText =
            typeof args.old_text === 'string' ? args.old_text : '';
          if (!oldText) return 'Error: old_text is required for memory remove';
          if (!fs.existsSync(filePath))
            return `Error: File not found: ${relativePath}`;
          const content = fs.readFileSync(filePath, 'utf-8');
          if (!content.includes(oldText))
            return `Error: old_text not found in ${relativePath}`;
          fs.writeFileSync(filePath, content.replace(oldText, ''), 'utf-8');
          return `Removed matching text from ${relativePath}`;
        }

        return `Error: unknown memory action "${action}". Use read, append, write, replace, remove, list, or search.`;
      }

      case 'message': {
        const action = resolveDiscordMessageAction(args.action);
        if (!action) {
          return 'Error: unsupported message action. Use "read", "member-info", "channel-info", "send", "react", "quote-reply", "edit", "delete", "pin", "unpin", "thread-create", or "thread-reply".';
        }

        const payload: Record<string, unknown> = { action };
        const resolveAmbiguousRaw = readStringValue(args.resolveAmbiguous);
        const resolveAmbiguous =
          resolveAmbiguousRaw &&
          (resolveAmbiguousRaw.toLowerCase() === 'best' ||
            resolveAmbiguousRaw.toLowerCase() === 'error')
            ? resolveAmbiguousRaw.toLowerCase()
            : undefined;
        const messageId = normalizeDiscordMessageTarget(args.messageId);
        const emoji = readStringValue(args.emoji);
        const threadName = readStringValue(args.name);
        const autoArchiveDuration =
          typeof args.autoArchiveDuration === 'number' &&
          Number.isFinite(args.autoArchiveDuration)
            ? Math.max(60, Math.floor(args.autoArchiveDuration))
            : undefined;

        if (action === 'read') {
          const channelId = resolveDiscordMessageChannelTarget(args);
          if (!channelId) {
            return 'Error: channelId is required for message action "read".';
          }
          payload.channelId = channelId;

          if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
            payload.limit = Math.max(1, Math.min(100, Math.floor(args.limit)));
          }
          const before = readStringValue(args.before);
          const after = readStringValue(args.after);
          const around = readStringValue(args.around);
          if (before) payload.before = before;
          if (after) payload.after = after;
          if (around) payload.around = around;
        }

        if (action === 'member-info') {
          const guildId = resolveDiscordGuildId(args.guildId);
          const userId = resolveDiscordMessageUserTarget(args);
          if (!guildId) {
            return 'Error: guildId is required for message action "member-info".';
          }
          if (!userId) {
            return 'Error: userId/username is required for message action "member-info".';
          }
          payload.guildId = guildId;
          payload.userId = userId;
          if (resolveAmbiguous) payload.resolveAmbiguous = resolveAmbiguous;
        }

        if (action === 'channel-info') {
          const channelId = resolveDiscordMessageChannelTarget(args);
          if (!channelId) {
            return 'Error: channelId is required for message action "channel-info".';
          }
          payload.channelId = channelId;
        }

        if (action === 'send') {
          const explicitChannelId =
            resolveDiscordMessageExplicitChannelTarget(args);
          const userLookupTarget =
            resolveDiscordMessageSendUserLookupTarget(args);
          const fallbackChannelId = userLookupTarget
            ? ''
            : normalizeDiscordMessageTarget(gatewayChannelId);
          const channelId = explicitChannelId || fallbackChannelId;
          if (!channelId && !userLookupTarget) {
            return 'Error: channelId is required for message action "send" unless user/username is provided.';
          }
          const content =
            readStringValue(args.content) ||
            readStringValue(args.text) ||
            readStringValue(args.message);
          const components =
            Array.isArray(args.components) ||
            (args.components &&
              typeof args.components === 'object' &&
              !Array.isArray(args.components))
              ? args.components
              : undefined;
          if (!content && components === undefined) {
            return 'Error: content is required for message action "send" unless components is provided.';
          }
          if (channelId) payload.channelId = channelId;
          if (userLookupTarget) payload.user = userLookupTarget;
          if (content) payload.content = content;
          if (components !== undefined) payload.components = components;

          const requestingUserId = resolveDiscordRequestingUserId(args);
          const guildId = resolveDiscordGuildId(args.guildId);
          const contextChannelId =
            normalizeDiscordMessageTarget(gatewayChannelId);
          if (requestingUserId) payload.userId = requestingUserId;
          if (guildId) payload.guildId = guildId;
          if (contextChannelId) payload.contextChannelId = contextChannelId;
          if (resolveAmbiguous) payload.resolveAmbiguous = resolveAmbiguous;
        }

        if (action === 'react') {
          const channelId = resolveDiscordMessageChannelTarget(args);
          if (!channelId) {
            return 'Error: channelId is required for message action "react".';
          }
          if (!messageId) {
            return 'Error: messageId is required for message action "react".';
          }
          if (!emoji) {
            return 'Error: emoji is required for message action "react".';
          }
          payload.channelId = channelId;
          payload.messageId = messageId;
          payload.emoji = emoji;
        }

        if (action === 'quote-reply') {
          const channelId = resolveDiscordMessageChannelTarget(args);
          if (!channelId) {
            return 'Error: channelId is required for message action "quote-reply".';
          }
          if (!messageId) {
            return 'Error: messageId is required for message action "quote-reply".';
          }
          const content =
            readStringValue(args.content) ||
            readStringValue(args.text) ||
            readStringValue(args.message);
          if (!content) {
            return 'Error: content is required for message action "quote-reply".';
          }
          payload.channelId = channelId;
          payload.messageId = messageId;
          payload.content = content;
          const requestingUserId = resolveDiscordRequestingUserId(args);
          const guildId = resolveDiscordGuildId(args.guildId);
          if (requestingUserId) payload.userId = requestingUserId;
          if (guildId) payload.guildId = guildId;
        }

        if (
          action === 'edit' ||
          action === 'delete' ||
          action === 'pin' ||
          action === 'unpin' ||
          action === 'thread-create'
        ) {
          const channelId = resolveDiscordMessageChannelTarget(args);
          if (!channelId) {
            return `Error: channelId is required for message action "${action}".`;
          }
          if (!messageId) {
            return `Error: messageId is required for message action "${action}".`;
          }
          payload.channelId = channelId;
          payload.messageId = messageId;

          if (action === 'edit') {
            const content =
              readStringValue(args.content) ||
              readStringValue(args.text) ||
              readStringValue(args.message);
            if (!content) {
              return 'Error: content is required for message action "edit".';
            }
            payload.content = content;
          }

          if (action === 'thread-create') {
            if (!threadName) {
              return 'Error: name is required for message action "thread-create".';
            }
            payload.name = threadName;
            if (autoArchiveDuration) {
              payload.autoArchiveDuration = autoArchiveDuration;
            }
          }
        }

        if (action === 'thread-reply') {
          const channelId = resolveDiscordMessageChannelTarget(args);
          if (!channelId) {
            return 'Error: channelId is required for message action "thread-reply".';
          }
          const content =
            readStringValue(args.content) ||
            readStringValue(args.text) ||
            readStringValue(args.message);
          if (!content) {
            return 'Error: content is required for message action "thread-reply".';
          }
          payload.channelId = channelId;
          payload.content = content;
          const requestingUserId = resolveDiscordRequestingUserId(args);
          const guildId = resolveDiscordGuildId(args.guildId);
          if (requestingUserId) payload.userId = requestingUserId;
          if (guildId) payload.guildId = guildId;
        }

        return await callGatewayDiscordAction(payload);
      }

      case 'session_search': {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return 'Error: query is required for session_search';

        const requestedLimit =
          typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? Math.floor(args.limit)
            : 3;
        const limit = Math.max(
          1,
          Math.min(requestedLimit, SESSION_SEARCH_MAX_RESULTS),
        );
        const includeCurrent = args.include_current === true;
        const roleFilter = parseRoleFilter(args.role_filter);

        const transcriptDir = safeJoin(SESSION_TRANSCRIPTS_DIR);
        if (!fs.existsSync(transcriptDir)) {
          return JSON.stringify(
            {
              success: true,
              query,
              count: 0,
              results: [],
              message: 'No historical transcripts found yet.',
            },
            null,
            2,
          );
        }

        const files = fs
          .readdirSync(transcriptDir)
          .filter((name) => name.endsWith('.jsonl'))
          .slice(0, SESSION_SEARCH_MAX_FILES);

        const candidates: SessionSearchCandidate[] = [];
        for (const filename of files) {
          const filePath = path.join(transcriptDir, filename);
          const rows = collectTranscriptRows(filePath);
          if (rows.length === 0) continue;

          const sessionId =
            rows[0].sessionId || filename.replace(/\.jsonl$/, '');
          if (
            !includeCurrent &&
            currentSessionId &&
            sessionId === currentSessionId
          )
            continue;

          const matchIndexes = findMatchIndexes(rows, query, roleFilter);
          if (matchIndexes.length === 0) continue;

          const stat = fs.statSync(filePath);
          const score = scoreTranscript(rows, query, roleFilter);
          candidates.push({
            sessionId,
            filePath,
            rows,
            matchIndexes,
            score,
            mtimeMs: stat.mtimeMs,
          });
        }

        candidates.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return b.mtimeMs - a.mtimeMs;
        });

        const top = candidates.slice(0, limit);
        const results = top.map((candidate) =>
          summarizeSessionCandidate(candidate, query),
        );

        return JSON.stringify(
          {
            success: true,
            query,
            count: results.length,
            sessions_searched: candidates.length,
            results,
          },
          null,
          2,
        );
      }

      case 'web_fetch': {
        const { webFetch } = await import('./web-fetch.js');
        const result = await webFetch({
          url: args.url,
          extractMode: args.extractMode,
          maxChars: args.maxChars,
        });
        const header = result.title ? `# ${result.title}\n\n` : '';
        const meta = `[${result.extractor}] ${result.finalUrl} (${result.status}, ${result.tookMs}ms)`;
        const lines = [meta];
        if (result.escalationHint) {
          lines.push(
            `Escalation hint: ${result.escalationHint} (retry with browser_navigate for this URL).`,
          );
        }
        if (result.warning) {
          lines.push(`Warning: ${result.warning}`);
        }
        return `${lines.join('\n')}\n\n${header}${result.text}`;
      }

      case 'web_search': {
        const { webSearch } = await import('./web-search.js');
        return await webSearch(
          {
            query: args.query,
            count: args.count,
            freshness: args.freshness,
            country: args.country,
            language: args.language,
            provider: args.provider,
          },
          currentWebSearchConfig,
        );
      }

      case 'vision_analyze':
      case 'image': {
        return await runVisionAnalyze(args);
      }

      case 'browser_navigate':
      case 'browser_snapshot':
      case 'browser_click':
      case 'browser_type':
      case 'browser_upload':
      case 'browser_press':
      case 'browser_scroll':
      case 'browser_back':
      case 'browser_screenshot':
      case 'browser_pdf':
      case 'browser_vision':
      case 'browser_get_images':
      case 'browser_console':
      case 'browser_network':
      case 'browser_close': {
        return await executeBrowserTool(
          name,
          args,
          currentSessionId || 'default',
        );
      }

      case 'cron': {
        const action = args.action;

        if (action === 'list') {
          if (injectedTasks.length === 0) return 'No scheduled tasks.';
          const lines = injectedTasks.map((t) => {
            let schedule: string;
            if (t.runAt) schedule = `at ${t.runAt}`;
            else if (t.everyMs) {
              const secs = t.everyMs / 1000;
              if (secs < 120) schedule = `every ${secs}s`;
              else if (secs < 7200)
                schedule = `every ${Math.round(secs / 60)}m`;
              else schedule = `every ${Math.round(secs / 3600)}h`;
            } else schedule = t.cronExpr;
            const status = t.enabled ? 'enabled' : 'disabled';
            return `#${t.id} [${status}] ${schedule} — ${t.prompt}`;
          });
          return lines.join('\n');
        }

        if (action === 'add') {
          const promptInput =
            readStringValue(args.prompt) ||
            readStringValue(args.message) ||
            readStringValue(args.text);
          if (!promptInput) return 'Error: prompt is required';
          const prompt = promptInput;
          const atSeconds = readPositiveNumberValue(
            args.at_seconds ?? args.atSeconds,
          );
          const relativeDelayMs =
            atSeconds != null ? Math.round(atSeconds * 1000) : null;
          const rawAt = readStringValue(args.at);

          if (rawAt || relativeDelayMs != null) {
            const runAt =
              relativeDelayMs != null
                ? new Date(Date.now() + relativeDelayMs)
                : new Date(rawAt || '');
            if (Number.isNaN(runAt.getTime()))
              return `Error: invalid ISO-8601 timestamp: ${rawAt}`;
            if (runAt.getTime() <= Date.now())
              return `Error: timestamp must be in the future: ${rawAt || runAt.toISOString()}`;
            pendingSchedules.push({
              action: 'add',
              runAt: runAt.toISOString(),
              prompt,
            });
            return `Scheduled one-shot task at ${runAt.toISOString()}: ${prompt}`;
          }

          if (args.cron) {
            pendingSchedules.push({
              action: 'add',
              cronExpr: args.cron,
              prompt,
            });
            return `Scheduled recurring task with cron "${args.cron}": ${prompt}`;
          }

          if (args.every) {
            const secs = Number(args.every);
            if (Number.isNaN(secs) || secs < 10)
              return 'Error: "every" must be a number of seconds >= 10';
            const everyMs = Math.round(secs * 1000);
            pendingSchedules.push({
              action: 'add',
              everyMs,
              prompt,
            });
            return `Scheduled interval task every ${secs}s: ${prompt}`;
          }

          return 'Error: provide "at" (ISO-8601 timestamp), "at_seconds" (one-shot seconds from now), "cron" (cron expression), or "every" (seconds)';
        }

        if (action === 'remove') {
          if (!args.taskId) return 'Error: taskId is required';
          pendingSchedules.push({ action: 'remove', taskId: args.taskId });
          return `Scheduled removal of task #${args.taskId}`;
        }

        return `Error: unknown cron action "${action}". Use "list", "add", or "remove".`;
      }

      case 'delegate': {
        if (pendingDelegations.length >= MAX_PENDING_DELEGATIONS) {
          return `Error: delegation limit reached for this turn (${MAX_PENDING_DELEGATIONS}).`;
        }

        const modeRaw =
          typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : '';
        if (
          modeRaw &&
          modeRaw !== 'single' &&
          modeRaw !== 'parallel' &&
          modeRaw !== 'chain'
        ) {
          return 'Error: mode must be one of "single", "parallel", or "chain".';
        }

        const label = typeof args.label === 'string' ? args.label.trim() : '';
        const model = typeof args.model === 'string' ? args.model.trim() : '';
        const prompt =
          typeof args.prompt === 'string' ? args.prompt.trim() : '';
        const tasksResult = normalizeDelegationTaskList({
          raw: args.tasks,
          fallbackModel: model || undefined,
          fieldName: 'tasks',
        });
        if (tasksResult.error) return tasksResult.error;
        const chainResult = normalizeDelegationTaskList({
          raw: args.chain,
          fallbackModel: model || undefined,
          fieldName: 'chain',
        });
        if (chainResult.error) return chainResult.error;

        const hasPrompt = prompt.length > 0;
        const hasTasks = tasksResult.tasks.length > 0;
        const hasChain = chainResult.tasks.length > 0;

        let mode: 'single' | 'parallel' | 'chain';
        if (modeRaw) {
          mode = modeRaw;
        } else if (hasChain) {
          mode = 'chain';
        } else if (hasTasks) {
          mode = 'parallel';
        } else {
          mode = 'single';
        }

        if (
          (hasTasks ? 1 : 0) + (hasChain ? 1 : 0) + (hasPrompt ? 1 : 0) > 1 &&
          !modeRaw
        ) {
          return 'Error: provide one delegation mode payload: "prompt", "tasks", or "chain".';
        }

        let effect: DelegationSideEffect;
        let summary: string;

        if (mode === 'single') {
          if (!hasPrompt) return 'Error: prompt is required for mode="single".';
          effect = {
            action: 'delegate',
            mode,
            prompt,
            label: label || undefined,
            model: model || undefined,
          };
          summary = label ? `${label}: ${prompt}` : prompt;
        } else if (mode === 'parallel') {
          if (!hasTasks)
            return 'Error: tasks are required for mode="parallel".';
          if (hasPrompt || hasChain)
            return 'Error: mode="parallel" accepts only "tasks" plus optional label/model.';
          effect = {
            action: 'delegate',
            mode,
            label: label || undefined,
            model: model || undefined,
            tasks: tasksResult.tasks,
          };
          summary = `${tasksResult.tasks.length} parallel task(s)`;
        } else {
          if (!hasChain) return 'Error: chain is required for mode="chain".';
          if (hasPrompt || hasTasks)
            return 'Error: mode="chain" accepts only "chain" plus optional label/model.';
          effect = {
            action: 'delegate',
            mode,
            label: label || undefined,
            model: model || undefined,
            chain: chainResult.tasks,
          };
          summary = `${chainResult.tasks.length}-step chain`;
        }

        pendingDelegations.push(effect);
        const labelPrefix = label ? `${label}: ` : '';
        return `Delegation accepted (${mode}, auto-announces on completion, do not poll): ${labelPrefix}${summary}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read',
      description:
        'Read a file and return its contents. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to read' },
          offset: {
            type: 'number',
            description:
              'Line number to start reading from (1-indexed, default: 1)',
          },
          limit: {
            type: 'number',
            description:
              'Maximum number of lines to read before truncation logic (optional)',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description:
        'Write contents to a file on disk, overwriting if it exists. Use this for creating new code/program files instead of shell heredocs or code-only replies.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to write' },
          contents: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'contents'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description:
        'Replace text in a file using old/new strings. Use this for file edits instead of shell-based editing (sed/awk/perl in bash).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to edit' },
          old: { type: 'string', description: 'Text to find and replace' },
          new: { type: 'string', description: 'Replacement text' },
          count: {
            type: 'number',
            description: 'Number of replacements (default: 1)',
          },
        },
        required: ['path', 'old', 'new'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete',
      description: 'Delete a file from the workspace',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to delete' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'List files matching a glob pattern inside the workspace only. For absolute paths outside the workspace, use bash instead.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description:
              'Glob pattern to match files inside the workspace (relative paths preferred)',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for a regex pattern in files',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regex pattern to search for',
          },
          path: {
            type: 'string',
            description:
              'Directory or file to search in (default: workspace root)',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command and return stdout/stderr. The shell starts in the workspace root; use relative workspace paths instead of literal /workspace paths. Use bash for absolute paths outside the workspace, and prefer /tmp for temporary scratch files. Do not use for file creation or file editing; use write/edit tools for file authoring.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          timeoutMs: {
            type: 'number',
            description:
              'Optional command timeout in milliseconds (default 240000, max 900000)',
          },
          timeoutSeconds: {
            type: 'number',
            description:
              'Optional command timeout in seconds (used when timeoutMs is omitted)',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory',
      description:
        'Manage durable agent memory files. Supports MEMORY.md, USER.md, and daily files at memory/YYYY-MM-DD.md. Actions: read, append, write, replace, remove, list, search. Memory files are char-bounded to prevent unbounded growth. Use this proactively for durable facts/preferences; do not wait to be explicitly asked to remember important context.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description:
              'Action: "read", "append", "write", "replace", "remove", "list", or "search"',
          },
          file_path: {
            type: 'string',
            description:
              'Target file path. Allowed: MEMORY.md, USER.md, memory/YYYY-MM-DD.md',
          },
          target: {
            type: 'string',
            description:
              'Optional shorthand target: "memory", "user", or "daily"',
          },
          date: {
            type: 'string',
            description:
              'Date for target="daily" in YYYY-MM-DD format (defaults to today)',
          },
          content: {
            type: 'string',
            description: 'Text payload for append/write',
          },
          old_text: {
            type: 'string',
            description: 'Existing substring for replace/remove',
          },
          new_text: {
            type: 'string',
            description: 'Replacement text for replace',
          },
          query: {
            type: 'string',
            description: 'Case-insensitive query string for search',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'message',
      description: getMessageToolDescription(),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description:
              'Action to perform: "read", "member-info", "channel-info", "send", "react", "quote-reply", "edit", "delete", "pin", "unpin", "thread-create", or "thread-reply".',
            enum: [
              'read',
              'member-info',
              'channel-info',
              'send',
              'react',
              'quote-reply',
              'edit',
              'delete',
              'pin',
              'unpin',
              'thread-create',
              'thread-reply',
            ],
          },
          channelId: {
            type: 'string',
            description:
              'Discord channel ID (snowflake). Defaults to current channel.',
          },
          guildId: {
            type: 'string',
            description:
              'Discord guild id (required for member-info; optional for send).',
          },
          userId: {
            type: 'string',
            description:
              'Discord user id (required for member-info; optional requester id for send allowlist checks).',
          },
          memberId: {
            type: 'string',
            description: 'Alias for userId in member-info.',
          },
          username: {
            type: 'string',
            description:
              'Discord username/display name/@handle to resolve for member-info, or as DM target for send when channelId/to/target is omitted.',
          },
          user: {
            type: 'string',
            description:
              'Alias for username/userId in member-info; for send, used as DM target when channelId/to/target is omitted.',
          },
          resolveAmbiguous: {
            type: 'string',
            description:
              'Ambiguity policy for member lookups in action="member-info" and user-target sends: "error" (default) returns candidates, "best" auto-picks top score.',
            enum: ['error', 'best'],
          },
          limit: {
            type: 'number',
            description: 'Read limit for action="read" (default 20, max 100).',
          },
          before: {
            type: 'string',
            description: 'Read messages before this message id.',
          },
          after: {
            type: 'string',
            description: 'Read messages after this message id.',
          },
          around: {
            type: 'string',
            description: 'Read messages around this message id.',
          },
          content: {
            type: 'string',
            description: 'Message text payload (required for action="send").',
          },
          components: {
            type: ['object', 'array'],
            items: {
              type: 'object',
            },
            description:
              'Optional Discord components payload for action="send" (buttons/selects/action rows).',
          },
          text: {
            type: 'string',
            description: 'Alias for content in action="send".',
          },
          message: {
            type: 'string',
            description: 'Alias for content in action="send".',
          },
          asUserId: {
            type: 'string',
            description:
              'Requester user id for send allowlist checks (alias for userId).',
          },
          contextChannelId: {
            type: 'string',
            description:
              'Context Discord channel id used to infer guild for user-target sends.',
          },
          messageId: {
            type: 'string',
            description:
              'Discord message id for actions: react, quote-reply, edit, delete, pin, unpin, thread-create.',
          },
          emoji: {
            type: 'string',
            description: 'Emoji payload for action="react".',
          },
          name: {
            type: 'string',
            description: 'Thread name for action="thread-create".',
          },
          autoArchiveDuration: {
            type: 'number',
            description:
              'Optional thread auto-archive duration in minutes for action="thread-create".',
          },
          target: {
            type: 'string',
            description:
              'Target user or channel. Accepts: Discord channel ID, user ID, @username, #channel-name, or display name.',
          },
          to: {
            type: 'string',
            description:
              'Target user or channel. Accepts: Discord channel ID, user ID, @username, #channel-name, or display name.',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'session_search',
      description:
        'Search and summarize historical session transcripts. Returns top matching sessions with concise summaries and key snippets. Use proactively when prior context might be relevant.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query over prior session transcripts',
          },
          limit: {
            type: 'number',
            description:
              'Maximum number of sessions to summarize (default 3, max 5)',
          },
          role_filter: {
            type: 'string',
            description:
              'Optional comma-separated roles to match (e.g. "user,assistant")',
          },
          include_current: {
            type: 'boolean',
            description:
              'Include the current session in results (default false)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch a URL via plain HTTP GET and extract readable content (HTML to markdown/text). No JavaScript execution, no clicks, no form interaction. Use for static read-only retrieval: articles, docs, wikis, READMEs, API JSON/text endpoints, and direct files/PDFs. Avoid for SPAs (React/Vue/Angular/Next client routes), auth/login-gated pages, dashboards/web apps, bot/challenge flows, or content loaded after render via XHR/fetch. Cost: typically ~10-100x cheaper/faster than browser tools. Default to web_fetch for read-only retrieval, then escalate to browser_navigate when output is empty/boilerplate, JavaScript-required, SPA shell-only, or bot-blocked.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTP or HTTPS URL to fetch' },
          extractMode: {
            type: 'string',
            description: 'Extraction mode: "markdown" (default) or "text"',
          },
          maxChars: {
            type: 'number',
            description:
              'Maximum characters to return (default 50000, max 50000)',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for current information. Returns titles, URLs, and snippets. Use before web_fetch to discover relevant URLs. Providers: auto (default), brave, perplexity, tavily, duckduckgo, searxng.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query string.',
          },
          count: {
            type: 'number',
            description: 'Number of results (1-10, default 5).',
          },
          freshness: {
            type: 'string',
            description: 'Time filter: "day", "week", "month", "year".',
          },
          country: {
            type: 'string',
            description: '2-letter country code (e.g. "US", "DE").',
          },
          language: {
            type: 'string',
            description: 'ISO 639-1 language code (e.g. "en", "de").',
          },
          provider: {
            type: 'string',
            description:
              'Override provider: auto, brave, perplexity, tavily, duckduckgo, searxng.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vision_analyze',
      description:
        'Analyze an image attachment using vision. Use for Discord-uploaded files (local /discord-media-cache paths first, Discord CDN URLs as fallback).',
      parameters: {
        type: 'object',
        properties: {
          image_url: {
            type: 'string',
            description:
              'Local image path (preferred) or Discord CDN HTTPS URL.',
          },
          question: {
            type: 'string',
            description: 'Question to ask about the image.',
          },
          fallback_url: {
            type: 'string',
            description:
              'Optional fallback Discord CDN URL if image_url cannot be read.',
          },
          original_url: {
            type: 'string',
            description: 'Optional original URL alias for fallback_url.',
          },
        },
        required: ['image_url', 'question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'image',
      description: 'Alias of vision_analyze for image analysis.',
      parameters: {
        type: 'object',
        properties: {
          image_url: {
            type: 'string',
            description:
              'Local image path (preferred) or Discord CDN HTTPS URL.',
          },
          question: {
            type: 'string',
            description: 'Question to ask about the image.',
          },
          fallback_url: {
            type: 'string',
            description:
              'Optional fallback Discord CDN URL if image_url cannot be read.',
          },
          original_url: {
            type: 'string',
            description: 'Optional original URL alias for fallback_url.',
          },
        },
        required: ['image_url', 'question'],
      },
    },
  },
  ...BROWSER_TOOL_DEFINITIONS,
  {
    type: 'function',
    function: {
      name: 'delegate',
      description:
        'Delegate narrow, self-contained subtasks to background subagents. Use for reasoning-heavy/context-heavy work or independent parallel branches; avoid for trivial single tool calls. Modes: single (`prompt`), parallel (`tasks[]`), chain (`chain[]` with `{previous}`). Never forward the user prompt verbatim. Provide self-contained task context (goal, paths, constraints, expected output). Completion is push-delivered automatically; do not poll/sleep.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            description:
              'Optional explicit mode: "single", "parallel", or "chain". Inferred automatically when omitted.',
            enum: ['single', 'parallel', 'chain'],
          },
          prompt: {
            type: 'string',
            description:
              'Single-mode task instructions. Must be self-contained and specific.',
          },
          label: {
            type: 'string',
            description: 'Optional short label for completion messages',
          },
          model: {
            type: 'string',
            description: 'Optional model override for delegated run(s)',
          },
          tasks: {
            type: 'array',
            description:
              'Parallel-mode independent tasks (1-6 items). Each task must be self-contained.',
            minItems: 1,
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description:
                    'Task instructions with explicit goal/scope/constraints.',
                },
                label: { type: 'string', description: 'Optional task label' },
                model: {
                  type: 'string',
                  description: 'Optional per-task model override',
                },
              },
              required: ['prompt'],
            },
          },
          chain: {
            type: 'array',
            description:
              'Chain-mode dependent steps (1-6 items). Use `{previous}` to inject prior step output.',
            minItems: 1,
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description:
                    'Step instructions (supports `{previous}`) with expected output.',
                },
                label: { type: 'string', description: 'Optional step label' },
                model: {
                  type: 'string',
                  description: 'Optional per-step model override',
                },
              },
              required: ['prompt'],
            },
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cron',
      description:
        'Manage scheduled tasks and reminders. Actions:\n' +
        '- "list": show all scheduled tasks\n' +
        '- "add": create a task. Provide execution instruction in "prompt" (or aliases "message"/"text"), plus one schedule field: "at" (ISO-8601 one-shot), "at_seconds" (one-shot seconds from now), "cron" (recurring cron expression), or "every" (recurring interval seconds)\n' +
        '- "remove": delete a task by taskId\n' +
        'The "prompt" is what the model will receive when the task fires. Use an explicit instruction (not the original user sentence).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'Action to perform: "list", "add", or "remove"',
          },
          prompt: {
            type: 'string',
            description:
              'Instruction the model should execute when task fires (required for "add")',
          },
          at: {
            type: 'string',
            description:
              'ISO-8601 timestamp for one-shot schedule (e.g. "2025-01-15T14:30:00Z")',
          },
          at_seconds: {
            type: 'number',
            description:
              'One-shot schedule as seconds from now (e.g. 600 for 10 minutes from now)',
          },
          cron: {
            type: 'string',
            description:
              'Cron expression for recurring schedule (e.g. "0 9 * * *")',
          },
          every: {
            type: 'number',
            description:
              'Interval in seconds for simple recurring schedule (minimum 10)',
          },
          taskId: {
            type: 'number',
            description: 'Task ID to remove (required for "remove")',
          },
        },
        required: ['action'],
      },
    },
  },
];
