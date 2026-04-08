import { createHash } from 'node:crypto';

const GUARDED_TOOL_NAMES = new Set(['read', 'glob', 'grep']);

export const TOOL_CALL_HISTORY_SIZE = 24;
export const NO_PROGRESS_REPEAT_THRESHOLD = 4;
export const PING_PONG_THRESHOLD = 6;

export interface ToolCallHistoryEntry {
  toolName: string;
  argsHash: string;
  resultHash: string;
  timestamp: number;
}

export function isLoopGuardedToolName(toolName: string): boolean {
  return GUARDED_TOOL_NAMES.has(
    String(toolName || '')
      .trim()
      .toLowerCase(),
  );
}

export type ToolLoopDetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      detector: 'generic_repeat' | 'ping_pong';
      count: number;
      message: string;
    };

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function stableStringifyFallback(value: unknown): string {
  try {
    return stableStringify(value);
  } catch {
    if (value == null) return String(value);
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    if (value instanceof Error) {
      return `${value.name}:${value.message}`;
    }
    return Object.prototype.toString.call(value);
  }
}

function digestStable(value: unknown): string {
  return createHash('sha256')
    .update(stableStringifyFallback(value))
    .digest('hex');
}

function parseArgs(rawArgs: string): unknown {
  try {
    return JSON.parse(rawArgs);
  } catch {
    return rawArgs;
  }
}

function getNoProgressStreak(
  history: ToolCallHistoryEntry[],
  toolName: string,
  argsHash: string,
): { count: number; latestResultHash?: string } {
  let count = 0;
  let latestResultHash: string | undefined;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry) continue;
    if (entry.toolName !== toolName || entry.argsHash !== argsHash) continue;
    if (!latestResultHash) {
      latestResultHash = entry.resultHash;
      count = 1;
      continue;
    }
    if (entry.resultHash !== latestResultHash) {
      break;
    }
    count += 1;
  }

  return { count, latestResultHash };
}

function getPingPongStreak(
  history: ToolCallHistoryEntry[],
  currentSignature: string,
): { count: number; noProgressEvidence: boolean } {
  const last = history.at(-1);
  if (!last) {
    return { count: 0, noProgressEvidence: false };
  }

  let otherSignature: string | undefined;
  for (let i = history.length - 2; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry) continue;
    if (entry.argsHash === last.argsHash) continue;
    if (!GUARDED_TOOL_NAMES.has(entry.toolName)) continue;
    otherSignature = entry.argsHash;
    break;
  }

  if (!otherSignature || currentSignature !== otherSignature) {
    return { count: 0, noProgressEvidence: false };
  }

  let alternatingTailCount = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry) continue;
    const expected =
      alternatingTailCount % 2 === 0 ? last.argsHash : otherSignature;
    if (entry.argsHash !== expected) break;
    alternatingTailCount += 1;
  }

  if (alternatingTailCount < 2) {
    return { count: 0, noProgressEvidence: false };
  }

  const tailStart = Math.max(0, history.length - alternatingTailCount);
  let firstHashA: string | undefined;
  let firstHashB: string | undefined;
  let noProgressEvidence = true;

  for (let i = tailStart; i < history.length; i += 1) {
    const entry = history[i];
    if (!entry) continue;
    if (entry.argsHash === last.argsHash) {
      if (!firstHashA) {
        firstHashA = entry.resultHash;
      } else if (firstHashA !== entry.resultHash) {
        noProgressEvidence = false;
        break;
      }
      continue;
    }
    if (entry.argsHash === otherSignature) {
      if (!firstHashB) {
        firstHashB = entry.resultHash;
      } else if (firstHashB !== entry.resultHash) {
        noProgressEvidence = false;
        break;
      }
      continue;
    }
    noProgressEvidence = false;
    break;
  }

  if (!firstHashA || !firstHashB) {
    noProgressEvidence = false;
  }

  return {
    count: alternatingTailCount + 1,
    noProgressEvidence,
  };
}

export function hashToolCall(toolName: string, rawArgs: string): string {
  return `${toolName}:${digestStable(parseArgs(rawArgs))}`;
}

export function hashToolOutcome(output: string, isError: boolean): string {
  return digestStable({
    isError,
    output,
  });
}

export function recordToolCallOutcome(
  history: ToolCallHistoryEntry[],
  toolName: string,
  rawArgs: string,
  output: string,
  isError: boolean,
): void {
  history.push({
    toolName,
    argsHash: hashToolCall(toolName, rawArgs),
    resultHash: hashToolOutcome(output, isError),
    timestamp: Date.now(),
  });
  if (history.length > TOOL_CALL_HISTORY_SIZE) {
    history.splice(0, history.length - TOOL_CALL_HISTORY_SIZE);
  }
}

export function detectToolCallLoop(
  history: ToolCallHistoryEntry[],
  toolName: string,
  rawArgs: string,
): ToolLoopDetectionResult {
  if (!isLoopGuardedToolName(toolName)) {
    return { stuck: false };
  }

  const currentSignature = hashToolCall(toolName, rawArgs);
  const noProgress = getNoProgressStreak(history, toolName, currentSignature);
  const repeatedAttemptCount = noProgress.count + 1;
  if (repeatedAttemptCount >= NO_PROGRESS_REPEAT_THRESHOLD) {
    return {
      stuck: true,
      detector: 'generic_repeat',
      count: repeatedAttemptCount,
      message:
        `Tool loop guard: ${toolName} would repeat identical arguments and ` +
        `identical output ${repeatedAttemptCount} times. Stop re-discovering and act on the files/content you already have.`,
    };
  }

  const pingPong = getPingPongStreak(history, currentSignature);
  if (pingPong.noProgressEvidence && pingPong.count >= PING_PONG_THRESHOLD) {
    return {
      stuck: true,
      detector: 'ping_pong',
      count: pingPong.count,
      message:
        `Tool loop guard: you are alternating between the same discovery ` +
        `patterns with no new information (${pingPong.count} consecutive calls). Stop searching again and use the current inputs or report what is missing.`,
    };
  }

  return { stuck: false };
}
