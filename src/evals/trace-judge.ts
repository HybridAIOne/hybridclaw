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
import { formatModelForDisplay } from '../providers/model-names.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from '../session/token-efficiency.js';
import type { ChatMessage } from '../types/api.js';
import {
  prepareTraceJudgePrompt,
  type TracePreparationOptions,
} from './trace-preparation.js';

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
  tracePreparation?: TracePreparationOptions;
  maxInputChars?: number;
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
const DEFAULT_MAX_JUDGE_INPUT_CHARS = 120_000;

function normalizeMaxInputChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_JUDGE_INPUT_CHARS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Judge maxInputChars must be a positive number.');
  }
  return Math.floor(value);
}

function assertJudgeInputWithinLimit(params: {
  criteriaText: string;
  traceText: string;
  maxInputChars: number;
}): void {
  const totalChars = params.criteriaText.length + params.traceText.length;
  if (totalChars <= params.maxInputChars) return;
  throw new Error(
    [
      `Judge input is too large: ${totalChars} serialized characters.`,
      `Limit: ${params.maxInputChars}.`,
      `Criteria: ${params.criteriaText.length}.`,
      `Trace: ${params.traceText.length}.`,
      'Reduce the trace or pass a higher maxInputChars option.',
    ].join(' '),
  );
}

function buildJudgeMessages(
  trace: unknown,
  criteria: unknown,
  options: Pick<JudgeTraceOptions, 'maxInputChars' | 'tracePreparation'> = {},
): ChatMessage[] {
  const prepared = prepareTraceJudgePrompt(
    trace,
    criteria,
    options.tracePreparation ?? {},
  );
  assertJudgeInputWithinLimit({
    criteriaText: prepared.criteriaText,
    traceText: prepared.traceText,
    maxInputChars: normalizeMaxInputChars(options.maxInputChars),
  });
  return prepared.messages;
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
    task: 'eval_judge',
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

function dedupeJudgeModels(models: Array<string | null | undefined>): string[] {
  const byCatalogIdentity = new Map<string, string>();
  for (const model of dedupeExplicitModelNames(models)) {
    const key = formatModelForDisplay(model);
    if (!byCatalogIdentity.has(key)) byCatalogIdentity.set(key, model);
  }
  return [...byCatalogIdentity.values()];
}

async function buildJudgeModelChain(
  options: JudgeTraceOptions,
): Promise<string[]> {
  const explicitModels = dedupeJudgeModels([
    options.model,
    ...(options.fallbackModels || []),
  ]);
  if (options.refreshCatalog === true) {
    const refreshResult = await refreshAvailableModelCatalogs({
      includeHybridAI: true,
    });
    if (
      explicitModels.length === 0 &&
      refreshResult.discoveredModelCount === 0
    ) {
      const failedProviders = refreshResult.failures
        .map((failure) => `${failure.provider} (${failure.error})`)
        .join(', ');
      throw new Error(
        [
          'No judge model is available after catalog refresh.',
          'The refresh returned no discovered models.',
          failedProviders ? `Failed providers: ${failedProviders}.` : '',
          'Pass an explicit judge model or configure a model catalog provider.',
        ]
          .filter(Boolean)
          .join(' '),
      );
    }
  }
  const catalogModels = selectModelsByCapabilityAndCost(
    options.capabilities || DEFAULT_JUDGE_CAPABILITIES,
    {
      excludeModels: dedupeExplicitModelNames([
        ...explicitModels,
        ...explicitModels.map(formatModelForDisplay),
      ]),
    },
  ).map((selection) => selection.model);
  return dedupeJudgeModels([...explicitModels, ...catalogModels]);
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
  const messages = buildJudgeMessages(trace, criteria, options);
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
      recordJudgeUsage({
        context: options.usageContext,
        model: formatModelForDisplay(response.model?.trim() || model),
        messages,
        content: response.content,
        usage: response.usage,
      });
      const result = parseJudgeResult(response.content);
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
