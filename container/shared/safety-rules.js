/**
 * Built-in safety patterns have one catalog for enforcement and admin review.
 * All rules start enabled; only validated gateway configuration disables them.
 * This catalog does not grant tool approval or change sandbox permissions.
 */
export const SAFETY_RULES = [
  {
    id: 'recursive-delete',
    scope: 'bash',
    pattern: /\brm\s+-[rf]{1,2}\b/,
    reason: 'rm -r, rm -f, rm -rf',
  },
  {
    id: 'format-unix',
    scope: 'bash',
    pattern: /(^|[;&|]\s*)mkfs(?:\.[a-z0-9_+-]+)?\b/,
    reason: 'mkfs command at segment start',
  },
  {
    id: 'format-windows',
    scope: 'bash',
    pattern: /(^|[;&|]\s*)format(?:\.com|\.exe)?\b/,
    reason: 'format command at segment start (Windows)',
  },
  {
    id: 'raw-disk-io',
    scope: 'bash',
    pattern: /\bdd\s+if=/,
    reason: 'raw disk I/O',
  },
  {
    id: 'fork-bomb',
    scope: 'bash',
    pattern: /:\(\)\s*\{.*\};\s*:/,
    reason: 'fork bomb :(){ :|:& };:',
  },
  {
    id: 'pipe-to-shell',
    scope: 'bash',
    pattern: /\|\s*(sh|bash|zsh)\b/,
    reason: 'pipe to shell',
  },
  {
    id: 'chained-delete-semicolon',
    scope: 'bash',
    pattern: /;\s*rm\s+-[rf]/,
    reason: 'chained rm after semicolon',
  },
  {
    id: 'chained-delete-and',
    scope: 'bash',
    pattern: /&&\s*rm\s+-[rf]/,
    reason: 'chained rm after &&',
  },
  {
    id: 'chained-delete-or',
    scope: 'bash',
    pattern: /\|\|\s*rm\s+-[rf]/,
    reason: 'chained rm after ||',
  },
  {
    id: 'curl-shell',
    scope: 'bash',
    pattern: /\bcurl\b.*\|\s*(sh|bash)/,
    reason: 'curl | sh',
  },
  {
    id: 'wget-shell',
    scope: 'bash',
    pattern: /\bwget\b.*\|\s*(sh|bash)/,
    reason: 'wget | sh',
  },
  { id: 'eval', scope: 'bash', pattern: /\beval\b/, reason: 'eval execution' },
  {
    id: 'source-script',
    scope: 'bash',
    pattern: /\bsource\s+.*\.sh\b/,
    reason: 'source shell scripts',
  },
  {
    id: 'pkill',
    scope: 'bash',
    pattern: /\bpkill\b/,
    reason: 'process killing',
  },
  {
    id: 'killall',
    scope: 'bash',
    pattern: /\bkillall\b/,
    reason: 'process killing',
  },
  {
    id: 'force-kill',
    scope: 'bash',
    pattern: /\bkill\s+-9\b/,
    reason: 'force kill',
  },
  {
    id: 'power-control',
    scope: 'bash',
    pattern: /\b(shutdown|reboot|poweroff)\b/,
    reason: 'system power control',
  },
  {
    id: 'block-device-write',
    scope: 'bash',
    pattern: />\s*\/dev\/sd[a-z]\b/,
    reason: 'write to block devices',
  },

  {
    id: 'file-root-delete',
    scope: 'file-content',
    pattern: /\brm\s+-rf\s+\/(\s|$)/i,
    reason:
      'Detected destructive root delete pattern (`rm -rf /`) in file content.',
  },
  {
    id: 'file-fork-bomb',
    scope: 'file-content',
    pattern: /:\(\)\s*\{.*\};\s*:/i,
    reason: 'Detected fork-bomb pattern in file content.',
  },
  {
    id: 'file-remote-shell',
    scope: 'file-content',
    pattern: /\bcurl\b[^\n|]*\|\s*(sh|bash|zsh)\b/i,
    reason:
      'Detected remote shell execution pattern (`curl | sh`) in file content.',
  },

  {
    id: 'file-exfiltration',
    scope: 'bash',
    pattern:
      /\b(cat|sed|awk)\b[^|]*\.(env|pem|key|p12)\b[^|]*(\|\s*(curl|wget)|>\s*\/dev\/tcp)/i,
    reason: 'Command appears to exfiltrate sensitive local files.',
  },
  {
    id: 'environment-exfiltration',
    scope: 'bash',
    pattern: /\b(printenv|env)\b[^|]*(\|\s*(curl|wget)|>\s*\/dev\/tcp)/i,
    reason: 'Command appears to exfiltrate environment variables.',
  },
];

export function normalizeDisabledSafetyRules(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > SAFETY_RULES.length ||
    value.some(
      (id) =>
        typeof id !== 'string' || !SAFETY_RULES.some((rule) => rule.id === id),
    )
  ) {
    throw new Error(
      'disabledSafetyRules must contain only known safety rule IDs.',
    );
  }
  return SAFETY_RULES.filter((rule) => value.includes(rule.id)).map(
    (rule) => rule.id,
  );
}
