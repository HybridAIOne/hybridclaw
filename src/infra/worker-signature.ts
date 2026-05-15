import type { CodexTurnRuntime } from '../config/runtime-config.js';
import type { ProviderCredentials } from '../types/container.js';
import { TASK_MODEL_KEYS, type TaskModelKey } from '../types/models.js';

interface WorkerSignatureTaskModel {
  provider?: string;
  providerMethod?: string;
  baseUrl?: string;
  apiKey?: string;
  requestHeaders?: Record<string, string>;
  isLocal?: boolean;
  contextWindow?: number;
  thinkingFormat?: string;
  model: string;
  chatbotId?: string;
  maxTokens?: number;
  error?: string;
}

export interface WorkerSignatureInput {
  agentId: string;
  provider: string | undefined;
  providerMethod?: string;
  codexRuntime?: CodexTurnRuntime;
  baseUrl: string;
  apiKey: string;
  requestHeaders: Record<string, string> | undefined;
  browserProvider?: string;
  taskModels?: Partial<Record<TaskModelKey, WorkerSignatureTaskModel>>;
  providerCredentials?: ProviderCredentials;
  workspacePathOverride?: string;
  workspaceDisplayRootOverride?: string;
  bashProxy?:
    | {
        mode: 'docker-exec';
        containerName: string;
        cwd?: string;
      }
    | undefined;
}

function normalizeHeaders(
  headers: Record<string, string> | undefined,
): Array<[string, string]> {
  return Object.entries(headers || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value]);
}

function normalizeTaskModel(
  input: WorkerSignatureTaskModel | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;

  return {
    provider: String(input.provider || '').trim(),
    providerMethod: String(input.providerMethod || '').trim(),
    baseUrl: String(input.baseUrl || '')
      .trim()
      .replace(/\/+$/g, ''),
    apiKey: String(input.apiKey || ''),
    requestHeaders: normalizeHeaders(input.requestHeaders),
    isLocal: input.isLocal === true,
    contextWindow:
      typeof input.contextWindow === 'number' ? input.contextWindow : null,
    thinkingFormat: String(input.thinkingFormat || '').trim(),
    model: String(input.model || '').trim(),
    chatbotId: String(input.chatbotId || '').trim(),
    maxTokens:
      typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens)
        ? Math.floor(input.maxTokens)
        : null,
    error: String(input.error || '').trim(),
  };
}

function normalizeProviderCredentials(
  credentials: ProviderCredentials | undefined,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  if (credentials?.speechToText) {
    normalized.speechToText = {
      defaultProvider: String(credentials.speechToText.defaultProvider || '')
        .trim()
        .toLowerCase(),
    };
  }
  for (const provider of [
    'openai',
    'gemini',
    'xai',
    'bfl',
    'deepgram',
    'assemblyai',
  ] as const) {
    const credential = credentials?.[provider];
    if (!credential) continue;
    normalized[provider] = {
      apiKey: String(credential.apiKey || ''),
      baseUrl: String(credential.baseUrl || '')
        .trim()
        .replace(/\/+$/g, ''),
      audioModel: String(credential.audioModel || '').trim(),
      imageModel: String(credential.imageModel || '').trim(),
      videoModel: String(credential.videoModel || '').trim(),
    };
  }
  return normalized;
}

export function computeWorkerSignature(input: WorkerSignatureInput): string {
  const normalizedHeaders = normalizeHeaders(input.requestHeaders);
  const taskModels = Object.fromEntries(
    TASK_MODEL_KEYS.map((key) => [
      key,
      normalizeTaskModel(input.taskModels?.[key]),
    ]),
  );

  return JSON.stringify({
    agentId: String(input.agentId || '').trim(),
    provider: String(input.provider || '').trim(),
    providerMethod: String(input.providerMethod || '').trim(),
    codexRuntime: String(input.codexRuntime || '').trim(),
    baseUrl: String(input.baseUrl || '')
      .trim()
      .replace(/\/+$/g, ''),
    apiKey: String(input.apiKey || ''),
    requestHeaders: normalizedHeaders,
    browserProvider: String(input.browserProvider || '').trim(),
    taskModels,
    providerCredentials: normalizeProviderCredentials(
      input.providerCredentials,
    ),
    workspacePathOverride: String(input.workspacePathOverride || '').trim(),
    workspaceDisplayRootOverride: String(
      input.workspaceDisplayRootOverride || '',
    ).trim(),
    bashProxy:
      input.bashProxy?.mode === 'docker-exec'
        ? {
            mode: 'docker-exec',
            containerName: String(input.bashProxy.containerName || '').trim(),
            cwd: String(input.bashProxy.cwd || '').trim(),
          }
        : null,
  });
}
