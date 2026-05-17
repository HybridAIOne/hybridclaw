import { estimateAudioTranscriptionCostUsd } from '../../container/shared/audio-transcription-pricing.js';
import {
  readFiniteNumber,
  readString,
} from '../../container/shared/primitive-values.js';
import type { ToolExecution } from '../types/execution.js';
import type { TokenUsageEvent } from './token-usage-buffer.js';

interface MediaUsageEventInput {
  sessionId: string;
  agentId: string;
  auditRunId: string;
  toolExecutions: ToolExecution[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readNonNegativeNumber(value: unknown): number | null {
  const parsed = readFiniteNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function readInteger(value: unknown): number {
  const parsed = readNonNegativeNumber(value);
  return parsed == null ? 0 : Math.max(0, Math.floor(parsed));
}

function readCostUsd(value: unknown): number | undefined {
  const parsed = readNonNegativeNumber(value);
  return parsed == null ? undefined : parsed;
}

function parseToolResult(result: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mediaModelName(provider: string, model: string): string {
  const normalizedModel = model.trim() || 'unknown';
  if (!provider) return normalizedModel;
  return normalizedModel.toLowerCase().startsWith(`${provider}/`)
    ? normalizedModel
    : `${provider}/${normalizedModel}`;
}

function countResultItems(
  payload: Record<string, unknown>,
  key: string,
): number {
  const items = payload[key];
  return Array.isArray(items) ? items.length : 0;
}

function estimateImageGenerationCostUsd(params: {
  provider: string;
  model: string;
  usage: Record<string, unknown>;
  generatedImages: number;
}): number | undefined {
  const explicit = readCostUsd(
    params.usage.cost_usd ??
      params.usage.costUsd ??
      params.usage.estimated_cost_usd ??
      params.usage.estimatedCostUsd,
  );
  if (explicit != null) return explicit;

  const provider = params.provider.toLowerCase();
  const model = params.model.toLowerCase();
  if (provider === 'gemini' && model.includes('3.1-flash-image')) {
    const outputTokens = readNonNegativeNumber(
      params.usage.output_image_tokens ?? params.usage.output_tokens,
    );
    if (outputTokens != null) return (outputTokens * 60) / 1_000_000;
    return params.generatedImages * 0.067;
  }
  if (provider === 'xai') {
    return params.generatedImages * (model.includes('quality') ? 0.04 : 0.02);
  }
  if (provider === 'bfl') {
    return params.generatedImages * (model.includes('max') ? 0.07 : 0.03);
  }
  return undefined;
}

function buildImageUsageEvent(params: {
  sessionId: string;
  agentId: string;
  auditRunId: string;
  payload: Record<string, unknown>;
}): TokenUsageEvent | null {
  if (params.payload.success !== true) return null;
  const provider = readString(params.payload.provider);
  const model = readString(params.payload.model);
  if (!model) return null;
  const usage = isRecord(params.payload.usage) ? params.payload.usage : {};
  const generatedImages =
    readInteger(usage.generated_images) ||
    countResultItems(params.payload, 'images');
  if (generatedImages <= 0) return null;
  const inputTokens = readInteger(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens,
  );
  const outputTokens = readInteger(
    usage.output_tokens ??
      usage.completion_tokens ??
      usage.output_image_tokens ??
      usage.outputTokens,
  );
  const totalTokens =
    readInteger(usage.total_tokens ?? usage.totalTokens) ||
    inputTokens + outputTokens;

  const costUsd = estimateImageGenerationCostUsd({
    provider,
    model,
    usage,
    generatedImages,
  });
  return {
    sessionId: params.sessionId,
    agentId: params.agentId,
    model: mediaModelName(provider, model),
    inputTokens,
    outputTokens,
    totalTokens,
    toolCalls: 0,
    ...(costUsd != null ? { costUsd } : {}),
    auditRunId: params.auditRunId,
  };
}

function buildVideoUsageEvent(params: {
  sessionId: string;
  agentId: string;
  auditRunId: string;
  payload: Record<string, unknown>;
}): TokenUsageEvent | null {
  if (params.payload.success !== true) return null;
  const provider = readString(params.payload.provider);
  const model = readString(params.payload.model);
  if (!model || countResultItems(params.payload, 'videos') <= 0) return null;
  return {
    sessionId: params.sessionId,
    agentId: params.agentId,
    model: mediaModelName(provider, model),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    auditRunId: params.auditRunId,
  };
}

function buildAudioUsageEvent(params: {
  sessionId: string;
  agentId: string;
  auditRunId: string;
  payload: Record<string, unknown>;
}): TokenUsageEvent | null {
  if (params.payload.success !== true) return null;
  const provider = readString(params.payload.provider);
  const model = readString(params.payload.model);
  if (!model) return null;
  const usage = isRecord(params.payload.usage) ? params.payload.usage : {};
  const audioSeconds = readNonNegativeNumber(
    params.payload.duration_sec ??
      params.payload.durationSec ??
      usage.audio_seconds ??
      usage.audioSeconds,
  );
  if (audioSeconds == null) return null;
  const explicitCostUsd = readCostUsd(
    params.payload.cost_usd ?? params.payload.costUsd ?? usage.cost_usd,
  );
  const costUsd =
    explicitCostUsd ??
    estimateAudioTranscriptionCostUsd({
      provider,
      model,
      audioSeconds,
    });
  return {
    sessionId: params.sessionId,
    agentId: params.agentId,
    model: mediaModelName(provider, model),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    ...(costUsd != null ? { costUsd } : {}),
    auditRunId: params.auditRunId,
  };
}

function buildDiagramUsageEvent(params: {
  sessionId: string;
  agentId: string;
  auditRunId: string;
  payload: Record<string, unknown>;
}): TokenUsageEvent | null {
  if (params.payload.success !== true) return null;
  const usage = isRecord(params.payload.usage) ? params.payload.usage : {};
  const renders = readInteger(usage.renders);
  if (renders <= 0) return null;
  const format = readString(params.payload.format) || 'unknown';
  return {
    sessionId: params.sessionId,
    agentId: params.agentId,
    model: `diagram/${format}`,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    costUsd: 0,
    auditRunId: params.auditRunId,
  };
}

export function buildMediaGenerationUsageEvents(
  input: MediaUsageEventInput,
): TokenUsageEvent[] {
  const events: TokenUsageEvent[] = [];
  for (const execution of input.toolExecutions) {
    if (execution.isError || execution.blocked) continue;
    const payload = parseToolResult(execution.result);
    if (!payload) continue;
    const params = {
      sessionId: input.sessionId,
      agentId: input.agentId,
      auditRunId: input.auditRunId,
      payload,
    };
    if (execution.name === 'image_generate') {
      const event = buildImageUsageEvent(params);
      if (event) events.push(event);
    } else if (execution.name === 'audio_transcribe') {
      const event = buildAudioUsageEvent(params);
      if (event) events.push(event);
    } else if (execution.name === 'video_generate') {
      const event = buildVideoUsageEvent(params);
      if (event) events.push(event);
    } else if (
      execution.name === 'diagram_create' ||
      execution.name === 'diagram_update'
    ) {
      const event = buildDiagramUsageEvent(params);
      if (event) events.push(event);
    }
  }
  return events;
}
