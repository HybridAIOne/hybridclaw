/**
 * Denials never execute a call or grant consent. Shell/network blocks share
 * one replan per turn; file-preservation rejections have per-action recovery.
 * A full-auto conflict refusal can replan before a human prompt is created.
 * Unlike approval-reply, this cannot resolve a pending human decision.
 */
import type { ToolApprovalEvaluation } from './approval-policy.js';
import { BASH_SAFETY_ACTION_KEY } from './bash-safety.js';
import { statusOutputPresentation } from './chat-segments.js';
import { emitRuntimeEvent } from './extensions.js';
import { FILE_WRITE_CONFLICT_ACTION_PREFIX } from './file-write-conflicts.js';
import { FILE_WRITE_REVIEW_ACTION_PREFIX } from './file-write-review.js';
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

const PRESERVATION_PREFIXES = [
  FILE_WRITE_REVIEW_ACTION_PREFIX,
  FILE_WRITE_CONFLICT_ACTION_PREFIX,
];

export function canReplanAfterDenial(
  approval: ToolApprovalEvaluation,
  executions: ToolExecution[],
): boolean {
  if (approval.decision !== 'denied') return false;
  if (
    PRESERVATION_PREFIXES.some((prefix) =>
      approval.actionKey.startsWith(prefix),
    )
  )
    return !executions.some(
      (entry) => entry.approvalActionKey === approval.actionKey,
    );
  // One shared shell/network replan per turn (Codex choice, 2026-11-04).
  // Per-file preservation recovery cannot authorize a denied effect.
  return (
    (approval.actionKey === BASH_SAFETY_ACTION_KEY ||
      (!approval.pinned && approval.actionKey.startsWith('network:'))) &&
    !executions.some((entry) => entry.approvalDecision === 'denied')
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
  const label = PRESERVATION_PREFIXES.some((prefix) =>
    approval.actionKey.startsWith(prefix),
  )
    ? 'File preservation check'
    : 'Approval denied';
  const denialText = `${label}: ${approval.reason}`;
  toolExecutions.push(
    buildApprovalDeniedToolExecution({
      toolName: call.function.name,
      argsJson: call.function.arguments,
      denialText,
      approval,
    }),
  );
  if (replan) {
    const recovery = approval.actionKey.startsWith(
      FILE_WRITE_CONFLICT_ACTION_PREFIX,
    )
      ? 'Nothing in this tool call ran. Continue with read-only inspection or checked file tools for authorized changes. Create unrelated new work at a separate path and leave existing files in place. Do not retry the blocked mutation through another shell or script. If the task requires this command, request its approval instead.'
      : 'Nothing in this tool call ran. Continue the original task only if you can omit the prohibited effects and complete permitted work. Do not repeat this call or reproduce the blocked effects through another tool, host alias or route. Other operations still require their own policy evaluation. Leave optional cleanup undone; explain a blocker only if it prevents the requested result.';
    for (const unrun of params.unrunCalls) {
      const content =
        unrun === call
          ? `${denialText}\n${recovery}`
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
  params.history.push(
    params.recordResult({
      role: 'tool',
      tool_call_id: call.id,
      content: denialText,
      is_error: true,
    }),
  );
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
