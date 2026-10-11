/**
 * Raw UI decision completions use only the supplied context, without agent tools.
 * Auxiliary failures stay failures; the client explicitly chooses whether to
 * advance to the regular model. This module never chooses the resulting label.
 */
import type { ServerResponse } from 'node:http';
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import { resolveModelRuntimeCredentials } from '../providers/factory.js';
import type { ChatMessage } from '../types/api.js';
import { callOpenAICompatibleModel } from './openai-compatible-model.js';
import { OpenAICompatibleRequestError } from './openai-compatible-request.js';
import { buildOpenAICompatibleCompletionResponse } from './openai-compatible-response.js';

// `eval_judge` also reviews warehouse SQL; app UI decisions use `quick_decision`.
const AUXILIARY_DECISION_TASKS = {
  'auxiliary/eval_judge': 'eval_judge',
  'auxiliary/quick_decision': 'quick_decision',
} as const;
type AuxiliaryDecisionModel = keyof typeof AUXILIARY_DECISION_TASKS;

function isAuxiliaryDecisionModel(
  model: string,
): model is AuxiliaryDecisionModel {
  return Object.hasOwn(AUXILIARY_DECISION_TASKS, model);
}

export function isDecisionModel(model: string): boolean {
  return isAuxiliaryDecisionModel(model) || model === 'regular';
}

export async function handleDecisionCompletion(params: {
  res: ServerResponse;
  model: string;
  agentId: string;
  messages: ChatMessage[];
  wantsStream: boolean;
  wantsJsonObject?: boolean;
  completionId: string;
  created: number;
  traceHeaders: Record<string, string>;
}): Promise<void> {
  if (params.wantsStream) {
    throw new OpenAICompatibleRequestError(
      400,
      'Decision completions do not support streaming.',
      { param: 'stream', code: 'unsupported_value' },
    );
  }
  let model: string;
  let content: string | null;
  let provider: string;
  const task = isAuxiliaryDecisionModel(params.model)
    ? AUXILIARY_DECISION_TASKS[params.model]
    : null;
  const resolved = resolveAgentForRequest({ agentId: params.agentId });
  if (task) {
    // An unconfigured task answers with the agent's own model.
    const answer = await callAuxiliaryModel({
      task,
      messages: params.messages,
      fallbackModel: resolved.model,
      fallbackChatbotId: resolved.chatbotId,
      agentId: resolved.agentId,
      temperature: 0,
      allowFallback: false,
      ...(params.wantsJsonObject
        ? { extraBody: { response_format: { type: 'json_object' } } }
        : {}),
    }).catch((error: unknown) => {
      throw new OpenAICompatibleRequestError(
        503,
        error instanceof Error ? error.message : String(error),
        { type: 'server_error', code: 'auxiliary_unavailable' },
      );
    });
    ({ model, content, provider } = answer);
  } else {
    model = resolved.model;
    const runtime = await resolveModelRuntimeCredentials({
      model,
      agentId: resolved.agentId,
      chatbotId: resolved.chatbotId,
    });
    provider = runtime.provider;
    const answer = await callOpenAICompatibleModel({
      runtime,
      model,
      messages: params.messages,
      tools: [],
      toolChoice: 'none',
    });
    const responseContent = answer.choices[0]?.message.content;
    content = typeof responseContent === 'string' ? responseContent : null;
  }
  const payload = buildOpenAICompatibleCompletionResponse({
    completionId: params.completionId,
    created: params.created,
    model,
    content,
  });
  params.res.writeHead(200, {
    ...params.traceHeaders,
    ...(task
      ? {
          'X-HybridClaw-Auxiliary-Task': task,
          'X-HybridClaw-Auxiliary-Provider': provider,
        }
      : {}),
    'Content-Type': 'application/json; charset=utf-8',
  });
  params.res.end(JSON.stringify(payload));
}
