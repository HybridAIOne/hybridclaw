import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { CodexMcpContext } from './codex-app-types.js';
import {
  isRecord,
  readString as readUnknownString,
} from './codex-app-utils.js';
import type {
  ChatMessage,
  ContainerInput,
  ContainerOutput,
  PendingApproval,
  TokenUsageStats,
  ToolExecution,
} from './types.js';

type JsonRpcId = string | number;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CodexProjection {
  threadId: string | null;
  textDeltas: string[];
  agentMessages: string[];
  toolExecutions: ToolExecution[];
  toolsUsed: Set<string>;
  tokenUsage: TokenUsageStats;
  approvalEvents: ToolExecution[];
  pendingApproval: PendingApproval | null;
  error: string | null;
  completed: boolean;
}

interface RunCodexAppServerTurnParams {
  sessionId: string;
  messages: ChatMessage[];
  model: string;
  cwd?: string;
  apiKey?: string;
  baseUrl?: string;
  provider?: ContainerInput['provider'];
  providerMethod?: string;
  chatbotId?: string;
  requestHeaders?: Record<string, string>;
  maxTokens?: number;
  modelBehavior?: ContainerInput['modelBehavior'];
  debugModelResponses?: boolean;
  gatewayBaseUrl?: string;
  gatewayApiToken?: string;
  channelId?: string;
  configuredDiscordChannels?: string[];
  mcpServers?: ContainerInput['mcpServers'];
  taskModels?: ContainerInput['taskModels'];
  media?: ContainerInput['media'];
  webSearch?: ContainerInput['webSearch'];
  providerCredentials?: ContainerInput['providerCredentials'];
  streamTextDeltas?: boolean;
  onTextDelta?: (delta: string) => void;
}

const CODEX_REQUEST_TIMEOUT_MS = 30_000;
const CODEX_APPROVAL_EXPIRES_MS = 10 * 60 * 1000;
const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SENSITIVE_ENV_KEY_RE =
  /(^|[_-])(secret|token|password|passwd|pass|credential|credentials|apikey|api[-_]?key|auth|bearer|private|key)([_-]|$)|apikey|api_key/i;
const MCP_SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'codex-hybridclaw-mcp.js',
);

interface PendingCodexApproval {
  approvalId: string;
  sessionId: string;
  client: CodexAppServerClient;
  projection: CodexProjection;
  requestId: JsonRpcId;
  method: string;
  params: unknown;
}

interface CodexMcpContextPayloads {
  fileContext: Record<string, unknown>;
  secretContext: Record<string, unknown>;
}

const pendingCodexApprovals = new Map<string, PendingCodexApproval>();
let codexCliAvailablePromise: Promise<void> | null = null;

function normalizeCodexModelName(model: string): string {
  const trimmed = String(model || '').trim();
  return trimmed.toLowerCase().startsWith('openai-codex/')
    ? trimmed.slice('openai-codex/'.length)
    : trimmed;
}

function stringifyContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function extractSystemInstructions(messages: ChatMessage[]): string | null {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => stringifyContent(message.content).trim())
    .filter(Boolean)
    .join('\n\n');
  return instructions || null;
}

function latestUserMessage(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages[i];
  }
  return null;
}

export function buildCodexTurnText(messages: ChatMessage[]): string {
  const latest = latestUserMessage(messages);
  if (!latest) return '';
  const latestText = stringifyContent(latest.content).trim();
  const prior = messages
    .filter((message) => message.role !== 'system' && message !== latest)
    .map((message) => {
      const content = stringifyContent(message.content).trim();
      if (!content) return '';
      return `${message.role}: ${content}`;
    })
    .filter(Boolean);

  if (prior.length === 0) return latestText;
  return [
    'Prior conversation context:',
    prior.join('\n\n'),
    '',
    'Current user request:',
    latestText,
  ].join('\n');
}

function buildCodexUserInput(
  messages: ChatMessage[],
  text = buildCodexTurnText(messages),
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  const latest = latestUserMessage(messages);
  if (text) {
    input.push({ type: 'text', text, text_elements: [] });
  }
  if (!latest || !Array.isArray(latest.content)) return input;
  for (const part of latest.content) {
    if (part.type === 'image_url' && part.image_url.url) {
      input.push({ type: 'image', url: part.image_url.url });
    }
  }
  return input;
}

function emptyTokenUsage(): TokenUsageStats {
  return {
    modelCalls: 1,
    apiUsageAvailable: false,
    apiPromptTokens: 0,
    apiCompletionTokens: 0,
    apiTotalTokens: 0,
    apiCacheUsageAvailable: false,
    apiCacheReadTokens: 0,
    apiCacheWriteTokens: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    estimatedTotalTokens: 0,
  };
}

function readString(record: Record<string, unknown>, key: string): string {
  return readUnknownString(record[key]);
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | null {
  return typeof record[key] === 'number' && Number.isFinite(record[key])
    ? record[key]
    : null;
}

function appendToolExecution(
  projection: CodexProjection,
  execution: ToolExecution,
): void {
  projection.toolExecutions.push(execution);
  projection.toolsUsed.add(execution.name);
}

function projectionToolsUsed(projection: CodexProjection): string[] {
  return [...projection.toolsUsed];
}

function latestUserText(messages: ChatMessage[]): string {
  const latest = latestUserMessage(messages);
  return latest ? stringifyContent(latest.content).trim() : '';
}

function parseApprovalDirective(input: string): {
  kind: 'approve' | 'deny';
  mode?: 'session';
  requestId: string;
} | null {
  const normalized = input.trim();
  const approve = normalized.match(
    /^(?:\/?(?:approve|yes|y))(?:\s+([a-f0-9-]{6,64}))?(?:\s+(?:for\s+)?(session))?$/i,
  );
  if (approve) {
    return {
      kind: 'approve',
      requestId: String(approve[1] || '').trim(),
      ...(approve[2] ? { mode: 'session' } : {}),
    };
  }
  const deny = normalized.match(
    /^(?:\/?(?:deny|reject|skip|no|n))(?:\s+([a-f0-9-]{6,64}))?$/i,
  );
  if (deny) {
    return { kind: 'deny', requestId: String(deny[1] || '').trim() };
  }
  return null;
}

type ApprovalDirective = NonNullable<ReturnType<typeof parseApprovalDirective>>;

function isApprovalForPending(
  sessionId: string,
  messages: ChatMessage[],
  pending: PendingCodexApproval | null,
): pending is PendingCodexApproval {
  if (!pending) return false;
  if (pending.sessionId !== sessionId) return false;
  const directive = parseApprovalDirective(latestUserText(messages));
  if (!directive) return false;
  return !directive.requestId || directive.requestId === pending.approvalId;
}

function buildPendingApproval(
  approvalId: string,
  method: string,
  params: unknown,
): PendingApproval {
  const prompt = [
    'Codex app-server requested approval for a native runtime action.',
    '',
    `Approval ID: ${approvalId}`,
    `Request: ${method}`,
    '',
    JSON.stringify(params, null, 2),
  ].join('\n');
  return {
    approvalId,
    prompt,
    intent: method,
    reason: 'Codex app-server requested permission before continuing the turn.',
    allowSession: true,
    allowAgent: false,
    allowAll: false,
    expiresAt: Date.now() + CODEX_APPROVAL_EXPIRES_MS,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function pushConfig(args: string[], key: string, value: string): void {
  args.push('-c', `${key}=${value}`);
}

function sanitizeMcpServerName(name: string): string | null {
  const trimmed = name.trim();
  return MCP_SERVER_NAME_RE.test(trimmed) ? trimmed : null;
}

function pushHybridClawMcpConfig(args: string[], contextPath: string | null) {
  pushConfig(
    args,
    'mcp_servers.hybridclaw.command',
    tomlString(process.execPath),
  );
  pushConfig(
    args,
    'mcp_servers.hybridclaw.args',
    tomlStringArray([MCP_SCRIPT_PATH]),
  );
  if (contextPath) {
    pushConfig(
      args,
      'mcp_servers.hybridclaw.env.HYBRIDCLAW_CODEX_MCP_CONTEXT_PATH',
      tomlString(contextPath),
    );
  }
}

function pushUserMcpServerConfig(
  args: string[],
  name: string,
  config: NonNullable<ContainerInput['mcpServers']>[string],
): void {
  const safeName = sanitizeMcpServerName(name);
  if (!safeName || config.enabled === false) return;
  const prefix = `mcp_servers.${safeName}`;
  if (config.transport === 'stdio') {
    if (!config.command) return;
    pushConfig(args, `${prefix}.command`, tomlString(config.command));
    if (config.args?.length) {
      pushConfig(args, `${prefix}.args`, tomlStringArray(config.args));
    }
    if (config.cwd) pushConfig(args, `${prefix}.cwd`, tomlString(config.cwd));
    for (const [key, value] of Object.entries(config.env || {})) {
      if (SENSITIVE_ENV_KEY_RE.test(key)) continue;
      pushConfig(args, `${prefix}.env.${key}`, tomlString(value));
    }
    return;
  }
  if (config.url) {
    pushConfig(args, `${prefix}.url`, tomlString(config.url));
  }
}

export function buildCodexAppServerArgs(
  mcpServers: ContainerInput['mcpServers'] | undefined,
  contextPath: string | null,
): string[] {
  const args = ['app-server', '--listen', 'stdio://'];
  pushHybridClawMcpConfig(args, contextPath);
  for (const [name, config] of Object.entries(mcpServers || {})) {
    pushUserMcpServerConfig(args, name, config);
  }
  return args;
}

function compactRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function splitWebSearchConfig(webSearch: ContainerInput['webSearch']): {
  fileWebSearch?: ContainerInput['webSearch'];
  secretWebSearch?: Partial<NonNullable<ContainerInput['webSearch']>>;
} {
  if (!webSearch) return {};
  const {
    braveApiKey,
    perplexityApiKey,
    tavilyApiKey,
    searxngBearerTokenRef,
    ...fileWebSearch
  } = webSearch;
  const secretWebSearch = compactRecord({
    braveApiKey,
    perplexityApiKey,
    tavilyApiKey,
    searxngBearerTokenRef,
  }) as Partial<NonNullable<ContainerInput['webSearch']>>;
  return {
    fileWebSearch,
    ...(Object.keys(secretWebSearch).length > 0 ? { secretWebSearch } : {}),
  };
}

export function buildCodexMcpContextPayloads(
  params: Pick<
    RunCodexAppServerTurnParams,
    | 'provider'
    | 'providerMethod'
    | 'baseUrl'
    | 'apiKey'
    | 'model'
    | 'chatbotId'
    | 'requestHeaders'
    | 'maxTokens'
    | 'modelBehavior'
    | 'debugModelResponses'
    | 'gatewayBaseUrl'
    | 'gatewayApiToken'
    | 'channelId'
    | 'configuredDiscordChannels'
    | 'taskModels'
    | 'media'
    | 'webSearch'
    | 'providerCredentials'
  >,
): CodexMcpContextPayloads {
  const { fileWebSearch, secretWebSearch } = splitWebSearchConfig(
    params.webSearch,
  );
  return {
    fileContext: compactRecord({
      provider: params.provider,
      providerMethod: params.providerMethod,
      baseUrl: params.baseUrl,
      model: params.model,
      chatbotId: params.chatbotId,
      maxTokens: params.maxTokens,
      modelBehavior: params.modelBehavior,
      debugModelResponses: params.debugModelResponses,
      channelId: params.channelId,
      configuredDiscordChannels: params.configuredDiscordChannels,
      taskModels: params.taskModels,
      media: params.media,
      webSearch: fileWebSearch,
    }) satisfies CodexMcpContext,
    secretContext: compactRecord({
      apiKey: params.apiKey,
      requestHeaders: params.requestHeaders,
      gatewayBaseUrl: params.gatewayBaseUrl,
      gatewayApiToken: params.gatewayApiToken,
      webSearch: secretWebSearch,
      providerCredentials: params.providerCredentials,
    }) satisfies CodexMcpContext,
  };
}

function buildMcpSecretEnv(
  params: RunCodexAppServerTurnParams,
): Record<string, string> {
  const { secretContext } = buildCodexMcpContextPayloads(params);
  const compact = compactRecord(secretContext);
  if (Object.keys(compact).length === 0) return {};
  return {
    HYBRIDCLAW_CODEX_MCP_SECRET_CONTEXT_B64: Buffer.from(
      JSON.stringify(compact),
      'utf-8',
    ).toString('base64'),
  };
}

function writeMcpContextFile(
  params: RunCodexAppServerTurnParams,
): string | null {
  const { fileContext } = buildCodexMcpContextPayloads(params);
  const context = compactRecord(fileContext);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-codex-mcp-'));
  const contextPath = path.join(dir, 'context.json');
  fs.writeFileSync(contextPath, JSON.stringify(context), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return contextPath;
}

export function projectCodexThreadItem(
  projection: CodexProjection,
  item: unknown,
): void {
  if (!isRecord(item)) return;
  const type = readString(item, 'type');
  if (type === 'agentMessage') {
    const text = readString(item, 'text');
    if (text) projection.agentMessages.push(text);
    return;
  }
  if (type === 'commandExecution') {
    appendToolExecution(projection, {
      name: 'codex.command',
      arguments: readString(item, 'command'),
      result: readString(item, 'aggregatedOutput'),
      durationMs: readNumber(item, 'durationMs') ?? 0,
      isError: readString(item, 'status') !== 'completed',
    });
    return;
  }
  if (type === 'fileChange') {
    appendToolExecution(projection, {
      name: 'codex.patch',
      arguments: JSON.stringify(item.changes ?? []),
      result: readString(item, 'status') || 'file change completed',
      durationMs: 0,
      isError: readString(item, 'status') === 'failed',
    });
    return;
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const tool =
      type === 'mcpToolCall'
        ? `${readString(item, 'server')}.${readString(item, 'tool')}`
        : readString(item, 'tool');
    appendToolExecution(projection, {
      name: type === 'mcpToolCall' ? 'codex.mcp' : 'codex.tool',
      arguments: JSON.stringify({ tool, arguments: item.arguments ?? null }),
      result: JSON.stringify(
        item.result ?? item.contentItems ?? item.error ?? null,
      ),
      durationMs: readNumber(item, 'durationMs') ?? 0,
      isError:
        item.success === false ||
        readString(item, 'status') === 'failed' ||
        Boolean(item.error),
    });
    return;
  }
  const normalizedType = type.toLowerCase();
  if (normalizedType.includes('plan')) {
    appendToolExecution(projection, {
      name: 'codex.plan',
      arguments: JSON.stringify(item.plan ?? item),
      result: readString(item, 'status') || JSON.stringify(item),
      durationMs: readNumber(item, 'durationMs') ?? 0,
      isError: readString(item, 'status') === 'failed' || Boolean(item.error),
    });
    return;
  }
  if (normalizedType.includes('sandbox')) {
    appendToolExecution(projection, {
      name: 'codex.sandbox',
      arguments: JSON.stringify(item),
      result: readString(item, 'status') || JSON.stringify(item),
      durationMs: readNumber(item, 'durationMs') ?? 0,
      isError: readString(item, 'status') === 'failed' || Boolean(item.error),
    });
  }
}

function applyTokenUsage(
  projection: CodexProjection,
  tokenUsage: unknown,
): void {
  if (!isRecord(tokenUsage) || !isRecord(tokenUsage.total)) return;
  const total = tokenUsage.total;
  const inputTokens = readNumber(total, 'inputTokens') ?? 0;
  const outputTokens = readNumber(total, 'outputTokens') ?? 0;
  const totalTokens =
    readNumber(total, 'totalTokens') ?? inputTokens + outputTokens;
  const cachedInputTokens = readNumber(total, 'cachedInputTokens') ?? 0;
  projection.tokenUsage.apiUsageAvailable = true;
  projection.tokenUsage.apiPromptTokens = inputTokens;
  projection.tokenUsage.apiCompletionTokens = outputTokens;
  projection.tokenUsage.apiTotalTokens = totalTokens;
  projection.tokenUsage.apiCacheUsageAvailable = cachedInputTokens > 0;
  projection.tokenUsage.apiCacheReadTokens = cachedInputTokens;
}

function approvalExecution(method: string, params: unknown): ToolExecution {
  return {
    name: 'codex.approval',
    arguments: JSON.stringify({ method, params }),
    result:
      'Codex app-server requested approval through the HybridClaw approval bridge.',
    durationMs: 0,
    isError: false,
    blocked: true,
    approvalTier: 'red',
    approvalBaseTier: 'red',
    approvalDecision: 'required',
  };
}

function approvalResolutionExecution(
  method: string,
  params: unknown,
  directive: NonNullable<ReturnType<typeof parseApprovalDirective>>,
): ToolExecution {
  const approved = directive.kind === 'approve';
  return {
    name: 'codex.approval',
    arguments: JSON.stringify({ method, params }),
    result: approved
      ? 'Codex app-server approval granted by user response.'
      : 'Codex app-server approval denied by user response.',
    durationMs: 0,
    isError: !approved,
    blocked: !approved,
    approvalTier: 'red',
    approvalBaseTier: 'red',
    approvalDecision: approved
      ? directive.mode === 'session'
        ? 'approved_session'
        : 'approved_once'
      : 'denied',
  };
}

class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly projection: CodexProjection;
  private completedResolver: ((projection: CodexProjection) => void) | null =
    null;
  private completedRejecter: ((error: Error) => void) | null = null;
  private approvalResolver:
    | ((approval: {
        approvalId: string;
        method: string;
        params: unknown;
        requestId: JsonRpcId;
      }) => void)
    | null = null;
  private readonly stderrChunks: string[] = [];
  private stderrLength = 0;
  private contextPath: string | null = null;

  private readonly child;

  constructor(
    projection: CodexProjection,
    params: RunCodexAppServerTurnParams,
  ) {
    this.projection = projection;
    const spawnEnv = { ...process.env, ...buildMcpSecretEnv(params) };
    const contextPath = writeMcpContextFile(params);
    if (contextPath) this.contextPath = contextPath;
    const args = buildCodexAppServerArgs(params.mcpServers, contextPath);
    this.child = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk) => {
      this.appendStderr(String(chunk));
    });
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('exit', (code, signal) => {
      if (this.projection.completed) return;
      const stderr = this.stderrText().trim();
      this.rejectAll(
        new Error(
          `codex app-server exited before turn completion (code=${code ?? 'null'} signal=${signal ?? 'null'}).${stderr ? ` stderr: ${stderr}` : ''}`,
        ),
      );
    });
  }

  private appendStderr(chunk: string): void {
    if (!chunk) return;
    this.stderrChunks.push(chunk);
    this.stderrLength += chunk.length;
    while (this.stderrLength > 24_000 && this.stderrChunks.length > 1) {
      this.stderrLength -= this.stderrChunks.shift()?.length ?? 0;
    }
  }

  private stderrText(): string {
    const text = this.stderrChunks.join('');
    return text.length > 12_000 ? text.slice(-12_000) : text;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, CODEX_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${payload}\n`);
    });
  }

  waitForCompletion(): Promise<CodexProjection> {
    if (this.projection.completed) return Promise.resolve(this.projection);
    return new Promise((resolve, reject) => {
      this.completedResolver = resolve;
      this.completedRejecter = reject;
    });
  }

  waitForCompletionOrApproval(): Promise<
    | { kind: 'completed'; projection: CodexProjection }
    | {
        kind: 'approval';
        approvalId: string;
        method: string;
        params: unknown;
        requestId: JsonRpcId;
      }
  > {
    if (this.projection.completed) {
      return Promise.resolve({
        kind: 'completed',
        projection: this.projection,
      });
    }
    return new Promise((resolve, reject) => {
      this.completedResolver = (projection) => {
        resolve({ kind: 'completed', projection });
      };
      this.completedRejecter = reject;
      this.approvalResolver = (approval) => {
        resolve({ kind: 'approval', ...approval });
      };
    });
  }

  resolveServerRequest(id: JsonRpcId, result: unknown): void {
    this.sendResponse(id, result);
  }

  close(): void {
    this.child.kill();
    if (this.contextPath) {
      fs.rmSync(path.dirname(this.contextPath), {
        recursive: true,
        force: true,
      });
      this.contextPath = null;
    }
  }

  private resolveResponse(id: JsonRpcId, result: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(result);
  }

  private rejectResponse(id: JsonRpcId, error: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(new Error(parseJsonRpcError(error)));
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.completedRejecter?.(error);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && message.result !== undefined) {
      this.resolveResponse(message.id, message.result);
      return;
    }
    if (message.id !== undefined && message.error !== undefined) {
      this.rejectResponse(message.id, message.error);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if (message.method) {
      this.handleNotification(message.method, message.params);
    }
  }

  private sendResponse(id: JsonRpcId, result: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private sendError(id: JsonRpcId, message: string): void {
    this.child.stdin.write(
      `${JSON.stringify({ id, error: { code: -32000, message } })}\n`,
    );
  }

  private handleServerRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): void {
    this.projection.approvalEvents.push(approvalExecution(method, params));
    const approvalId = randomUUID();
    this.projection.pendingApproval = buildPendingApproval(
      approvalId,
      method,
      params,
    );
    this.approvalResolver?.({ approvalId, method, params, requestId: id });
    if (this.approvalResolver) {
      this.approvalResolver = null;
      return;
    }
    if (method === 'item/commandExecution/requestApproval') {
      this.sendResponse(id, { decision: 'decline' });
      return;
    }
    if (method === 'item/fileChange/requestApproval') {
      this.sendResponse(id, { decision: 'decline' });
      return;
    }
    if (method === 'item/permissions/requestApproval') {
      this.sendResponse(id, {
        permissions: {},
        scope: 'turn',
        strictAutoReview: true,
      });
      return;
    }
    if (method === 'execCommandApproval') {
      this.sendResponse(id, { decision: 'denied' });
      return;
    }
    if (method === 'applyPatchApproval') {
      this.sendResponse(id, { decision: 'denied' });
      return;
    }
    this.sendError(
      id,
      `HybridClaw Codex app-server bridge cannot service ${method}.`,
    );
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'item/agentMessage/delta' && isRecord(params)) {
      const delta = readString(params, 'delta');
      if (delta) {
        this.projection.textDeltas.push(delta);
      }
      return;
    }
    if (method === 'item/completed' && isRecord(params)) {
      projectCodexThreadItem(this.projection, params.item);
      return;
    }
    if (method === 'thread/tokenUsage/updated' && isRecord(params)) {
      applyTokenUsage(this.projection, params.tokenUsage);
      return;
    }
    if (method === 'turn/plan/updated' && isRecord(params)) {
      appendToolExecution(this.projection, {
        name: 'codex.plan',
        arguments: JSON.stringify(params.plan ?? []),
        result:
          readString(params, 'explanation') ||
          JSON.stringify(params.plan ?? []),
        durationMs: 0,
        isError: false,
      });
      return;
    }
    if (method === 'turn/completed' && isRecord(params)) {
      this.projection.completed = true;
      if (isRecord(params.turn) && isRecord(params.turn.error)) {
        this.projection.error = parseTurnError(params.turn.error);
      }
      this.completedResolver?.(this.projection);
      return;
    }
    if (method === 'error' && isRecord(params)) {
      this.projection.error = parseTurnError(params);
    }
  }
}

function parseJsonRpcError(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

function parseTurnError(error: Record<string, unknown>): string {
  return (
    readString(error, 'message') ||
    readString(error, 'reason') ||
    JSON.stringify(error)
  );
}

function createProjection(): CodexProjection {
  return {
    threadId: null,
    textDeltas: [],
    agentMessages: [],
    toolExecutions: [],
    toolsUsed: new Set<string>(),
    tokenUsage: emptyTokenUsage(),
    approvalEvents: [],
    pendingApproval: null,
    error: null,
    completed: false,
  };
}

function buildCodexApprovalResponse(
  method: string,
  directive: ApprovalDirective,
  params?: unknown,
): unknown | null {
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval'
  ) {
    return {
      decision:
        directive.kind === 'approve'
          ? directive.mode === 'session'
            ? 'acceptForSession'
            : 'accept'
          : 'decline',
    };
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return {
      decision:
        directive.kind === 'approve'
          ? directive.mode === 'session'
            ? 'approved_for_session'
            : 'approved'
          : 'denied',
    };
  }
  if (method === 'item/permissions/requestApproval') {
    const requestedPermissions =
      isRecord(params) && isRecord(params.permissions)
        ? params.permissions
        : {};
    return {
      permissions: directive.kind === 'approve' ? requestedPermissions : {},
      scope: directive.mode === 'session' ? 'session' : 'turn',
      strictAutoReview: true,
    };
  }
  return {
    permissions: {},
    scope: 'turn',
    strictAutoReview: true,
  };
}

export function buildCodexApprovalResponseForDirective(
  method: string,
  rawDirective: string,
  params?: unknown,
): unknown | null {
  const directive = parseApprovalDirective(rawDirective);
  return directive
    ? buildCodexApprovalResponse(method, directive, params)
    : null;
}

function respondToCodexApproval(
  pending: PendingCodexApproval,
  directive: ApprovalDirective,
): void {
  const response = buildCodexApprovalResponse(
    pending.method,
    directive,
    pending.params,
  );
  pending.projection.approvalEvents.push(
    approvalResolutionExecution(pending.method, pending.params, directive),
  );
  pending.client.resolveServerRequest(pending.requestId, response);
}

function outputFromProjection(
  completed: CodexProjection,
  effectiveUserPrompt: string,
): ContainerOutput {
  const resultText =
    completed.agentMessages.join('\n\n').trim() ||
    completed.textDeltas.join('').trim();
  const toolExecutions = [
    ...completed.toolExecutions,
    ...completed.approvalEvents,
  ];
  if (completed.pendingApproval && !completed.completed) {
    return {
      status: 'success',
      result: completed.pendingApproval.prompt,
      toolsUsed: projectionToolsUsed(completed),
      toolExecutions,
      tokenUsage: completed.tokenUsage,
      pendingApproval: completed.pendingApproval,
      effectiveUserPrompt,
    };
  }
  if (completed.error) {
    return {
      status: 'error',
      result: resultText || null,
      toolsUsed: projectionToolsUsed(completed),
      toolExecutions,
      tokenUsage: completed.tokenUsage,
      error: completed.error,
      effectiveUserPrompt,
    };
  }
  return {
    status: 'success',
    result: resultText || '',
    toolsUsed: projectionToolsUsed(completed),
    toolExecutions,
    tokenUsage: completed.tokenUsage,
    effectiveUserPrompt,
  };
}

function errorOutputFromProjection(
  projection: CodexProjection,
  effectiveUserPrompt: string,
  error: unknown,
): ContainerOutput {
  return {
    status: 'error',
    result: null,
    toolsUsed: projectionToolsUsed(projection),
    toolExecutions: [
      ...projection.toolExecutions,
      ...projection.approvalEvents,
    ],
    tokenUsage: projection.tokenUsage,
    error: error instanceof Error ? error.message : String(error),
    effectiveUserPrompt,
  };
}

export async function resumePendingCodexAppServerApproval(
  params: Pick<
    RunCodexAppServerTurnParams,
    'sessionId' | 'messages' | 'streamTextDeltas' | 'onTextDelta'
  >,
): Promise<ContainerOutput | null> {
  const effectiveUserPrompt = buildCodexTurnText(params.messages);
  const pending = pendingCodexApprovals.get(params.sessionId) ?? null;
  if (!isApprovalForPending(params.sessionId, params.messages, pending)) {
    return null;
  }
  pendingCodexApprovals.delete(params.sessionId);
  const directive = parseApprovalDirective(latestUserText(params.messages));
  if (!directive) return null;
  try {
    respondToCodexApproval(pending, directive);
    const next = await pending.client.waitForCompletionOrApproval();
    if (next.kind === 'approval') {
      pending.projection.pendingApproval = buildPendingApproval(
        next.approvalId,
        next.method,
        next.params,
      );
      pendingCodexApprovals.set(pending.sessionId, {
        approvalId: next.approvalId,
        sessionId: pending.sessionId,
        client: pending.client,
        projection: pending.projection,
        requestId: next.requestId,
        method: next.method,
        params: next.params,
      });
      return outputFromProjection(pending.projection, effectiveUserPrompt);
    }
    const output = outputFromProjection(next.projection, effectiveUserPrompt);
    if (params.streamTextDeltas && output.result && params.onTextDelta) {
      params.onTextDelta(output.result);
    }
    pending.client.close();
    return output;
  } catch (error) {
    pending.client.close();
    return errorOutputFromProjection(
      pending.projection,
      effectiveUserPrompt,
      error,
    );
  }
}

async function checkCodexCliAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('codex', ['--version'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(
          new Error(
            'Codex app-server runtime is selected, but `codex` is not installed or not on PATH. Install the OpenAI Codex CLI and restart the next HybridClaw session, or set `codex.runtime` back to `hybridclaw`.',
          ),
        );
        return;
      }
      reject(error);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Codex app-server runtime is selected, but \`codex --version\` failed with exit code ${code ?? 'null'}.${stderr ? ` ${stderr.trim()}` : ''}`,
        ),
      );
    });
  });
}

async function ensureCodexCliAvailable(): Promise<void> {
  codexCliAvailablePromise ??= checkCodexCliAvailable();
  await codexCliAvailablePromise;
}

export async function runCodexAppServerTurn(
  params: RunCodexAppServerTurnParams,
): Promise<ContainerOutput> {
  await ensureCodexCliAvailable();
  const stalePending = pendingCodexApprovals.get(params.sessionId);
  if (stalePending) {
    stalePending.client.close();
    pendingCodexApprovals.delete(params.sessionId);
  }
  const effectiveUserPrompt = buildCodexTurnText(params.messages);
  const projection = createProjection();
  const client = new CodexAppServerClient(projection, params);
  let keepClientOpen = false;
  try {
    await client.request('initialize', {
      clientInfo: {
        name: 'hybridclaw',
        title: 'HybridClaw',
        version: '0',
      },
      capabilities: { experimentalApi: true },
    });

    const thread = (await client.request('thread/start', {
      model: normalizeCodexModelName(params.model),
      cwd: params.cwd || process.cwd(),
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      baseInstructions: extractSystemInstructions(params.messages),
      developerInstructions:
        'HybridClaw launched this turn through the optional Codex app-server runtime. If a HybridClaw-only tool is unavailable, say that the app-server bridge cannot service it in this mode.',
      ephemeral: true,
      // These event streams are load-bearing for projecting Codex state back into HybridClaw transcripts.
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    })) as Record<string, unknown>;
    const threadRecord = isRecord(thread.thread) ? thread.thread : {};
    projection.threadId = readString(threadRecord, 'id');
    if (!projection.threadId) {
      throw new Error('codex app-server did not return a thread id');
    }
    if (thread.sandbox || thread.permissionProfile) {
      appendToolExecution(projection, {
        name: 'codex.sandbox',
        arguments: JSON.stringify({
          sandbox: thread.sandbox ?? null,
          permissionProfile: thread.permissionProfile ?? null,
        }),
        result: 'sandbox policy active',
        durationMs: 0,
        isError: false,
      });
    }

    const turn = (await client.request('turn/start', {
      threadId: projection.threadId,
      input: buildCodexUserInput(params.messages, effectiveUserPrompt),
      cwd: params.cwd || process.cwd(),
      model: normalizeCodexModelName(params.model),
    })) as Record<string, unknown>;
    const turnRecord = isRecord(turn.turn) ? turn.turn : {};
    if (readString(turnRecord, 'status') === 'completed') {
      projection.completed = true;
    }

    const next = projection.completed
      ? { kind: 'completed' as const, projection }
      : await client.waitForCompletionOrApproval();
    if (next.kind === 'approval') {
      projection.pendingApproval = buildPendingApproval(
        next.approvalId,
        next.method,
        next.params,
      );
      pendingCodexApprovals.set(params.sessionId, {
        approvalId: next.approvalId,
        sessionId: params.sessionId,
        client,
        projection,
        requestId: next.requestId,
        method: next.method,
        params: next.params,
      });
      keepClientOpen = true;
      return outputFromProjection(projection, effectiveUserPrompt);
    }
    const output = outputFromProjection(next.projection, effectiveUserPrompt);
    if (params.streamTextDeltas && output.result && params.onTextDelta) {
      params.onTextDelta(output.result);
    }
    return output;
  } catch (error) {
    return errorOutputFromProjection(projection, effectiveUserPrompt, error);
  } finally {
    if (!keepClientOpen) client.close();
  }
}
