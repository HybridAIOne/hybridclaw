/**
 * Runs one routed turn: provider fallback within a rung, one same-rung retry
 * for weak output, then escalation to the next rung.
 *
 * Only a retry-safe attempt is run again. An attempt that reported a tool,
 * returned tool executions, or stopped at an approval may have applied effects,
 * so it is final whether it returns or throws; another run would repeat them.
 *
 * NOT the ladder or tier choice (`providers/model-routing.ts`,
 * `routing/policy.ts`).
 */
import { isSilentReply } from '../agent/silent-reply.js';
import { resolveModelRuntimeCredentials } from '../providers/factory.js';
import type {
  ResolvedLadder,
  ResolvedModelRoutingTier,
} from '../providers/model-routing.js';
import type { ResolvedModelRuntimeCredentials } from '../providers/types.js';
import type { ContainerOutput } from '../types/container.js';
import {
  callWithProviderFallback,
  classifyProviderError,
  type FallbackReason,
} from './provider-fallback.js';

export type ModelRoutingEscalationTrigger =
  | 'provider_auth'
  | 'provider_rate_limit'
  | 'provider_server_error'
  | 'malformed_tool_call'
  | 'empty_output'
  | 'narrate_only';

export interface ModelRoutingAttempt {
  tier: string;
  model: string;
  output: ContainerOutput;
  durationMs: number;
  routeReason: string;
  escalated: boolean;
}

export interface ModelRoutingEscalationEvent {
  fromTier: string;
  toTier: string;
  reason: ModelRoutingEscalationTrigger;
}

export interface ModelRoutingExecutionResult {
  output: ContainerOutput;
  model: string;
  tier: string;
  attempts: ModelRoutingAttempt[];
  escalated: boolean;
}

interface ExecuteModelRoutingParams {
  ladder: ResolvedLadder;
  agentId: string;
  chatbotId?: string;
  /** Must call `markToolStarted` when the attempt reports a tool. */
  invoke: (
    runtime: ResolvedModelRuntimeCredentials,
    model: string,
    markToolStarted: () => void,
  ) => Promise<ContainerOutput>;
  onEscalation?: (event: ModelRoutingEscalationEvent) => void;
  resolveRuntime?: typeof resolveModelRuntimeCredentials;
}

class RoutingAttemptError extends Error {
  constructor(
    message: string,
    readonly trigger: ModelRoutingEscalationTrigger,
    readonly output: ContainerOutput,
  ) {
    super(message);
    this.name = 'RoutingAttemptError';
  }
}

const MALFORMED_TOOL_CALL_RE =
  /malformed tool (?:arguments|call)|invalid tool (?:arguments|call)|tool call.*(?:malformed|invalid)/i;
const EMPTY_OUTPUT_RE =
  /empty completion|empty response|no response from api|without visible text or tool calls/i;
const NARRATE_ONLY_RE =
  /^(?:sure[,!.]?\s*)?(?:i(?:'ll| will|'m going to)|let me)\s+(?:look|check|investigate|work|start|review|analy[sz]e|handle|take care|do|prepare|create|build|fix|update|implement)\b[^\n]{0,360}$/i;

function providerTrigger(
  reason: FallbackReason,
): ModelRoutingEscalationTrigger | null {
  if (reason === 'auth') return 'provider_auth';
  if (reason === 'rate_limit') return 'provider_rate_limit';
  if (reason === 'server_error') return 'provider_server_error';
  return null;
}

function isRetrySafe(output: ContainerOutput): boolean {
  return !output.pendingApproval && (output.toolExecutions?.length ?? 0) === 0;
}

export function classifyModelRoutingOutput(
  output: ContainerOutput,
): ModelRoutingEscalationTrigger | null {
  if (!isRetrySafe(output)) return null;
  const error = String(output.error || '').trim();
  if (MALFORMED_TOOL_CALL_RE.test(error)) return 'malformed_tool_call';
  if (error) {
    const trigger = providerTrigger(classifyProviderError(error));
    if (trigger) return trigger;
  }
  if (EMPTY_OUTPUT_RE.test(error)) return 'empty_output';
  if (output.status !== 'success') return null;
  const result = String(output.result || '').trim();
  if (!result) {
    return (output.artifacts?.length ?? 0) > 0 ? null : 'empty_output';
  }
  if (isSilentReply(result)) return null;
  return NARRATE_ONLY_RE.test(result) ? 'narrate_only' : null;
}

function routeErrorMessage(
  output: ContainerOutput,
  trigger: ModelRoutingEscalationTrigger,
): string {
  return (
    String(output.error || '').trim() || `Model routing trigger: ${trigger}`
  );
}

function tierFallbackChain(
  tier: ResolvedModelRoutingTier,
  agentId: string,
  chatbotId?: string,
) {
  return tier.models.slice(1).map((model) => ({
    model,
    agentId,
    ...(chatbotId ? { chatbotId } : {}),
  }));
}

export async function executeModelRouting(
  params: ExecuteModelRoutingParams,
): Promise<ModelRoutingExecutionResult> {
  const tiers = params.ladder.tiers.slice(params.ladder.startIndex);
  if (!params.ladder.enabled || params.ladder.exhausted || tiers.length === 0) {
    throw new Error('Model routing execution requires a non-empty ladder.');
  }
  const resolveRuntime =
    params.resolveRuntime ?? resolveModelRuntimeCredentials;
  const attempts: ModelRoutingAttempt[] = [];
  let lastOutput: ContainerOutput | null = null;
  let lastModel = tiers[0]?.models[0] || '';
  // Covers what `isRetrySafe` cannot see: a thrown attempt, or an output that
  // omits the executions of tools it reported.
  let toolStarted = false;
  const markToolStarted = (): void => {
    toolStarted = true;
  };

  for (let tierOffset = 0; tierOffset < tiers.length; tierOffset += 1) {
    const tier = tiers[tierOffset];
    if (!tier?.models[0]) continue;
    const primaryModel = tier.models[0];
    let weakOutputRetried = false;
    let nextAttemptReason =
      tierOffset === 0 ? params.ladder.reason : 'tier-escalation';
    let tierTrigger: ModelRoutingEscalationTrigger | null = null;

    try {
      const primaryRuntime = await resolveRuntime({
        model: primaryModel,
        agentId: params.agentId,
        ...(params.chatbotId ? { chatbotId: params.chatbotId } : {}),
      });
      const output = await callWithProviderFallback({
        primaryRuntime,
        primaryModel,
        chain: tierFallbackChain(tier, params.agentId, params.chatbotId),
        shouldFallback: () => !toolStarted,
        onFallback: (_activation, reason) => {
          nextAttemptReason = `provider_${reason}`;
        },
        invoke: async (runtime, model) => {
          for (;;) {
            const startedAt = Date.now();
            const attemptOutput = await params.invoke(
              runtime,
              model,
              markToolStarted,
            );
            const trigger = toolStarted
              ? null
              : classifyModelRoutingOutput(attemptOutput);
            attempts.push({
              tier: tier.name,
              model,
              output: attemptOutput,
              durationMs: Date.now() - startedAt,
              routeReason: nextAttemptReason,
              escalated: tierOffset > 0,
            });
            lastOutput = attemptOutput;
            lastModel = model;
            if (!trigger) return attemptOutput;
            tierTrigger = trigger;
            if (
              (trigger === 'empty_output' || trigger === 'narrate_only') &&
              !weakOutputRetried
            ) {
              weakOutputRetried = true;
              nextAttemptReason = `${trigger}_retry`;
              continue;
            }
            throw new RoutingAttemptError(
              routeErrorMessage(attemptOutput, trigger),
              trigger,
              attemptOutput,
            );
          }
        },
      });
      return {
        output,
        model: lastModel,
        tier: tier.name,
        attempts,
        escalated: tierOffset > 0,
      };
    } catch (error) {
      if (toolStarted) throw error;
      if (error instanceof RoutingAttemptError) {
        tierTrigger = error.trigger;
      } else {
        tierTrigger = providerTrigger(classifyProviderError(error));
      }
      const nextTier = tiers[tierOffset + 1];
      if (!tierTrigger || !nextTier) {
        if (lastOutput) {
          return {
            output: lastOutput,
            model: lastModel,
            tier: tier.name,
            attempts,
            escalated: tierOffset > 0,
          };
        }
        throw error;
      }
      params.onEscalation?.({
        fromTier: tier.name,
        toTier: nextTier.name,
        reason: tierTrigger,
      });
    }
  }
  if (!lastOutput)
    throw new Error('Model routing exhausted without an attempt.');
  return {
    output: lastOutput,
    model: lastModel,
    tier: tiers.at(-1)?.name || '',
    attempts,
    escalated: tiers.length > 1,
  };
}
