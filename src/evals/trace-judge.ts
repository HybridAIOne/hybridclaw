import { recordUsageEvent } from '../memory/db.js';
import {
  type AuxiliaryModelUsage,
  callAuxiliaryModel,
} from '../providers/auxiliary.js';
import {
  dedupeExplicitModelNames,
  getModelCatalogMetadata,
  type ModelCapabilityRequirements,
  refreshAvailableModelCatalogs,
  selectModelsByCapabilityAndCost,
} from '../providers/model-catalog.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from '../session/token-efficiency.js';
import type { ChatMessage } from '../types/api.js';

export type JudgeTraceVerdict = 'pass' | 'partial' | 'fail';

export interface JudgeTraceResult {
  score: number;
  reasoning: string;
  verdict: JudgeTraceVerdict;
}

export interface JudgeTraceUsageContext {
  sessionId: string;
  agentId: string;
  timestamp?: string;
}

export interface JudgeTraceModelCallParams {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

export interface JudgeTraceModelCallResponse {
  content: string;
  model?: string;
  usage?: AuxiliaryModelUsage | null;
}

export interface JudgeTraceOptions {
  model?: string;
  fallbackModels?: string[];
  capabilities?: ModelCapabilityRequirements;
  usageContext?: JudgeTraceUsageContext;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  refreshCatalog?: boolean;
  modelCaller?: (
    params: JudgeTraceModelCallParams,
  ) => Promise<JudgeTraceModelCallResponse>;
}

const DEFAULT_JUDGE_CAPABILITIES: ModelCapabilityRequirements = {
  jsonMode: true,
};
const DEFAULT_JUDGE_MAX_TOKENS = 800;
const DEFAULT_JUDGE_TIMEOUT_MS = 45_000;

function serializeJudgeInput(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || '').trim();
  }
}

function buildJudgeMessages(trace: unknown, criteria: unknown): ChatMessage[] {
  const criteriaText = serializeJudgeInput(criteria);
  const traceText = serializeJudgeInput(trace);
  if (!criteriaText) throw new Error('Judge criteria are required.');
  if (!traceText) throw new Error('Judge trace is required.');

  return [
    {
      role: 'system',
      content: [
        'You are a strict trace judge.',
        'Return only a JSON object with keys: score, reasoning, verdict.',
        'score must be a number from 0 to 1.',
        'verdict must be one of: pass, partial, fail.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        'Criteria:',
        criteriaText,
        '',
        'Trace:',
        traceText,
        '',
        'Judge the trace against the criteria.',
      ].join('\n'),
    },
  ];
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Judge model returned an empty response.');
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Continue with fenced/embedded JSON extraction below.
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim()) as Record<string, unknown>;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
  throw new Error('Judge model did not return a JSON object.');
}

function normalizeScore(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('Judge model returned a non-numeric score.');
  }
  return Math.max(0, Math.min(1, parsed));
}

function fallbackVerdict(score: number): JudgeTraceVerdict {
  if (score >= 0.75) return 'pass';
  if (score >= 0.4) return 'partial';
  return 'fail';
}

function normalizeVerdict(value: unknown, score: number): JudgeTraceVerdict {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (
    normalized === 'pass' ||
    normalized === 'partial' ||
    normalized === 'fail'
  ) {
    return normalized;
  }
  return fallbackVerdict(score);
}

function parseJudgeResult(content: string): JudgeTraceResult {
  const payload = extractJsonObject(content);
  const score = normalizeScore(payload.score);
  const reasoning = String(payload.reasoning || '').trim();
  if (!reasoning) {
    throw new Error('Judge model returned empty reasoning.');
  }
  return {
    score,
    reasoning,
    verdict: normalizeVerdict(payload.verdict, score),
  };
}

function readUsageNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function estimateJudgeUsage(params: {
  messages: ChatMessage[];
  content: string;
  usage?: AuxiliaryModelUsage | null;
}): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
} {
  const usage = params.usage;
  const inputTokens =
    readUsageNumber(usage?.inputTokens) ??
    estimateTokenCountFromMessages(params.messages);
  const outputTokens =
    readUsageNumber(usage?.outputTokens) ??
    estimateTokenCountFromText(params.content);
  const totalTokens =
    readUsageNumber(usage?.totalTokens) ?? inputTokens + outputTokens;
  const costUsd = readUsageNumber(usage?.costUsd);

  return {
    inputTokens: Math.floor(inputTokens),
    outputTokens: Math.floor(outputTokens),
    totalTokens: Math.floor(totalTokens),
    costUsd,
  };
}

function estimateCatalogCostUsd(params: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): number {
  const pricing = getModelCatalogMetadata(params.model).pricingUsdPerToken;
  return (
    params.inputTokens * (pricing.input ?? 0) +
    params.outputTokens * (pricing.output ?? 0)
  );
}

async function defaultJudgeModelCaller(
  params: JudgeTraceModelCallParams,
): Promise<JudgeTraceModelCallResponse> {
  const response = await callAuxiliaryModel({
    task: 'mcp',
    messages: params.messages,
    model: params.model,
    maxTokens: params.maxTokens,
    temperature: params.temperature,
    timeoutMs: params.timeoutMs,
    extraBody: {
      response_format: { type: 'json_object' },
    },
  });
  return {
    content: response.content,
    model: response.model,
    usage: response.usage,
  };
}

async function buildJudgeModelChain(
  options: JudgeTraceOptions,
): Promise<string[]> {
  if (options.refreshCatalog === true) {
    await refreshAvailableModelCatalogs({ includeHybridAI: true });
  }
  const explicitModels = dedupeExplicitModelNames([
    options.model,
    ...(options.fallbackModels || []),
  ]);
  const catalogModels = selectModelsByCapabilityAndCost(
    options.capabilities || DEFAULT_JUDGE_CAPABILITIES,
    {
      excludeModels: explicitModels,
    },
  ).map((selection) => selection.model);
  return dedupeExplicitModelNames([...explicitModels, ...catalogModels]);
}

function recordJudgeUsage(params: {
  context: JudgeTraceUsageContext | undefined;
  model: string;
  messages: ChatMessage[];
  content: string;
  usage?: AuxiliaryModelUsage | null;
}): void {
  if (!params.context) return;
  const usage = estimateJudgeUsage({
    messages: params.messages,
    content: params.content,
    usage: params.usage,
  });
  const costUsd =
    usage.costUsd ??
    estimateCatalogCostUsd({
      model: params.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

  recordUsageEvent({
    sessionId: params.context.sessionId,
    agentId: params.context.agentId,
    model: params.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    costUsd,
    timestamp: params.context.timestamp,
  });
}

export async function judgeTrace(
  trace: unknown,
  criteria: unknown,
  options: JudgeTraceOptions = {},
): Promise<JudgeTraceResult> {
  const messages = buildJudgeMessages(trace, criteria);
  const models = await buildJudgeModelChain(options);
  if (models.length === 0) {
    throw new Error(
      'No judge model is available for the required capabilities.',
    );
  }

  const modelCaller = options.modelCaller || defaultJudgeModelCaller;
  const failures: string[] = [];
  for (const model of models) {
    try {
      const response = await modelCaller({
        model,
        messages,
        maxTokens: options.maxTokens ?? DEFAULT_JUDGE_MAX_TOKENS,
        temperature: options.temperature ?? 0,
        timeoutMs: options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
      });
      const result = parseJudgeResult(response.content);
      recordJudgeUsage({
        context: options.usageContext,
        model: response.model?.trim() || model,
        messages,
        content: response.content,
        usage: response.usage,
      });
      return result;
    } catch (err) {
      failures.push(
        `${model}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new Error(
    `Judge trace failed for all fallback models: ${failures.join('; ')}`,
  );
}
