import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { logger } from '../logger.js';
import { getUsageTotals } from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import {
  getAvailableModelList,
  getModelCatalogMetadata,
  normalizeModelCatalogProviderFilter,
  refreshAvailableModelCatalogs,
} from '../providers/model-catalog.js';
import { MODEL_METADATA_USD_TO_EUR } from '../providers/model-metadata.js';
import { formatModelForDisplay } from '../providers/model-names.js';
import {
  isLocalBackendType,
  isRuntimeProviderId,
  type RuntimeProviderId,
} from '../providers/provider-ids.js';
import {
  detectRuntimeProviderPrefix,
  normalizeAuxiliaryProviderModel,
} from '../providers/task-routing.js';
import { scanForLeaks } from '../security/confidential-redact.js';
import {
  createConfidentialRuntimeContext,
  type DehydrateMessageContent,
} from '../security/confidential-runtime.js';
import { estimateTokenCountFromMessages } from '../session/token-efficiency.js';
import type { ChatMessage } from '../types/api.js';
import type { Session, StoredMessage } from '../types/session.js';
import { enqueueTokenUsage } from '../usage/token-usage-buffer.js';

const SECOND_OPINION_CONTEXT_MESSAGE_LIMIT = 8;
const SECOND_OPINION_QUESTION_CHAR_LIMIT = 4000;
const SECOND_OPINION_MODEL_CATALOG_REFRESH_TTL_MS = 60_000;
const SECOND_OPINION_TIMEOUT_MS = 300_000;
const SECOND_OPINION_DEFAULT_MAX_TOKENS = 1200;

export type SecondOpinionMode = 'compare' | 'validate';
type SecondOpinionSynthesisOutcome = 'accepted' | 'rejected' | 'partial';

export interface ParsedSecondOpinionArgs {
  mode: SecondOpinionMode;
  question: string;
  model?: string;
  provider?: RuntimeProviderId;
  maxContextMessages: number;
  includeTranscript: boolean;
}

interface SecondOpinionVerdict {
  revisedAnswer: string;
  verdict: string;
  materialDisagreements: string[];
  missingCaveats: string[];
  confidence: string;
}

interface SecondOpinionTarget {
  provider?: RuntimeProviderId;
  model: string;
  selection: 'requested' | 'configured' | 'default';
}

interface SecondOpinionModelMetadataCheck {
  estimatedInputTokens: number;
  requestedMaxOutputTokens: number;
  estimatedTotalTokens: number;
  contextWindow: number | null;
  pricingKnown: boolean;
  estimatedMaxCostUsd: number | null;
  budgetCheck: SecondOpinionBudgetCheck | null;
}

interface SecondOpinionBudgetCheck {
  unit: 'tokens' | 'USD' | 'EUR';
  cap: number;
  used: number;
  estimatedUsage: number;
  wouldExceed: false;
}

let secondOpinionCatalogRefreshCache: {
  at: number;
  promise: ReturnType<typeof refreshAvailableModelCatalogs>;
} | null = null;

const SECOND_OPINION_BASE_PROMPT = [
  'You are a stronger-model second opinion for HybridClaw.',
  '/no_think',
  'You receive an original user question, the active assistant draft, and optional recent context.',
  'Do not use tools, claim you used tools, or ask follow-up questions.',
  'Do not invent citations or external checks. If live verification would be needed, say so in the revised answer.',
  'Return exactly one JSON object and no prose, markdown, code fences, or hidden reasoning.',
  'JSON shape: {"verdict":"...","revised_answer":"...","material_disagreements":["..."],"missing_caveats":["..."],"confidence":"low|medium|high"}.',
];

const SECOND_OPINION_COMPARE_SYSTEM_PROMPT = [
  ...SECOND_OPINION_BASE_PROMPT,
  'Mode: same-question comparison.',
  'Answer the original question independently first, then compare that independent answer against the active assistant draft.',
  'Synthesize a corrected final answer rather than pasting two answers side by side.',
].join('\n');

const SECOND_OPINION_VALIDATE_SYSTEM_PROMPT = [
  ...SECOND_OPINION_BASE_PROMPT,
  'Mode: draft-answer validation.',
  'Fact-check the active assistant draft against the original question and identify factual issues, reasoning gaps, unsupported assumptions, missing caveats, and risky recommendations.',
  'Synthesize a corrected final answer rather than returning only critique.',
].join('\n');

function normalizeProvider(value: string): RuntimeProviderId | null {
  const normalized = normalizeModelCatalogProviderFilter(value);
  if (!normalized || normalized === 'local') return null;
  return isRuntimeProviderId(normalized) ? normalized : null;
}

function parsePositiveInteger(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function parseSecondOpinionArgs(
  args: string[],
): ParsedSecondOpinionArgs | { error: string } {
  let mode: SecondOpinionMode = 'compare';
  let model = '';
  let provider: RuntimeProviderId | undefined;
  let maxContextMessages = SECOND_OPINION_CONTEXT_MESSAGE_LIMIT;
  let includeTranscript = true;
  const questionParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    const normalized = arg.trim().toLowerCase();
    if (normalized === '--validate-last') {
      mode = 'validate';
      continue;
    }
    if (normalized === '--no-transcript') {
      includeTranscript = false;
      continue;
    }
    if (normalized === '--model') {
      const value = (args[index + 1] || '').trim();
      if (!value || value.startsWith('--')) {
        return { error: 'Missing model for `--model`.' };
      }
      model = value;
      index += 1;
      continue;
    }
    if (normalized === '--provider') {
      const value = (args[index + 1] || '').trim();
      const normalizedProvider = normalizeProvider(value);
      if (!normalizedProvider) {
        return {
          error: `Unknown provider for \`--provider\`: ${value || '(empty)'}.`,
        };
      }
      provider = normalizedProvider;
      index += 1;
      continue;
    }
    if (normalized === '--max-context') {
      const value = (args[index + 1] || '').trim();
      const parsed = parsePositiveInteger(value);
      if (!parsed) {
        return { error: 'Missing positive integer for `--max-context`.' };
      }
      maxContextMessages = Math.min(parsed, 32);
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      return { error: `Unknown second-opinion option: ${arg}.` };
    }
    questionParts.push(arg);
  }

  return {
    mode,
    question: questionParts.join(' ').trim(),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    maxContextMessages,
    includeTranscript,
  };
}

function toContextChatMessage(message: StoredMessage): ChatMessage | null {
  const role =
    message.role === 'user' || message.role === 'assistant'
      ? message.role
      : null;
  if (!role) return null;
  const content = typeof message.content === 'string' ? message.content : '';
  if (!content.trim()) return null;
  return { role, content };
}

function findLastAssistantDraft(messages: StoredMessage[]): {
  draft: StoredMessage | null;
  question: string;
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !message.content.trim()) continue;
    for (let userIndex = index - 1; userIndex >= 0; userIndex -= 1) {
      const userMessage = messages[userIndex];
      if (userMessage?.role === 'user' && userMessage.content.trim()) {
        return { draft: message, question: userMessage.content.trim() };
      }
    }
    return { draft: message, question: '' };
  }
  return { draft: null, question: '' };
}

function providerForModel(model: string): RuntimeProviderId | undefined {
  return detectRuntimeProviderPrefix(model) || undefined;
}

function isLocalSecondOpinionProvider(
  provider: RuntimeProviderId | undefined,
): boolean {
  return Boolean(provider && isLocalBackendType(provider));
}

function validateAvailableTarget(target: SecondOpinionTarget): void {
  if (!target.provider) {
    throw new Error(
      `Second-opinion model "${target.model}" must include a provider prefix or be paired with \`--provider <provider>\`.`,
    );
  }
  const available = getAvailableModelList(target.provider);
  if (!available.includes(target.model)) {
    const source =
      target.selection === 'requested'
        ? 'Requested'
        : target.selection === 'configured'
          ? 'Configured'
          : 'Selected';
    throw new Error(
      `${source} second-opinion model "${target.model}" is not available for provider "${target.provider}". Use \`/model\` to pick an available model or configure \`auxiliaryModels.second_opinion\`.`,
    );
  }
}

function configuredSecondOpinionMaxTokens(): number {
  return (
    getRuntimeConfig().auxiliaryModels.second_opinion.maxTokens ||
    SECOND_OPINION_DEFAULT_MAX_TOKENS
  );
}

function estimateSecondOpinionMaxCostUsd(params: {
  model: string;
  estimatedInputTokens: number;
  requestedMaxOutputTokens: number;
}): Pick<
  SecondOpinionModelMetadataCheck,
  'pricingKnown' | 'estimatedMaxCostUsd'
> {
  const pricing = getModelCatalogMetadata(params.model).pricingUsdPerToken;
  const pricingKnown = pricing.input != null || pricing.output != null;
  if (!pricingKnown) {
    return { pricingKnown: false, estimatedMaxCostUsd: null };
  }
  return {
    pricingKnown: true,
    estimatedMaxCostUsd:
      params.estimatedInputTokens * (pricing.input ?? 0) +
      params.requestedMaxOutputTokens * (pricing.output ?? 0),
  };
}

function convertUsdToBudgetCurrency(
  costUsd: number,
  currency: 'USD' | 'EUR',
): number {
  return currency === 'EUR'
    ? costUsd / MODEL_METADATA_USD_TO_EUR.usdPerEur
    : costUsd;
}

function validateSecondOpinionBudget(params: {
  agentId: string;
  model: string;
  metadataCheck: Omit<SecondOpinionModelMetadataCheck, 'budgetCheck'>;
}): SecondOpinionBudgetCheck | null {
  const budget = (getRuntimeConfig().agents.list || []).find(
    (agent) => agent.id === params.agentId,
  )?.budget;
  if (!budget || budget.cap <= 0) return null;
  const usage = getUsageTotals({ agentId: params.agentId, window: 'monthly' });

  const unit = budget.unit;
  if (unit === 'tokens') {
    const estimatedUsage = params.metadataCheck.estimatedTotalTokens;
    if (usage.total_tokens + estimatedUsage > budget.cap) {
      throw new Error(
        `Second-opinion call is estimated at ${estimatedUsage} tokens, which would exceed the monthly token budget for agent "${params.agentId}" (${usage.total_tokens}/${budget.cap} already used).`,
      );
    }
    return {
      unit,
      cap: budget.cap,
      used: usage.total_tokens,
      estimatedUsage,
      wouldExceed: false,
    };
  }

  if (params.metadataCheck.estimatedMaxCostUsd == null) {
    throw new Error(
      `Second-opinion pricing is unavailable for ${formatModelForDisplay(params.model)}, so the configured ${unit} budget for agent "${params.agentId}" cannot be verified.`,
    );
  }

  const used = convertUsdToBudgetCurrency(
    usage.total_cost_usd,
    budget.currency,
  );
  const estimatedUsage = convertUsdToBudgetCurrency(
    params.metadataCheck.estimatedMaxCostUsd,
    budget.currency,
  );
  if (used + estimatedUsage > budget.cap) {
    throw new Error(
      `Second-opinion call is estimated at ${estimatedUsage.toFixed(4)} ${unit}, which would exceed the monthly ${unit} budget for agent "${params.agentId}" (${used.toFixed(4)}/${budget.cap} already used).`,
    );
  }
  return {
    unit,
    cap: budget.cap,
    used,
    estimatedUsage,
    wouldExceed: false,
  };
}

function validateSecondOpinionModelMetadata(params: {
  model: string;
  agentId: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
}): SecondOpinionModelMetadataCheck {
  const estimatedInputTokens = estimateTokenCountFromMessages(params.messages);
  const requestedMaxOutputTokens = params.maxOutputTokens;
  const estimatedTotalTokens = estimatedInputTokens + requestedMaxOutputTokens;
  const contextWindow = getModelCatalogMetadata(params.model).contextWindow;
  if (contextWindow != null && estimatedTotalTokens > contextWindow) {
    throw new Error(
      `Second-opinion payload is estimated at ${estimatedTotalTokens} tokens, which exceeds the ${contextWindow}-token context window for ${formatModelForDisplay(params.model)}. Reduce --max-context, use --no-transcript, or choose a larger-context model.`,
    );
  }
  const metadataCheck = {
    estimatedInputTokens,
    requestedMaxOutputTokens,
    estimatedTotalTokens,
    contextWindow,
    ...estimateSecondOpinionMaxCostUsd({
      model: params.model,
      estimatedInputTokens,
      requestedMaxOutputTokens,
    }),
  };
  return {
    ...metadataCheck,
    budgetCheck: validateSecondOpinionBudget({
      agentId: params.agentId,
      model: params.model,
      metadataCheck,
    }),
  };
}

async function refreshSecondOpinionModelCatalogs(): Promise<void> {
  const now = Date.now();
  if (
    secondOpinionCatalogRefreshCache &&
    now - secondOpinionCatalogRefreshCache.at <
      SECOND_OPINION_MODEL_CATALOG_REFRESH_TTL_MS
  ) {
    await secondOpinionCatalogRefreshCache.promise;
    return;
  }

  const promise = refreshAvailableModelCatalogs({ includeHybridAI: true });
  secondOpinionCatalogRefreshCache = { at: now, promise };
  try {
    await promise;
  } catch (error) {
    if (secondOpinionCatalogRefreshCache?.promise === promise) {
      secondOpinionCatalogRefreshCache = null;
    }
    throw error;
  }
}

async function resolveSecondOpinionTarget(
  parsed: ParsedSecondOpinionArgs,
): Promise<SecondOpinionTarget> {
  try {
    await refreshSecondOpinionModelCatalogs();
  } catch (error) {
    throw new Error(
      `Could not refresh model catalog for second opinion: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const configured = getRuntimeConfig().auxiliaryModels.second_opinion;
  if (configured.provider === 'disabled' && !parsed.model && !parsed.provider) {
    throw new Error('second_opinion auxiliary model is disabled.');
  }

  const provider =
    parsed.provider ??
    (configured.provider !== 'auto' && configured.provider !== 'disabled'
      ? configured.provider
      : undefined);
  const rawModel = parsed.model || configured.model.trim();
  if (rawModel) {
    const model = provider
      ? normalizeAuxiliaryProviderModel({ provider, model: rawModel })
      : rawModel;
    const target: SecondOpinionTarget = {
      model,
      selection: parsed.model ? 'requested' : 'configured',
      ...((provider ?? providerForModel(model))
        ? { provider: provider ?? providerForModel(model) }
        : {}),
    };
    validateAvailableTarget(target);
    return target;
  }

  const providerForCatalog = provider ?? 'openai-codex';
  const candidates = getAvailableModelList(providerForCatalog);
  const model = candidates[0] || '';
  if (!model) {
    throw new Error(
      `No available ${providerForCatalog} model is configured for second opinion. Use \`--model <provider/model>\` or configure \`auxiliaryModels.second_opinion\`.`,
    );
  }
  return { model, provider: providerForCatalog, selection: 'default' };
}

function buildSecondOpinionMessages(params: {
  mode: SecondOpinionMode;
  question: string;
  draftAnswer: string;
  contextMessages: ChatMessage[];
}): ChatMessage[] {
  const systemPrompt =
    params.mode === 'compare'
      ? SECOND_OPINION_COMPARE_SYSTEM_PROMPT
      : SECOND_OPINION_VALIDATE_SYSTEM_PROMPT;
  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: JSON.stringify({
        mode: params.mode,
        original_question: params.question,
        active_assistant_draft: params.draftAnswer,
        recent_context: params.contextMessages,
      }),
    },
  ];
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start)
      throw new Error('second_opinion response was not JSON.');
    logger.warn(
      { task: 'second_opinion' },
      'Second-opinion response included non-JSON wrapper text; attempting to parse embedded JSON object',
    );
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

export function parseSecondOpinionVerdict(
  content: string,
): SecondOpinionVerdict {
  const parsed = extractJsonObject(content);
  const revisedAnswer = String(
    parsed.revised_answer || parsed.revisedAnswer || '',
  ).trim();
  if (!revisedAnswer) {
    throw new Error('second_opinion response is missing `revised_answer`.');
  }
  const confidence = String(parsed.confidence || 'medium')
    .trim()
    .toLowerCase();
  return {
    revisedAnswer,
    verdict: String(parsed.verdict || '').trim(),
    materialDisagreements: normalizeStringList(parsed.material_disagreements),
    missingCaveats: normalizeStringList(parsed.missing_caveats),
    confidence: ['low', 'medium', 'high'].includes(confidence)
      ? confidence
      : 'medium',
  };
}

function rehydrateVerdict(
  verdict: SecondOpinionVerdict,
  rehydrate: (text: string | null | undefined) => string,
): SecondOpinionVerdict {
  return {
    revisedAnswer: rehydrate(verdict.revisedAnswer),
    verdict: rehydrate(verdict.verdict),
    materialDisagreements: verdict.materialDisagreements.map((item) =>
      rehydrate(item),
    ),
    missingCaveats: verdict.missingCaveats.map((item) => rehydrate(item)),
    confidence: verdict.confidence,
  };
}

function renderVerdict(params: {
  verdict: SecondOpinionVerdict;
  model: string;
  redactionApplied: boolean;
}): string {
  const lines = [
    params.verdict.revisedAnswer.trim(),
    '',
    `Second opinion: ${formatModelForDisplay(params.model)} · confidence: ${params.verdict.confidence}`,
  ];
  if (params.verdict.verdict) {
    lines.push(`Verdict: ${params.verdict.verdict}`);
  }
  if (params.verdict.materialDisagreements.length > 0) {
    lines.push('');
    lines.push('Material disagreements:');
    lines.push(
      ...params.verdict.materialDisagreements.map((item) => `- ${item}`),
    );
  }
  if (params.verdict.missingCaveats.length > 0) {
    lines.push('');
    lines.push('Missing caveats:');
    lines.push(...params.verdict.missingCaveats.map((item) => `- ${item}`));
  }
  if (params.redactionApplied) {
    lines.push('');
    lines.push(
      'Confidential terms were redacted before the second-opinion model call.',
    );
  }
  return lines.join('\n');
}

function truncateQuestionForSecondOpinion(question: string): {
  question: string;
  truncated: boolean;
} {
  if (question.length <= SECOND_OPINION_QUESTION_CHAR_LIMIT) {
    return { question, truncated: false };
  }
  return {
    question: `${question.slice(0, SECOND_OPINION_QUESTION_CHAR_LIMIT)}\n\n[Question truncated to ${SECOND_OPINION_QUESTION_CHAR_LIMIT} characters before the second-opinion model call.]`,
    truncated: true,
  };
}

function normalizeForSynthesisOutcome(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function classifySynthesisOutcome(params: {
  verdict: SecondOpinionVerdict;
  draftAnswer: string;
}): SecondOpinionSynthesisOutcome {
  const hasStrongerFeedback =
    params.verdict.materialDisagreements.length > 0 ||
    params.verdict.missingCaveats.length > 0;
  const revisedChanged =
    normalizeForSynthesisOutcome(params.verdict.revisedAnswer) !==
    normalizeForSynthesisOutcome(params.draftAnswer);

  if (hasStrongerFeedback && revisedChanged) return 'accepted';
  if (!hasStrongerFeedback && !revisedChanged) return 'rejected';
  return 'partial';
}

export async function runSecondOpinionCommand(
  session: Session,
  args: string[],
): Promise<string> {
  const parsed = parseSecondOpinionArgs(args);
  if ('error' in parsed) throw new Error(parsed.error);

  const recentStoredMessages = memoryService.getRecentMessages(
    session.id,
    Math.max(parsed.maxContextMessages, 2),
  );
  const { draft, question: inferredQuestion } =
    findLastAssistantDraft(recentStoredMessages);
  if (!draft) {
    throw new Error(
      'No previous assistant answer found. Ask the question first, then run `second-opinion --validate-last` or `second-opinion <question>`.',
    );
  }
  const rawQuestion = parsed.question || inferredQuestion;
  if (!rawQuestion) {
    throw new Error(
      'No original question found. Pass the question explicitly after `second-opinion`.',
    );
  }
  const { question, truncated: questionTruncated } =
    truncateQuestionForSecondOpinion(rawQuestion);

  const target = await resolveSecondOpinionTarget(parsed);
  const auditProvider =
    target.provider ?? detectRuntimeProviderPrefix(target.model) ?? 'unknown';
  const resolved = resolveAgentForRequest({ session });
  const contextMessages = recentStoredMessages
    .map(toContextChatMessage)
    .filter((message): message is ChatMessage => message !== null);
  const includedContextMessages = parsed.includeTranscript
    ? contextMessages
    : [];
  const confidential = createConfidentialRuntimeContext();
  const messages = buildSecondOpinionMessages({
    mode: parsed.mode,
    question,
    draftAnswer: draft.content,
    contextMessages: includedContextMessages,
  });
  const serializedMessages = JSON.stringify(messages);
  const outboundConfidentialScan =
    confidential.enabled && !isLocalSecondOpinionProvider(target.provider)
      ? scanForLeaks(serializedMessages, confidential.ruleSet)
      : null;
  const hasCriticalConfidentialRule =
    outboundConfidentialScan?.findings.some(
      (finding) => finding.sensitivity === 'critical',
    ) === true;
  if (hasCriticalConfidentialRule) {
    const runId = makeAuditRunId('second-opinion');
    recordAuditEvent({
      sessionId: session.id,
      runId,
      event: {
        type: 'second_opinion.blocked',
        mode: parsed.mode,
        model: target.model,
        provider: auditProvider,
        reason: 'critical_confidential_match',
        redactionApplied: false,
        transcriptIncluded: parsed.includeTranscript,
        questionTruncated,
        confidentialSeverity: outboundConfidentialScan.severity,
        confidentialMatches: outboundConfidentialScan.totalMatches,
      },
    });
    throw new Error(
      'Second opinion blocked: outbound payload matched critical confidential policy for a remote model. Use `--no-transcript`, remove the critical term, or choose a local provider.',
    );
  }
  const dehydratedMessages = confidential.dehydrate(
    messages as DehydrateMessageContent[],
  ) as ChatMessage[];
  const redactionApplied = confidential.mappings.byPlaceholder.size > 0;
  const maxOutputTokens = configuredSecondOpinionMaxTokens();
  const modelMetadataCheck = validateSecondOpinionModelMetadata({
    model: target.model,
    agentId: resolved.agentId,
    messages: dehydratedMessages,
    maxOutputTokens,
  });
  const runId = makeAuditRunId('second-opinion');

  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'second_opinion.requested',
      mode: parsed.mode,
      model: target.model,
      provider: auditProvider,
      redactionApplied,
      transcriptIncluded: parsed.includeTranscript,
      questionTruncated,
      contextMessages: includedContextMessages.length,
      modelMetadataCheck,
      confidentialSeverity: outboundConfidentialScan?.severity ?? null,
      confidentialMatches: outboundConfidentialScan?.totalMatches ?? 0,
    },
  });

  const response = await callAuxiliaryModel({
    task: 'second_opinion',
    messages: dehydratedMessages,
    provider: target.provider,
    model: target.model,
    fallbackModel: resolved.model,
    fallbackChatbotId: resolved.chatbotId,
    agentId: resolved.agentId,
    tools: [],
    maxTokens: maxOutputTokens,
    temperature: 0,
    timeoutMs: SECOND_OPINION_TIMEOUT_MS,
    allowFallback: false,
  });
  // Parse while confidential placeholders are still JSON-safe tokens, then
  // rehydrate only parsed string fields so quoted/newline values cannot break
  // the JSON envelope.
  const verdict = rehydrateVerdict(
    parseSecondOpinionVerdict(response.content),
    confidential.rehydrate,
  );
  const synthesisOutcome = classifySynthesisOutcome({
    verdict,
    draftAnswer: draft.content,
  });
  const estimatedInputTokens =
    response.usage?.inputTokens ?? modelMetadataCheck.estimatedInputTokens;

  enqueueTokenUsage({
    sessionId: session.id,
    agentId: resolved.agentId,
    model: response.model,
    inputTokens: estimatedInputTokens,
    outputTokens: response.usage?.outputTokens ?? 0,
    totalTokens:
      response.usage?.totalTokens ??
      estimatedInputTokens + (response.usage?.outputTokens ?? 0),
    costUsd: response.usage?.costUsd ?? 0,
  });

  recordAuditEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'second_opinion.completed',
      mode: parsed.mode,
      model: response.model,
      provider: response.provider,
      redactionApplied,
      transcriptIncluded: parsed.includeTranscript,
      questionTruncated,
      confidence: verdict.confidence,
      materialDisagreements: verdict.materialDisagreements.length,
      missingCaveats: verdict.missingCaveats.length,
      synthesisOutcome,
      modelMetadataCheck,
      usage: response.usage || null,
    },
  });

  return renderVerdict({
    verdict,
    model: response.model,
    redactionApplied,
  });
}
