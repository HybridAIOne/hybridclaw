/**
 * Host-side feedback triggers. The model decides whether to call
 * `report_feedback`; these detectors only surface a per-turn hint in the
 * dynamic context when the host has evidence the model may lack: the user's
 * latest message reads as frustrated, or the previous turn had failed tool
 * calls. Hints never enter the cached system prompt.
 */

const FRUSTRATION_PATTERNS: RegExp[] = [
  /\b(wtf|wth|ffs|omfg)\b/i,
  /\b(this|that|it) (is|was) (so |really |completely |totally )?(useless|broken|terrible|awful|horrible|frustrating|annoying)\b/i,
  /\b(doesn'?t|does not|didn'?t|did not|won'?t|will not|can'?t|cannot) (even )?(work|listen|understand|help|do (anything|it|that))\b/i,
  /\b(stop|quit) (doing|saying|repeating|ignoring)\b/i,
  /\b(i (already )?(said|told you|asked)( (this|that))?( (twice|three times|again|before|multiple times)))\b/i,
  /\b(again\?{1,}|seriously\?{1,}|are you kidding)/i,
  /\b(you (keep|always|never|ignored|ignore)\b)/i,
  /\b(so frustrating|this sucks|piece of (junk|crap)|what the (hell|heck))\b/i,
  /\b(funktioniert (nicht|einfach nicht)|schon wieder|zum dritten mal|geht (gar )?nicht|kapierst (du )?(es )?nicht|hörst (du )?(mir )?(nicht|gar nicht) zu)\b/i,
  /[!?]{3,}/,
];

export function detectUserFrustration(
  text: string | null | undefined,
): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  return FRUSTRATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

interface TurnToolErrorRecord {
  toolNames: string[];
  recordedAt: number;
}

const TOOL_ERROR_MEMORY_TTL_MS = 30 * 60 * 1000;
const lastTurnToolErrors = new Map<string, TurnToolErrorRecord>();

/** Remember which tool calls failed in the turn that just finished. */
export function rememberTurnToolErrors(
  sessionId: string,
  toolExecutions: ReadonlyArray<{ name: string; isError?: boolean }>,
): void {
  const key = sessionId.trim();
  if (!key) return;
  const failed = Array.from(
    new Set(
      toolExecutions
        .filter((execution) => execution.isError === true)
        .map((execution) => execution.name.trim())
        .filter(Boolean),
    ),
  );
  if (failed.length === 0) {
    lastTurnToolErrors.delete(key);
    return;
  }
  lastTurnToolErrors.set(key, { toolNames: failed, recordedAt: Date.now() });
}

function takeTurnToolErrors(sessionId: string): string[] {
  const key = sessionId.trim();
  const record = lastTurnToolErrors.get(key);
  if (!record) return [];
  lastTurnToolErrors.delete(key);
  if (Date.now() - record.recordedAt > TOOL_ERROR_MEMORY_TTL_MS) return [];
  return record.toolNames;
}

export function clearTurnToolErrors(sessionId?: string): void {
  if (sessionId === undefined) {
    lastTurnToolErrors.clear();
    return;
  }
  lastTurnToolErrors.delete(sessionId.trim());
}

/**
 * Per-turn hint lines for the dynamic context. Consumes the previous turn's
 * tool-error record so the hint fires once.
 */
export function buildFeedbackTriggerHints(params: {
  sessionId: string;
  userText: string | null | undefined;
}): string[] {
  const hints: string[] = [];
  const failedTools = takeTurnToolErrors(params.sessionId);
  if (failedTools.length > 0) {
    hints.push(
      `Feedback trigger (tool_error): the previous turn had ${failedTools.length} failed tool call${failedTools.length === 1 ? '' : 's'} (${failedTools.map((name) => `\`${name}\``).join(', ')}). If the failure was HybridClaw's fault and is now resolved or abandoned, consider \`report_feedback\` with trigger "tool_error" after handling the user's request.`,
    );
  }
  if (detectUserFrustration(params.userText)) {
    hints.push(
      'Feedback trigger (user_frustration): the latest user message reads as frustrated. Address the user first. If HybridClaw or your own behaviour caused the frustration, consider `report_feedback` with trigger "user_frustration", quoting the user verbatim. Do not draft feedback about the user.',
    );
  }
  return hints;
}
