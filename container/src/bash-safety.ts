/**
 * Shell hard blocks are checked before approval and again before execution.
 * Unlike approval-policy, these rules cannot be overridden by human consent;
 * this module neither executes commands nor grants access.
 */
import { createHash } from 'node:crypto';
import type { ToolApprovalEvaluation } from './approval-policy.js';
import { parseToolArgsJson } from './tool-args.js';

export const BASH_SAFETY_ACTION_KEY = 'bash:safety-guard';

const DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[rf]{1,2}\b/, reason: 'rm -r, rm -f, rm -rf' },
  {
    pattern: /(^|[;&|]\s*)mkfs(?:\.[a-z0-9_+-]+)?\b/,
    reason: 'mkfs command at segment start',
  },
  {
    pattern: /(^|[;&|]\s*)format(?:\.com|\.exe)?\b/,
    reason: 'format command at segment start (Windows)',
  },
  { pattern: /\bdd\s+if=/, reason: 'raw disk I/O' },
  { pattern: /:\(\)\s*\{.*\};\s*:/, reason: 'fork bomb :(){ :|:& };:' },
  { pattern: /\|\s*(sh|bash|zsh)\b/, reason: 'pipe to shell' },
  { pattern: /;\s*rm\s+-[rf]/, reason: 'chained rm after semicolon' },
  { pattern: /&&\s*rm\s+-[rf]/, reason: 'chained rm after &&' },
  { pattern: /\|\|\s*rm\s+-[rf]/, reason: 'chained rm after ||' },
  { pattern: /\bcurl\b.*\|\s*(sh|bash)/, reason: 'curl | sh' },
  { pattern: /\bwget\b.*\|\s*(sh|bash)/, reason: 'wget | sh' },
  { pattern: /\beval\b/, reason: 'eval execution' },
  { pattern: /\bsource\s+.*\.sh\b/, reason: 'source shell scripts' },
  { pattern: /\bpkill\b/, reason: 'process killing' },
  { pattern: /\bkillall\b/, reason: 'process killing' },
  { pattern: /\bkill\s+-9\b/, reason: 'force kill' },
  { pattern: /\b(shutdown|reboot|poweroff)\b/, reason: 'system power control' },
  { pattern: />\s*\/dev\/sd[a-z]\b/, reason: 'write to block devices' },
];

export function guardCommand(command: string): string | null {
  const lower = command.toLowerCase();
  for (const { pattern, reason } of DENY_PATTERNS) {
    if (pattern.test(lower)) {
      return `Command blocked by safety guard (${reason}). Approval cannot override this restriction.`;
    }
  }
  return null;
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
