/**
 * Raw UI decision completions use only the supplied context, without agent tools.
 * Auxiliary failures stay failures; the client explicitly chooses whether to
 * advance to the regular model. This module never chooses the resulting label.
 */
import type { ServerResponse } from 'node:http';
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { HYBRIDAI_MODEL } from '../config/config.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import { resolveModelRuntimeCredentials } from '../providers/factory.js';
import type { ChatMessage } from '../types/api.js';
import { callOpenAICompatibleModel } from './openai-compatible-model.js';
import { OpenAICompatibleRequestError } from './openai-compatible-request.js';
import { buildOpenAICompatibleCompletionResponse } from './openai-compatible-response.js';

export function isDecisionModel(model: string): boolean {
  return model === 'auxiliary/eval_judge' || model === 'regular';
}

export async function handleDecisionCompletion(params: {
  res: ServerResponse;
  model: string;
  agentId: string;
  messages: ChatMessage[];
  wantsStream: boolean;
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
  if (params.model === 'auxiliary/eval_judge') {
    const answer = await callAuxiliaryModel({
      task: 'eval_judge',
      messages: params.messages,
      fallbackModel: HYBRIDAI_MODEL,
      agentId: params.agentId,
      temperature: 0,
      allowFallback: false,
    });
    ({ model, content, provider } = answer);
  } else {
    const resolved = resolveAgentForRequest({ agentId: params.agentId });
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
    ...(params.model === 'auxiliary/eval_judge'
      ? {
          'X-HybridClaw-Auxiliary-Task': 'eval_judge',
          'X-HybridClaw-Auxiliary-Provider': provider,
        }
      : {}),
    'Content-Type': 'application/json; charset=utf-8',
  });
  params.res.end(JSON.stringify(payload));
}
