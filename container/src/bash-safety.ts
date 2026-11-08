/**
 * Shell hard blocks are checked before approval and again before execution.
 * Unlike approval-policy, these rules cannot be overridden by human consent;
 * this module neither executes commands nor grants access.
 */
import { createHash } from 'node:crypto';
import type { ToolApprovalEvaluation } from './approval-policy.js';
import { activeSafetyBlock } from './safety-rules.js';
import { parseToolArgsJson } from './tool-args.js';

export const BASH_SAFETY_ACTION_KEY = 'bash:safety-guard';

export function guardCommand(command: string): string | null {
  return activeSafetyBlock('bash', command);
}

export function evaluateBashSafety(input: {
  toolName: string;
  argsJson: string;
}): ToolApprovalEvaluation | null {
  if (input.toolName !== 'bash') return null;
  const command = parseToolArgsJson(input.argsJson)?.command;
  if (typeof command !== 'string') return null;
  const reason = guardCommand(command);
  if (!reason) return null;
  return {
    baseTier: 'red',
    tier: 'red',
    autonomyLevel: 'confirm-each',
    stakes: 'high',
    stakesScore: {
      level: 'high',
      score: 1,
      confidence: 1,
      classifier: 'bash-safety',
      signals: [],
      reasons: [reason],
    },
    stakesMiddlewareDecision: { action: 'block', reason },
    escalationRoute: 'policy_denial',
    decision: 'denied',
    actionKey: BASH_SAFETY_ACTION_KEY,
    fingerprint: createHash('sha256').update(input.argsJson).digest('hex'),
    intent: 'run a shell command blocked by the safety guard',
    consequenceIfDenied:
      'The command will not run; approval cannot override this restriction.',
    reason,
    commandPreview: '',
    pinned: true,
    hostHints: [],
    writeIntent: true,
  };
}
