// src/sandbox/security.ts
//
// Gateway-enforced security controls. Dangerous commands are blocked HERE
// before they ever reach the sandbox.

// Copied from container/src/tools.ts and expanded for gateway-side enforcement.
const DENY_PATTERNS: RegExp[] = [
  /\brm\s+-[rf]{1,2}\b/,
  /(^|[;&|]\s*)mkfs(?:\.[a-z0-9_+-]+)?\b/,
  /(^|[;&|]\s*)format(?:\.com|\.exe)?\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{.*\};\s*:/,   // fork bomb
  /\|\s*(sh|bash|zsh)\b/,
  /;\s*rm\s+-[rf]/,
  /&&\s*rm\s+-[rf]/,
  /\|\|\s*rm\s+-[rf]/,
  /\bcurl\b.*\|\s*(sh|bash)/,
  /\bwget\b.*\|\s*(sh|bash)/,
  /\beval\b/,
  /\bsource\s+.*\.sh\b/,
  /\bpkill\b/,
  /\bkillall\b/,
  /\bkill\s+-9\b/,
  /\b(shutdown|reboot|poweroff)\b/,
  />\s*\/dev\/sd[a-z]\b/,
];

/**
 * Check if a bash command should be blocked.
 * @returns null if safe, or a string reason if blocked (do NOT execute)
 */
export function guardCommand(command: string): string | null {
  const lower = command.toLowerCase();
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(lower)) {
      return `Command blocked by security policy: matches pattern ${pattern.source}`;
    }
  }
  return null;
}

/**
 * Check if a tool is allowed given the allowedTools list.
 */
export function isToolAllowed(toolName: string, allowedTools: string[] | undefined): boolean {
  if (!allowedTools) return true;  // no restriction
  return allowedTools.includes(toolName);
}

/**
 * Assert that a string does NOT contain the API key.
 * Call this as a sanity check before any sandbox API call.
 * Throws if the API key is detected in the payload (programming error).
 */
export function assertNoApiKey(payload: string, apiKey: string): void {
  if (apiKey && payload.includes(apiKey)) {
    throw new Error('SECURITY VIOLATION: API key detected in sandbox payload. This is a bug — API keys must never reach the sandbox.');
  }
}
