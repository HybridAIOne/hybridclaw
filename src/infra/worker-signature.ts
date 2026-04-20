import type { ContentToolConfig } from '../types/container.js';
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
  baseUrl: string;
  apiKey: string;
  requestHeaders: Record<string, string> | undefined;
  taskModels?: Partial<Record<TaskModelKey, WorkerSignatureTaskModel>>;
  contentTools?: ContentToolConfig;
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

function normalizeContentTools(
  contentTools: ContentToolConfig | undefined,
): Record<string, unknown> {
  return {
    imageGeneration: {
      apiKey: String(contentTools?.imageGeneration.apiKey || ''),
      baseUrl: String(contentTools?.imageGeneration.baseUrl || '')
        .trim()
        .replace(/\/+$/g, ''),
      defaultModel: String(
        contentTools?.imageGeneration.defaultModel || '',
      ).trim(),
      defaultCount:
        typeof contentTools?.imageGeneration.defaultCount === 'number'
          ? Math.floor(contentTools.imageGeneration.defaultCount)
          : null,
      defaultAspectRatio: String(
        contentTools?.imageGeneration.defaultAspectRatio || '',
      ).trim(),
      defaultResolution: String(
        contentTools?.imageGeneration.defaultResolution || '',
      ).trim(),
      defaultOutputFormat: String(
        contentTools?.imageGeneration.defaultOutputFormat || '',
      ).trim(),
      timeoutMs:
        typeof contentTools?.imageGeneration.timeoutMs === 'number'
          ? Math.floor(contentTools.imageGeneration.timeoutMs)
          : null,
    },
    speech: {
      apiKey: String(contentTools?.speech.apiKey || ''),
      baseUrl: String(contentTools?.speech.baseUrl || '')
        .trim()
        .replace(/\/+$/g, ''),
      defaultModel: String(contentTools?.speech.defaultModel || '').trim(),
      defaultVoice: String(contentTools?.speech.defaultVoice || '').trim(),
      defaultOutputFormat: String(
        contentTools?.speech.defaultOutputFormat || '',
      ).trim(),
      defaultSpeed:
        typeof contentTools?.speech.defaultSpeed === 'number' &&
        Number.isFinite(contentTools.speech.defaultSpeed)
          ? contentTools.speech.defaultSpeed
          : null,
      maxChars:
        typeof contentTools?.speech.maxChars === 'number'
          ? Math.floor(contentTools.speech.maxChars)
          : null,
      timeoutMs:
        typeof contentTools?.speech.timeoutMs === 'number'
          ? Math.floor(contentTools.speech.timeoutMs)
          : null,
    },
    transcription: {
      apiKey: String(contentTools?.transcription.apiKey || ''),
      baseUrl: String(contentTools?.transcription.baseUrl || '')
        .trim()
        .replace(/\/+$/g, ''),
      defaultModel: String(
        contentTools?.transcription.defaultModel || '',
      ).trim(),
      defaultLanguage: String(
        contentTools?.transcription.defaultLanguage || '',
      ).trim(),
      defaultPrompt: String(
        contentTools?.transcription.defaultPrompt || '',
      ).trim(),
      maxBytes:
        typeof contentTools?.transcription.maxBytes === 'number'
          ? Math.floor(contentTools.transcription.maxBytes)
          : null,
      timeoutMs:
        typeof contentTools?.transcription.timeoutMs === 'number'
          ? Math.floor(contentTools.transcription.timeoutMs)
          : null,
    },
  };
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
    baseUrl: String(input.baseUrl || '')
      .trim()
      .replace(/\/+$/g, ''),
    apiKey: String(input.apiKey || ''),
    requestHeaders: normalizedHeaders,
    taskModels,
    contentTools: normalizeContentTools(input.contentTools),
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
