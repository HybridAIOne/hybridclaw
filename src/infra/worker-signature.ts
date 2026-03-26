import { TASK_MODEL_KEYS, type TaskModelKey } from '../types/container.js';

interface WorkerSignatureTaskModel {
  provider?: string;
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
  baseUrl: string;
  apiKey: string;
  requestHeaders: Record<string, string> | undefined;
  taskModels?: Partial<Record<TaskModelKey, WorkerSignatureTaskModel>>;
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
    baseUrl: String(input.baseUrl || '')
      .trim()
      .replace(/\/+$/g, ''),
    apiKey: String(input.apiKey || ''),
    requestHeaders: normalizedHeaders,
    taskModels,
  });
}
