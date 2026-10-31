/**
 * Denials never execute a call or grant consent. A first shell safety block
 * permits one replan that omits prohibited effects; all new calls face policy.
 * Unlike approval-reply, this cannot resolve a pending human decision.
 */
import type { ToolApprovalEvaluation } from './approval-policy.js';
import { BASH_SAFETY_ACTION_KEY } from './bash-safety.js';
import { statusOutputPresentation } from './chat-segments.js';
import { emitRuntimeEvent } from './extensions.js';
import { finalizeTokenUsage } from './token-usage.js';
import { buildApprovalDeniedToolExecution } from './tool-approval.js';
import type {
  ArtifactMetadata,
  ChatMessage,
  ContainerOutput,
  TokenUsageStats,
  ToolCall,
  ToolExecution,
} from './types.js';

export function canReplanAfterDenial(
  approval: ToolApprovalEvaluation,
  executions: ToolExecution[],
): boolean {
  // One replan (Codex choice, 2026-10-31, following the owner's autonomy
  // request): omit optional blocked work; repeated policy negotiation deferred.
  return (
    approval.decision === 'denied' &&
    approval.actionKey === BASH_SAFETY_ACTION_KEY &&
    !executions.some(
      (entry) => entry.approvalActionKey === BASH_SAFETY_ACTION_KEY,
    )
  );
}

export async function handleToolDenial(params: {
  approval: ToolApprovalEvaluation;
  unrunCalls: ToolCall[];
  history: ChatMessage[];
  recordResult: (message: ChatMessage) => ChatMessage;
  toolExecutions: ToolExecution[];
  toolsUsed: string[];
  artifacts: ArtifactMetadata[];
  tokenUsage: TokenUsageStats;
  effectiveUserPrompt: string;
}): Promise<ContainerOutput | null> {
  const { approval, toolExecutions } = params;
  const call = params.unrunCalls[0];
  const replan = canReplanAfterDenial(approval, toolExecutions);
  const denialText = `Approval denied: ${approval.reason}`;
  toolExecutions.push(
    buildApprovalDeniedToolExecution({
      toolName: call.function.name,
      argsJson: call.function.arguments,
      denialText,
      approval,
    }),
  );
  if (replan) {
    for (const unrun of params.unrunCalls) {
      const content =
        unrun === call
          ? `${denialText}\nNothing in this command ran. Continue the original task only if you can omit the prohibited effects and complete permitted work. Do not repeat this command or reproduce the blocked effects through another tool. Leave optional cleanup undone; explain a blocker only if it prevents the requested result.`
          : 'Not executed because an earlier call was blocked. Reconsider this step when replanning.';
      params.history.push(
        params.recordResult({
          role: 'tool',
          tool_call_id: unrun.id,
          content,
          is_error: true,
        }),
      );
      if (unrun !== call)
        toolExecutions.push({
          name: unrun.function.name,
          arguments: unrun.function.arguments,
          result: content,
          durationMs: 0,
          isError: true,
          blocked: true,
          blockedReason: 'Not executed while replanning after a blocked call.',
        });
    }
    return null;
  }
  const output: ContainerOutput = {
    status: 'success',
    result: denialText,
    toolsUsed: [...new Set(params.toolsUsed)],
    outputPresentation: statusOutputPresentation(true),
    ...(params.artifacts.length ? { artifacts: params.artifacts } : {}),
    toolExecutions,
    tokenUsage: finalizeTokenUsage(params.tokenUsage),
    effectiveUserPrompt: params.effectiveUserPrompt,
  };
  await emitRuntimeEvent({
    event: 'turn_end',
    status: output.status,
    toolsUsed: output.toolsUsed,
  });
  return output;
}
