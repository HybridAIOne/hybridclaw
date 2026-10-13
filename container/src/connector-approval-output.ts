/** A broker approval ends the turn before its error can reach the model as a result. */
import type { ConnectorApproval } from '../shared/connector-approval.js';
import { approvalOutputPresentation } from './chat-segments.js';
import { approvalRuntime, emitApprovalProgress } from './tool-approval.js';
import type {
  ContainerOutput,
  TokenUsageStats,
  ToolExecution,
} from './types.js';
export function connectorApprovalOutput(params: {
  external: ConnectorApproval;
  toolName: string;
  argsJson: string;
  execution: ToolExecution;
  originalPrompt: string;
  toolsUsed: string[];
  toolExecutions: ToolExecution[];
  tokenUsage: TokenUsageStats;
}): ContainerOutput {
  const pendingApproval = approvalRuntime.registerConnectorApproval(
    params.external,
    params.toolName,
    params.argsJson,
    params.originalPrompt,
  );
  emitApprovalProgress(pendingApproval);
  params.toolExecutions.push({
    ...params.execution,
    blocked: true,
    approvalDecision: 'required',
    approvalRequestId: pendingApproval.approvalId,
    approvalTier: 'red',
  });
  return {
    status: 'success',
    result: pendingApproval.prompt,
    toolsUsed: [...new Set(params.toolsUsed)],
    outputPresentation: approvalOutputPresentation(),
    toolExecutions: params.toolExecutions,
    pendingApproval,
    tokenUsage: params.tokenUsage,
    effectiveUserPrompt: params.originalPrompt,
  };
}
