import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BROWSER_TOOL_DEFINITIONS,
  executeBrowserTool,
  setBrowserModelContext,
  setBrowserTaskModelPolicies,
} from './browser-tools.js';
import { isSafeDiscordCdnUrl } from './discord-cdn.js';
import type { McpClientManager } from './mcp/client-manager.js';
import { callAuxiliaryModel } from './providers/auxiliary.js';
import {
  DISCORD_MEDIA_CACHE_ROOT,
  DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
  replaceWorkspaceRootInOutput,
  resolveMediaPath,
  resolveWorkspacePath,
  stripWorkspaceRootPrefix,
  WORKSPACE_ROOT,
  WORKSPACE_ROOT_DISPLAY,
} from './runtime-paths.js';
import {
  runGlobSearch,
  runGrepSearch,
  SEARCH_TOOL_DEFINITIONS,
} from './tools/search-tools.js';
import {
  type DelegationSideEffect,
  type DelegationTaskSpec,
  type MediaContextItem,
  type PluginRuntimeToolDefinition,
  type ScheduleSideEffect,
  TASK_MODEL_KEYS,
  type TaskModelKey,
  type TaskModelPolicies,
  type ToolDefinition,
  type ToolRunResult,
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
let currentModelProvider:
  | 'hybridai'
  | 'openai-codex'
  | 'openrouter'
  | 'mistral'
  | 'huggingface'
  | 'ollama'
  | 'lmstudio'
  | 'vllm' = 'hybridai';
let currentModelBaseUrl = '';
let currentModelApiKey = '';
let currentModelName = '';
let currentChatbotId = '';
let currentModelHeaders: Record<string, string> = {};
let currentMediaContext: MediaContextItem[] = [];
let currentWebSearchConfig: WebSearchRuntimeConfig | undefined;
let currentTaskModelPolicies: TaskModelPolicies | undefined;
let mcpClientManager: McpClientManager | null = null;
let pluginTools: PluginRuntimeToolDefinition[] = [];
const MAX_PENDING_DELEGATIONS = 3;
const MAX_DELEGATION_BATCH_ITEMS = 6;
const VISION_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const VISION_FETCH_TIMEOUT_MS = 12_000;
const VISION_LOCAL_SCRATCH_ROOTS = Array.from(
  new Set(
    ['/tmp', '/private/tmp', os.tmpdir()].map((entry) => path.resolve(entry)),
  ),
);

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

class ToolExecutionFailure extends Error {
  readonly output: string;

  constructor(output: string) {
    super(output);
    this.name = 'ToolExecutionFailure';
    this.output = output;
  }
}

function failTool(output: string): never {
  throw new ToolExecutionFailure(output);
}

function parseStructuredToolOutput(
  output: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const MESSAGE_TOOL_ACTION_LIST =
  'read, member-info, channel-info, send, react, quote-reply, edit, delete, pin, unpin, thread-create, thread-reply';
const MESSAGE_TOOL_DESCRIPTION_BASE =
  'Send messages and uploads across supported channels (Discord, current Microsoft Teams chat, WhatsApp, email, local TUI), plus read Discord channel history, read ingested email thread history, and look up member info on Discord. Use this when asked to send/post/DM/notify someone, post a local file/image, read Discord messages or ingested email threads, or look up Discord users.';
let gatewayConfiguredChannels: string[] = [];
const DISCORD_SNOWFLAKE_RE = /^\d{16,22}$/;
const TEAMS_SESSION_ID_RE = /^teams:/i;

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

function resolveGatewayDiscordChannelFallback(): string {
  const normalized = normalizeDiscordMessageTarget(gatewayChannelId);
  if (!normalized || !DISCORD_SNOWFLAKE_RE.test(normalized)) return '';
  return normalized;
}

function resolveGatewayMSTeamsChannelFallback(): string {
  if (!TEAMS_SESSION_ID_RE.test(currentSessionId)) return '';
  return readStringValue(gatewayChannelId) || '';
}

function resolveGatewayMessageSendChannelFallback(): string {
  return (
    resolveGatewayDiscordChannelFallback() ||
    resolveGatewayMSTeamsChannelFallback()
  );
}

export function getMessageToolDescription(channelId?: string): string {
  const explicitChannelId = normalizeDiscordMessageTarget(channelId);
  const activeChannelId =
    explicitChannelId && DISCORD_SNOWFLAKE_RE.test(explicitChannelId)
      ? explicitChannelId
      : resolveGatewayDiscordChannelFallback();
  const activeTeamsChannelId = resolveGatewayMSTeamsChannelFallback();
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
    return `${MESSAGE_TOOL_DESCRIPTION_BASE} Current Discord channel (${activeChannelId}) supports: ${MESSAGE_TOOL_ACTION_LIST}. Omit channelId/to to target the current Discord channel for read/channel-info/send.${withOthers}`;
  }
  if (activeTeamsChannelId) {
    return `${MESSAGE_TOOL_DESCRIPTION_BASE} Current Teams conversation (${activeTeamsChannelId}) supports: send. Omit channelId/to to target the current Teams conversation for send, including local file uploads. Discord-only actions such as read/member-info/channel-info still require explicit Discord targets.`;
  }
  const withOthers =
    configuredChannels.length > 0
      ? ` Configured channels: ${configuredChannels.map((id) => `${id} (${MESSAGE_TOOL_ACTION_LIST})`).join(', ')}.`
      : '';
  return `${MESSAGE_TOOL_DESCRIPTION_BASE} Supports actions: ${MESSAGE_TOOL_ACTION_LIST}.${withOthers}`;
}

function cloneTaskModelPolicies(
  taskModels?: TaskModelPolicies,
): TaskModelPolicies | undefined {
  const cloned: TaskModelPolicies = {};
  for (const key of TASK_MODEL_KEYS) {
    const taskModel = taskModels?.[key];
    if (!taskModel) continue;
    cloned[key] = {
      ...taskModel,
      requestHeaders: taskModel.requestHeaders
        ? { ...taskModel.requestHeaders }
        : undefined,
    };
  }
  return Object.keys(cloned).length > 0 ? cloned : undefined;
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
  provider:
    | 'hybridai'
    | 'openai-codex'
    | 'openrouter'
    | 'mistral'
    | 'huggingface'
    | 'ollama'
    | 'lmstudio'
    | 'vllm'
    | undefined,
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

export function setTaskModelPolicies(taskModels?: TaskModelPolicies): void {
  currentTaskModelPolicies = cloneTaskModelPolicies(taskModels);
  setBrowserTaskModelPolicies(currentTaskModelPolicies);
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

export function setMcpClientManager(manager: McpClientManager | null): void {
  mcpClientManager = manager;
}

export function setPluginTools(tools?: PluginRuntimeToolDefinition[]): void {
  pluginTools = Array.isArray(tools)
    ? tools.map((tool) => ({
        ...tool,
        parameters: {
          type: 'object',
          properties: { ...(tool.parameters?.properties || {}) },
          required: Array.isArray(tool.parameters?.required)
            ? [...tool.parameters.required]
            : [],
        },
      }))
    : [];
}

export function getPluginToolDefinitions(): ToolDefinition[] {
  return pluginTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: { ...(tool.parameters.properties || {}) },
        required: [...tool.parameters.required],
      },
    },
  }));
}

function getPluginToolDefinition(
  name: string,
): PluginRuntimeToolDefinition | undefined {
  return pluginTools.find((tool) => tool.name === name);
}

function readStringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Duplicated on purpose instead of importing the gateway helper. The container
// runtime is packaged independently and should keep its input normalization
// self-contained at the sandbox boundary.
function readStringListValue(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry) => readStringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length > 0 ? normalized : undefined;
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
    resolveGatewayDiscordChannelFallback();
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

function resolveGatewayMessageActionUrl(): string | null {
  const base = gatewayBaseUrl.replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/api/message/action`;
}

function resolveGatewayPluginToolUrl(): string | null {
  const base = gatewayBaseUrl.replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/api/plugin/tool`;
}

function resolveGatewayHttpRequestUrl(): string | null {
  const base = gatewayBaseUrl.replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/api/http/request`;
}

async function callGatewayMessageAction(
  payload: Record<string, unknown>,
): Promise<string> {
  const url = resolveGatewayMessageActionUrl();
  if (!url) {
    return failTool(
      'Error: message actions are unavailable because gatewayBaseUrl is not configured.',
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (gatewayApiToken) {
    headers.Authorization = `Bearer ${gatewayApiToken}`;
  }

  let response: Response;
  const requestPayload = { ...payload };
  if (
    currentSessionId &&
    typeof requestPayload.sessionId !== 'string' &&
    !Array.isArray(requestPayload.sessionId)
  ) {
    requestPayload.sessionId = currentSessionId;
  }
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestPayload),
    });
  } catch (err) {
    return failTool(
      `Error: message action request failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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
      return failTool(JSON.stringify(structured, null, 2));
    }
    return failTool(
      JSON.stringify(
        {
          ok: false,
          status: response.status,
          error: rawText || `HTTP ${response.status}`,
        },
        null,
        2,
      ),
    );
  }

  if (parsed) return JSON.stringify(parsed, null, 2);
  return rawText || JSON.stringify({ ok: true }, null, 2);
}

async function callGatewayPluginTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const url = resolveGatewayPluginToolUrl();
  if (!url) {
    return failTool(
      'Error: plugin tools are unavailable because gatewayBaseUrl is not configured.',
    );
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
      body: JSON.stringify({
        toolName: name,
        args,
        sessionId: currentSessionId,
        channelId: gatewayChannelId,
      }),
    });
  } catch (err) {
    return failTool(
      `Error: plugin tool request failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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
    const errorText =
      parsed && typeof parsed.error === 'string'
        ? parsed.error
        : rawText || `Plugin tool ${name} failed.`;
    return failTool(errorText);
  }

  if (parsed) {
    const result = parsed.result ?? parsed.output;
    if (typeof result === 'string') return result;
    if (result != null) return JSON.stringify(result, null, 2);
  }
  return rawText;
}

async function callGatewayHttpRequest(
  args: Record<string, unknown>,
): Promise<string> {
  const url = resolveGatewayHttpRequestUrl();
  if (!url) {
    return failTool(
      'Error: http_request is unavailable because gatewayBaseUrl is not configured.',
    );
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
      body: JSON.stringify(args),
    });
  } catch (err) {
    return failTool(
      `Error: http_request dispatch failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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
    const errorText =
      parsed && typeof parsed.error === 'string'
        ? parsed.error
        : rawText || `HTTP ${response.status}`;
    return failTool(`Error: ${errorText}`);
  }

  if (parsed) return JSON.stringify(parsed, null, 2);
  return rawText;
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
      `local image path must be under ${WORKSPACE_ROOT_DISPLAY}, ${DISCORD_MEDIA_CACHE_ROOT_DISPLAY}, /uploaded-media-cache, or a local temp directory`,
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

async function callVisionModel(
  runtimeContext: AuxiliaryRuntimeContext,
  question: string,
  imageDataUrl: string,
): Promise<{ model: string; analysis: string }> {
  const vision = await callAuxiliaryModel({
    task: 'vision',
    taskModels: runtimeContext.taskModels,
    fallbackContext: runtimeContext.fallbackContext,
    question,
    imageDataUrl,
    toolName: 'vision_analyze',
  });
  return {
    model: vision.model,
    analysis: vision.analysis,
  };
}

async function runVisionAnalyze(
  args: Record<string, unknown>,
  runtimeContext: AuxiliaryRuntimeContext,
): Promise<string> {
  const question = readStringValue(args.question);
  if (!question) return failTool('Error: question is required');

  const imageRef =
    readStringValue(args.image_url) ||
    readStringValue(args.imageUrl) ||
    readStringValue(args.path);
  const fallbackUrl =
    readStringValue(args.fallback_url) ||
    readStringValue(args.fallbackUrl) ||
    readStringValue(args.original_url);
  if (!imageRef) return failTool('Error: image_url is required');

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
      const vision = await callVisionModel(runtimeContext, question, dataUrl);
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

  return failTool(
    `Error: vision_analyze failed. ${errors.join(' | ') || 'No candidate image sources succeeded.'}`,
  );
}

const BASH_MAX_OUTPUT_LINES = 400;
const BASH_MAX_OUTPUT_BYTES = 128 * 1024;
const BASH_EXEC_DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;
const BASH_EXEC_MIN_TIMEOUT_MS = 1_000;
const BASH_EXEC_MAX_TIMEOUT_MS = 15 * 60 * 1000;
const BASH_EXEC_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 50 * 1024;
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
const SESSION_SEARCH_MAX_LLM_CONTEXT_CHARS = 16_000;
const SESSION_SEARCH_LLM_MAX_TOKENS = 1_200;
const WEB_EXTRACT_CHUNK_CHARS = 12_000;
const WEB_EXTRACT_MAX_SYNTHESIS_CHARS = 40_000;
const WEB_EXTRACT_LLM_MAX_TOKENS = 2_000;

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

function currentAuxiliaryFallbackContext() {
  return {
    provider: currentModelProvider,
    baseUrl: currentModelBaseUrl,
    apiKey: currentModelApiKey,
    model: currentModelName,
    chatbotId: currentChatbotId,
    requestHeaders: { ...currentModelHeaders },
  };
}

type AuxiliaryRuntimeContext = {
  fallbackContext: ReturnType<typeof currentAuxiliaryFallbackContext>;
  taskModels?: TaskModelPolicies;
};

function captureAuxiliaryRuntimeContext(): AuxiliaryRuntimeContext {
  return {
    fallbackContext: currentAuxiliaryFallbackContext(),
    taskModels: cloneTaskModelPolicies(currentTaskModelPolicies),
  };
}

async function callTextAuxiliaryTask(params: {
  runtimeContext: AuxiliaryRuntimeContext;
  task: Exclude<TaskModelKey, 'vision'>;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
  }>;
  maxTokens?: number;
  toolName: string;
}): Promise<string> {
  const response = await callAuxiliaryModel({
    task: params.task,
    taskModels: params.runtimeContext.taskModels,
    fallbackContext: params.runtimeContext.fallbackContext,
    messages: params.messages,
    maxTokens: params.maxTokens,
    toolName: params.toolName,
  });
  return response.content;
}

function buildSessionSearchContext(
  candidate: SessionSearchCandidate,
  maxChars = SESSION_SEARCH_MAX_LLM_CONTEXT_CHARS,
): string {
  const seen = new Set<number>();
  const lines: string[] = [];
  let usedChars = 0;

  for (const idx of candidate.matchIndexes) {
    const from = Math.max(0, idx - SESSION_SEARCH_SNIPPET_CONTEXT - 1);
    const to = Math.min(
      candidate.rows.length - 1,
      idx + SESSION_SEARCH_SNIPPET_CONTEXT + 1,
    );
    for (let i = from; i <= to; i += 1) {
      if (seen.has(i)) continue;
      seen.add(i);
      const row = candidate.rows[i];
      const username = row.username?.trim()
        ? ` username=${JSON.stringify(row.username)}`
        : '';
      const createdAt = row.createdAt ? ` created_at=${row.createdAt}` : '';
      const entry = [
        '---',
        `role=${row.role}${createdAt}${username}`,
        row.content.trim() || '(empty)',
      ].join('\n');
      if (usedChars + entry.length + 2 > maxChars) {
        return lines.join('\n\n');
      }
      lines.push(entry);
      usedChars += entry.length + 2;
    }
  }

  return lines.join('\n\n');
}

async function summarizeSessionCandidateWithAuxiliary(
  runtimeContext: AuxiliaryRuntimeContext,
  candidate: SessionSearchCandidate,
  query: string,
): Promise<string | null> {
  const transcript = buildSessionSearchContext(candidate);
  if (!transcript) return null;

  const summary = await callTextAuxiliaryTask({
    runtimeContext,
    task: 'session_search',
    toolName: 'session_search',
    maxTokens: SESSION_SEARCH_LLM_MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content:
          'You are reviewing a past conversation transcript to help recall what happened. Summarize the conversation with focus on the search topic. Include what the user wanted, what actions were taken, important files/commands/URLs/errors, the outcome, and anything unresolved. Be concise but specific.',
      },
      {
        role: 'user',
        content: [
          `Search topic: ${query}`,
          `Session ID: ${candidate.sessionId}`,
          '',
          'Conversation excerpt:',
          transcript,
        ].join('\n'),
      },
    ],
  });
  const normalized = String(summary || '').trim();
  return normalized || null;
}

function splitTextIntoChunks(text: string, maxChars: number): string[] {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = '';
  };

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (!current) {
      current = trimmed;
      continue;
    }
    if (current.length + trimmed.length + 2 <= maxChars) {
      current = `${current}\n\n${trimmed}`;
      continue;
    }
    pushCurrent();
    if (trimmed.length <= maxChars) {
      current = trimmed;
      continue;
    }
    for (let start = 0; start < trimmed.length; start += maxChars) {
      chunks.push(trimmed.slice(start, start + maxChars).trim());
    }
  }

  pushCurrent();
  return chunks;
}

async function processWebExtractWithAuxiliary(params: {
  runtimeContext: AuxiliaryRuntimeContext;
  url: string;
  title?: string;
  extractedText: string;
  maxOutputChars: number;
}): Promise<string> {
  const contextPrefix = params.title
    ? `Title: ${params.title}\nURL: ${params.url}`
    : `URL: ${params.url}`;
  const chunks = splitTextIntoChunks(
    params.extractedText,
    WEB_EXTRACT_CHUNK_CHARS,
  );

  const summarizeChunk = async (
    chunk: string,
    index: number,
    total: number,
  ): Promise<string> =>
    await callTextAuxiliaryTask({
      runtimeContext: params.runtimeContext,
      task: 'web_extract',
      toolName: 'web_extract',
      maxTokens: WEB_EXTRACT_LLM_MAX_TOKENS,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert content analyst. Create a comprehensive but concise markdown summary that preserves important facts, code snippets, commands, URLs, and actionable details while reducing bulk.',
        },
        {
          role: 'user',
          content: [
            contextPrefix,
            total > 1 ? `Chunk ${index + 1} of ${total}` : '',
            '',
            'Content to summarize:',
            chunk,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });

  if (chunks.length === 1) {
    return (await summarizeChunk(chunks[0], 0, 1)).slice(
      0,
      params.maxOutputChars,
    );
  }

  const summaries: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const summary = await summarizeChunk(chunks[index], index, chunks.length);
    if (summary.trim()) {
      summaries.push(`## Section ${index + 1}\n${summary.trim()}`);
    }
  }
  if (summaries.length === 0) {
    throw new Error('web_extract returned no chunk summaries');
  }
  if (summaries.length === 1) {
    return summaries[0].slice(0, params.maxOutputChars);
  }

  const synthesized = await callTextAuxiliaryTask({
    runtimeContext: params.runtimeContext,
    task: 'web_extract',
    toolName: 'web_extract',
    maxTokens: WEB_EXTRACT_LLM_MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content:
          'You combine section summaries into one cohesive markdown summary. Remove redundancy, preserve key facts and details, and keep the result scannable.',
      },
      {
        role: 'user',
        content: [
          contextPrefix,
          '',
          `Combine these section summaries into one markdown summary under ${Math.min(params.maxOutputChars, WEB_EXTRACT_MAX_SYNTHESIS_CHARS)} characters:`,
          summaries.join('\n\n---\n\n'),
        ].join('\n'),
      },
    ],
  });
  return synthesized.slice(0, params.maxOutputChars);
}

async function executeToolInternal(
  name: string,
  argsJson: string,
): Promise<string> {
  const args = JSON.parse(argsJson);
  const auxiliaryRuntimeContext = captureAuxiliaryRuntimeContext();

  if (mcpClientManager?.isKnownTool(name)) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return failTool('Error: MCP tool arguments must be a JSON object');
    }
    const result = await mcpClientManager.callToolDetailed(
      name,
      args as Record<string, unknown>,
    );
    if (result.isError) {
      return failTool(result.output);
    }
    return result.output;
  }

  if (getPluginToolDefinition(name)) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return failTool('Error: plugin tool arguments must be a JSON object');
    }
    return callGatewayPluginTool(name, args as Record<string, unknown>);
  }

  switch (name) {
    case 'read': {
      if (typeof args.path !== 'string' || args.path.trim() === '') {
        return failTool('Error: path is required');
      }
      const filePath = safeJoin(args.path);
      if (!fs.existsSync(filePath))
        return failTool(`Error: File not found: ${args.path}`);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const totalFileLines = lines.length;

      const rawOffset =
        typeof args.offset === 'number' && Number.isFinite(args.offset)
          ? args.offset
          : 1;
      const startLine = Math.max(1, Math.floor(rawOffset));
      if (startLine > totalFileLines) {
        return failTool(
          `Error: Offset ${startLine} is beyond end of file (${totalFileLines} lines total)`,
        );
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
        return failTool(`Error: File not found: ${args.path}`);
      let content = fs.readFileSync(filePath, 'utf-8');
      const count = args.count || 1;
      for (let i = 0; i < count; i++) {
        const idx = content.indexOf(args.old);
        if (idx === -1) {
          if (i === 0) return failTool(`Error: Text not found in ${args.path}`);
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
        return failTool(`Error: File not found: ${args.path}`);
      fs.unlinkSync(filePath);
      return `Deleted ${args.path}`;
    }

    case 'glob': {
      const pattern = readStringValue(args.pattern);
      if (!pattern) return failTool('Error: pattern is required');
      const result = runGlobSearch(pattern);
      if (result.isError) return failTool(result.output);
      return result.output;
    }

    case 'grep': {
      const result = runGrepSearch(args);
      if (result.isError) return failTool(result.output);
      return result.output;
    }

    case 'bash': {
      const blocked = guardCommand(args.command);
      if (blocked) return failTool(blocked);
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

        if (!combinedOutput) return failTool(`Error: ${summary}`);
        return failTool(
          `Error: ${summary}\n\n${formatBashOutput(replaceWorkspaceRootInOutput(combinedOutput))}`,
        );
      }
    }

    case 'memory': {
      const action =
        typeof args.action === 'string'
          ? args.action.trim().toLowerCase()
          : 'read';
      const relativePath = resolveMemoryFilePath(args);
      if (!relativePath) {
        return failTool(
          'Error: memory file_path must be MEMORY.md, USER.md, or memory/YYYY-MM-DD.md',
        );
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
          typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        if (!query)
          return failTool('Error: query is required for memory search');
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
        if (!content)
          return failTool('Error: content is required for memory append');

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const existing = fs.existsSync(filePath)
          ? fs.readFileSync(filePath, 'utf-8')
          : '';
        let next = existing.replace(/\s+$/, '');
        if (next.length > 0) next += '\n\n';
        next += `${content}\n`;
        const limit = memoryCharLimit(relativePath);
        if (next.length > limit) {
          return failTool(
            `Error: ${relativePath} would exceed ${limit} chars. Shorten content or remove older entries first.`,
          );
        }
        fs.writeFileSync(filePath, next, 'utf-8');
        return `Appended ${content.length} chars to ${relativePath}`;
      }

      if (action === 'write') {
        const content = typeof args.content === 'string' ? args.content : '';
        const limit = memoryCharLimit(relativePath);
        if (content.length > limit) {
          return failTool(
            `Error: ${relativePath} exceeds ${limit} char limit.`,
          );
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
        return `Wrote ${content.length} chars to ${relativePath}`;
      }

      if (action === 'replace') {
        const oldText = typeof args.old_text === 'string' ? args.old_text : '';
        const newText = typeof args.new_text === 'string' ? args.new_text : '';
        if (!oldText)
          return failTool('Error: old_text is required for memory replace');
        if (!fs.existsSync(filePath))
          return failTool(`Error: File not found: ${relativePath}`);
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.includes(oldText))
          return failTool(`Error: old_text not found in ${relativePath}`);
        const next = content.replace(oldText, newText);
        const limit = memoryCharLimit(relativePath);
        if (next.length > limit) {
          return failTool(
            `Error: replacement would exceed ${limit} chars for ${relativePath}.`,
          );
        }
        fs.writeFileSync(filePath, next, 'utf-8');
        return `Updated ${relativePath}`;
      }

      if (action === 'remove') {
        const oldText = typeof args.old_text === 'string' ? args.old_text : '';
        if (!oldText)
          return failTool('Error: old_text is required for memory remove');
        if (!fs.existsSync(filePath))
          return failTool(`Error: File not found: ${relativePath}`);
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.includes(oldText))
          return failTool(`Error: old_text not found in ${relativePath}`);
        fs.writeFileSync(filePath, content.replace(oldText, ''), 'utf-8');
        return `Removed matching text from ${relativePath}`;
      }

      return failTool(
        `Error: unknown memory action "${action}". Use read, append, write, replace, remove, list, or search.`,
      );
    }

    case 'message': {
      const action = resolveDiscordMessageAction(args.action);
      if (!action) {
        return failTool(
          'Error: unsupported message action. Use "read", "member-info", "channel-info", "send", "react", "quote-reply", "edit", "delete", "pin", "unpin", "thread-create", or "thread-reply".',
        );
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
          return failTool(
            'Error: channelId is required for message action "read".',
          );
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
          return failTool(
            'Error: guildId is required for message action "member-info".',
          );
        }
        if (!userId) {
          return failTool(
            'Error: userId/username is required for message action "member-info".',
          );
        }
        payload.guildId = guildId;
        payload.userId = userId;
        if (resolveAmbiguous) payload.resolveAmbiguous = resolveAmbiguous;
      }

      if (action === 'channel-info') {
        const channelId = resolveDiscordMessageChannelTarget(args);
        if (!channelId) {
          return failTool(
            'Error: channelId is required for message action "channel-info".',
          );
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
          : resolveGatewayMessageSendChannelFallback();
        const channelId = explicitChannelId || fallbackChannelId;
        if (!channelId && !userLookupTarget) {
          return failTool(
            'Error: channelId is required for message action "send" unless user/username is provided.',
          );
        }
        const content =
          readStringValue(args.content) ||
          readStringValue(args.text) ||
          readStringValue(args.message);
        const subject =
          readStringValue(args.subject) || readStringValue(args.title);
        const cc = readStringListValue(args.cc);
        const bcc = readStringListValue(args.bcc);
        const filePath =
          readStringValue(args.filePath) ||
          readStringValue(args.attachmentPath) ||
          readStringValue(args.mediaPath) ||
          readStringValue(args.imagePath) ||
          readStringValue(args.file);
        const components =
          Array.isArray(args.components) ||
          (args.components &&
            typeof args.components === 'object' &&
            !Array.isArray(args.components))
            ? args.components
            : undefined;
        if (filePath) {
          const resolvedFilePath =
            resolveWorkspacePath(filePath) || resolveMediaPath(filePath);
          if (!resolvedFilePath) {
            return failTool(
              `Error: filePath must stay within ${WORKSPACE_ROOT_DISPLAY} or ${DISCORD_MEDIA_CACHE_ROOT_DISPLAY}.`,
            );
          }
          if (!fs.existsSync(resolvedFilePath)) {
            return failTool(`Error: filePath does not exist: ${filePath}`);
          }
          const stat = fs.statSync(resolvedFilePath);
          if (!stat.isFile()) {
            return failTool(`Error: filePath is not a file: ${filePath}`);
          }
        }
        if (!content && components === undefined && !filePath) {
          return failTool(
            'Error: content is required for message action "send" unless components or filePath is provided.',
          );
        }
        if (channelId) payload.channelId = channelId;
        if (userLookupTarget) payload.user = userLookupTarget;
        if (content) payload.content = content;
        if (subject) payload.subject = subject;
        if (cc) payload.cc = cc;
        if (bcc) payload.bcc = bcc;
        if (filePath) payload.filePath = filePath;
        if (components !== undefined) payload.components = components;

        const requestingUserId = resolveDiscordRequestingUserId(args);
        const guildId = resolveDiscordGuildId(args.guildId);
        const contextChannelId = resolveGatewayDiscordChannelFallback();
        if (requestingUserId) payload.userId = requestingUserId;
        if (guildId) payload.guildId = guildId;
        if (contextChannelId) payload.contextChannelId = contextChannelId;
        if (resolveAmbiguous) payload.resolveAmbiguous = resolveAmbiguous;
      }

      if (action === 'react') {
        const channelId = resolveDiscordMessageChannelTarget(args);
        if (!channelId) {
          return failTool(
            'Error: channelId is required for message action "react".',
          );
        }
        if (!messageId) {
          return failTool(
            'Error: messageId is required for message action "react".',
          );
        }
        if (!emoji) {
          return failTool(
            'Error: emoji is required for message action "react".',
          );
        }
        payload.channelId = channelId;
        payload.messageId = messageId;
        payload.emoji = emoji;
      }

      if (action === 'quote-reply') {
        const channelId = resolveDiscordMessageChannelTarget(args);
        if (!channelId) {
          return failTool(
            'Error: channelId is required for message action "quote-reply".',
          );
        }
        if (!messageId) {
          return failTool(
            'Error: messageId is required for message action "quote-reply".',
          );
        }
        const content =
          readStringValue(args.content) ||
          readStringValue(args.text) ||
          readStringValue(args.message);
        if (!content) {
          return failTool(
            'Error: content is required for message action "quote-reply".',
          );
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
          return failTool(
            `Error: channelId is required for message action "${action}".`,
          );
        }
        if (!messageId) {
          return failTool(
            `Error: messageId is required for message action "${action}".`,
          );
        }
        payload.channelId = channelId;
        payload.messageId = messageId;

        if (action === 'edit') {
          const content =
            readStringValue(args.content) ||
            readStringValue(args.text) ||
            readStringValue(args.message);
          if (!content) {
            return failTool(
              'Error: content is required for message action "edit".',
            );
          }
          payload.content = content;
        }

        if (action === 'thread-create') {
          if (!threadName) {
            return failTool(
              'Error: name is required for message action "thread-create".',
            );
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
          return failTool(
            'Error: channelId is required for message action "thread-reply".',
          );
        }
        const content =
          readStringValue(args.content) ||
          readStringValue(args.text) ||
          readStringValue(args.message);
        if (!content) {
          return failTool(
            'Error: content is required for message action "thread-reply".',
          );
        }
        payload.channelId = channelId;
        payload.content = content;
        const requestingUserId = resolveDiscordRequestingUserId(args);
        const guildId = resolveDiscordGuildId(args.guildId);
        if (requestingUserId) payload.userId = requestingUserId;
        if (guildId) payload.guildId = guildId;
      }

      return await callGatewayMessageAction(payload);
    }

    case 'session_search': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query)
        return failTool('Error: query is required for session_search');

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

        const sessionId = rows[0].sessionId || filename.replace(/\.jsonl$/, '');
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
      const useLlmSummary =
        args.useLlmSummary === true ||
        args.llmSummary === true ||
        (args.useLlmSummary !== false &&
          args.llmSummary !== false &&
          Boolean(auxiliaryRuntimeContext.taskModels?.session_search));
      const results: Record<string, unknown>[] = [];
      for (const candidate of top) {
        const summaryResult = summarizeSessionCandidate(candidate, query);
        if (useLlmSummary) {
          try {
            const llmSummary = await summarizeSessionCandidateWithAuxiliary(
              auxiliaryRuntimeContext,
              candidate,
              query,
            );
            if (llmSummary) {
              summaryResult.summary = llmSummary;
            }
          } catch {
            // Keep deterministic fallback summary.
          }
        }
        results.push(summaryResult);
      }

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

    case 'web_fetch':
    case 'web_extract': {
      const { webFetch } = await import('./web-fetch.js');
      const result = await webFetch({
        url: args.url,
        extractMode: args.extractMode,
        maxChars: args.maxChars,
      });
      const useLlmProcessing =
        args.llmProcess === true ||
        args.useLlmProcessing === true ||
        (name === 'web_extract' &&
          args.llmProcess !== false &&
          args.useLlmProcessing !== false);
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
      let outputText = result.text;
      if (useLlmProcessing && result.text.trim()) {
        try {
          outputText = await processWebExtractWithAuxiliary({
            runtimeContext: auxiliaryRuntimeContext,
            url: result.finalUrl,
            title: result.title,
            extractedText: result.text,
            maxOutputChars:
              typeof args.maxChars === 'number' &&
              Number.isFinite(args.maxChars)
                ? Math.max(
                    1_000,
                    Math.min(
                      Math.floor(args.maxChars),
                      WEB_EXTRACT_MAX_SYNTHESIS_CHARS,
                    ),
                  )
                : WEB_EXTRACT_MAX_SYNTHESIS_CHARS,
          });
          lines.push('LLM processing: applied');
        } catch (err) {
          lines.push(
            `LLM processing failed; returning raw extraction. ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return `${lines.join('\n')}\n\n${header}${outputText}`;
    }

    case 'http_request': {
      return callGatewayHttpRequest(args);
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
      return await runVisionAnalyze(args, auxiliaryRuntimeContext);
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
      const output = await executeBrowserTool(
        name,
        args,
        currentSessionId || 'default',
      );
      const structured = parseStructuredToolOutput(output);
      if (structured?.success === false) {
        return failTool(output);
      }
      return output;
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
            else if (secs < 7200) schedule = `every ${Math.round(secs / 60)}m`;
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
        if (!promptInput) return failTool('Error: prompt is required');
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
            return failTool(`Error: invalid ISO-8601 timestamp: ${rawAt}`);
          if (runAt.getTime() <= Date.now())
            return failTool(
              `Error: timestamp must be in the future: ${rawAt || runAt.toISOString()}`,
            );
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
            return failTool('Error: "every" must be a number of seconds >= 10');
          const everyMs = Math.round(secs * 1000);
          pendingSchedules.push({
            action: 'add',
            everyMs,
            prompt,
          });
          return `Scheduled interval task every ${secs}s: ${prompt}`;
        }

        return failTool(
          'Error: provide "at" (ISO-8601 timestamp), "at_seconds" (one-shot seconds from now), "cron" (cron expression), or "every" (seconds)',
        );
      }

      if (action === 'remove') {
        if (!args.taskId) return failTool('Error: taskId is required');
        pendingSchedules.push({ action: 'remove', taskId: args.taskId });
        return `Scheduled removal of task #${args.taskId}`;
      }

      return failTool(
        `Error: unknown cron action "${action}". Use "list", "add", or "remove".`,
      );
    }

    case 'delegate': {
      if (pendingDelegations.length >= MAX_PENDING_DELEGATIONS) {
        return failTool(
          `Error: delegation limit reached for this turn (${MAX_PENDING_DELEGATIONS}).`,
        );
      }

      const modeRaw =
        typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : '';
      if (
        modeRaw &&
        modeRaw !== 'single' &&
        modeRaw !== 'parallel' &&
        modeRaw !== 'chain'
      ) {
        return failTool(
          'Error: mode must be one of "single", "parallel", or "chain".',
        );
      }

      const label = typeof args.label === 'string' ? args.label.trim() : '';
      const model = typeof args.model === 'string' ? args.model.trim() : '';
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      const tasksResult = normalizeDelegationTaskList({
        raw: args.tasks,
        fallbackModel: model || undefined,
        fieldName: 'tasks',
      });
      if (tasksResult.error) return failTool(tasksResult.error);
      const chainResult = normalizeDelegationTaskList({
        raw: args.chain,
        fallbackModel: model || undefined,
        fieldName: 'chain',
      });
      if (chainResult.error) return failTool(chainResult.error);

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
        return failTool(
          'Error: provide one delegation mode payload: "prompt", "tasks", or "chain".',
        );
      }

      let effect: DelegationSideEffect;
      let summary: string;

      if (mode === 'single') {
        if (!hasPrompt)
          return failTool('Error: prompt is required for mode="single".');
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
          return failTool('Error: tasks are required for mode="parallel".');
        effect = {
          action: 'delegate',
          mode,
          label: label || undefined,
          model: model || undefined,
          tasks: tasksResult.tasks,
        };
        summary = `${tasksResult.tasks.length} parallel task(s)`;
      } else {
        if (!hasChain)
          return failTool('Error: chain is required for mode="chain".');
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
      return failTool(`Unknown tool: ${name}`);
  }
}

export async function executeToolWithMetadata(
  name: string,
  argsJson: string,
): Promise<ToolRunResult> {
  try {
    return {
      output: await executeToolInternal(name, argsJson),
      isError: false,
    };
  } catch (err) {
    if (err instanceof ToolExecutionFailure) {
      return {
        output: err.output,
        isError: true,
      };
    }
    return {
      output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

export async function executeTool(
  name: string,
  argsJson: string,
): Promise<string> {
  const result = await executeToolWithMetadata(name, argsJson);
  return result.output;
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
  ...SEARCH_TOOL_DEFINITIONS,
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
              'Send target or Discord channel selector. For `send`, accepts Discord ids/mentions/#channel, WhatsApp JIDs or phone numbers, and local channel ids like `tui`. For Discord-only actions, use a Discord channel id/mention/#channel.',
          },
          guildId: {
            type: 'string',
            description:
              'Discord guild id (required for member-info; optional for Discord channel-name sends).',
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
              'Ambiguity policy for Discord name lookups. For action="member-info", user-target sends, and channel-name targets: "error" (default) returns an error/candidates, "best" auto-picks the top score.',
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
          subject: {
            type: 'string',
            description:
              'Optional email subject override for action="send" when channelId/to targets an email address. If omitted, email can still use an inline `[Subject: ...]` prefix in content.',
          },
          cc: {
            type: ['string', 'array'],
            items: {
              type: 'string',
            },
            description:
              'Optional email CC recipient or list of recipients for action="send" when channelId/to targets an email address.',
          },
          bcc: {
            type: ['string', 'array'],
            items: {
              type: 'string',
            },
            description:
              'Optional email BCC recipient or list of recipients for action="send" when channelId/to targets an email address.',
          },
          filePath: {
            type: 'string',
            description:
              'Optional local file to upload for action="send". Discord, the current Teams conversation, WhatsApp, and email support filePath; local queued sends do not. Use a workspace-relative path or an absolute /discord-media-cache path.',
          },
          attachmentPath: {
            type: 'string',
            description:
              'Alias for filePath in action="send". Use for local Discord uploads.',
          },
          mediaPath: {
            type: 'string',
            description:
              'Alias for filePath in action="send". Use for local Discord uploads.',
          },
          imagePath: {
            type: 'string',
            description:
              'Alias for filePath in action="send" when uploading a local image.',
          },
          file: {
            type: 'string',
            description:
              'Alias for filePath in action="send". Use a local file path to attach.',
          },
          components: {
            type: ['object', 'array'],
            items: {
              type: 'object',
            },
            description:
              'Optional Discord components payload for action="send" (buttons/selects/action rows). Supported only for Discord sends, not Teams/WhatsApp/email/local sends.',
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
              'Context Discord channel id used to infer guild for Discord user-target sends.',
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
              'Target user or channel. For `send`, accepts Discord channel IDs, user IDs, @usernames, #channel-name, WhatsApp JIDs or phone numbers, or local channel ids like `tui`.',
          },
          to: {
            type: 'string',
            description:
              'Target user or channel. For `send`, accepts Discord channel IDs, user IDs, @usernames, #channel-name, WhatsApp JIDs or phone numbers, or local channel ids like `tui`.',
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
          useLlmSummary: {
            type: 'boolean',
            description:
              'When true, summarize matches with the auxiliary session_search model. If omitted, this auto-enables when auxiliaryModels.session_search is configured.',
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
          llmProcess: {
            type: 'boolean',
            description:
              'When true, run the extracted content through the auxiliary web_extract model for a denser markdown summary.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_extract',
      description:
        'Fetch a URL and return a processed markdown summary of the readable content. This is the higher-cost, Hermes-style companion to web_fetch: it first extracts readable content, then routes that content through the auxiliary web_extract model by default. Use web_fetch instead when you want the raw extracted page text without model post-processing.',
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
              'Maximum characters to return after model processing (default 40000, max 50000)',
          },
          llmProcess: {
            type: 'boolean',
            description:
              'Whether to run auxiliary LLM processing. Defaults to true for web_extract.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description:
        'Call an HTTP or HTTPS API through the gateway. Use this for structured API requests instead of `bash` + `curl`, especially when auth is needed. Preferred auth path: set `bearerSecretName` or `secretHeaders` so the gateway injects the real stored secret without exposing it to the model. You may also use strict placeholders like `<secret:MY_API_KEY>` inside headers, `body`, or `json` values. Matching URL auth rules configured in the gateway are applied automatically.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'HTTP or HTTPS URL to request.',
          },
          method: {
            type: 'string',
            description:
              'HTTP method such as GET, POST, PUT, PATCH, or DELETE. Defaults to GET.',
          },
          headers: {
            type: 'object',
            description:
              'Optional request headers. Do not place real secret values here; use bearerSecretName, secretHeaders, or <secret:NAME> placeholders instead.',
          },
          body: {
            type: 'string',
            description:
              'Optional raw text request body. Use `json` instead for JSON payloads.',
          },
          json: {
            type: 'object',
            description:
              'Optional structured JSON payload. This is serialized automatically and defaults Content-Type to application/json.',
          },
          bearerSecretName: {
            type: 'string',
            description:
              'Name of a stored secret to inject as `Authorization: Bearer <secret>`.',
          },
          secretHeaders: {
            type: 'array',
            description:
              'Additional secret-backed headers to inject without exposing raw values.',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Header name, for example `X-API-Key`.',
                },
                secretName: {
                  type: 'string',
                  description: 'Stored secret name to inject.',
                },
                prefix: {
                  type: 'string',
                  description:
                    'Optional prefix prepended before the secret value, for example `Bearer`. Use `none` for raw secret values.',
                },
              },
              required: ['name', 'secretName'],
            },
          },
          replaceSecretPlaceholders: {
            type: 'boolean',
            description:
              'When true (default), replace `<secret:NAME>` placeholders inside headers, body, and json values.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Optional timeout in milliseconds.',
          },
          maxResponseBytes: {
            type: 'number',
            description: 'Optional maximum response size in bytes.',
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
        'Analyze a current-turn image attachment using vision. Prefer local attachment paths from /workspace, /discord-media-cache, or /uploaded-media-cache; use a Discord CDN fallback URL only when no local path is readable.',
      parameters: {
        type: 'object',
        properties: {
          image_url: {
            type: 'string',
            description:
              'Local image path (preferred) from /workspace, /discord-media-cache, or /uploaded-media-cache, or a Discord CDN HTTPS URL.',
          },
          question: {
            type: 'string',
            description: 'Question to ask about the image.',
          },
          fallback_url: {
            type: 'string',
            description:
              'Optional fallback Discord CDN URL if the local image path cannot be read.',
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
              'Local image path (preferred) from /workspace, /discord-media-cache, or /uploaded-media-cache, or a Discord CDN HTTPS URL.',
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
