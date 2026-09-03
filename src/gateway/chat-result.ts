import { isSilentReply, stripSilentToken } from '../agent/silent-reply.js';
import { getSessionById } from '../memory/db.js';
import {
  extractGatewayChatApprovalEvent,
  formatGatewayChatApprovalSummary,
} from './chat-approval.js';
import type { GatewayChatResult } from './gateway-types.js';
import {
  filterGatewayChatResultForSessionShowMode,
  normalizeSessionShowMode,
} from './show-mode.js';

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractVisionAnalysisFromToolResult(raw: unknown): string | null {
  const parsed = parseJsonObject(raw);
  if (!parsed || parsed.success !== true) return null;
  const analysis =
    typeof parsed.analysis === 'string' ? parsed.analysis.trim() : '';
  return analysis || null;
}

function normalizeToolErrorText(raw: string): string | null {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (/executable doesn't exist at /i.test(normalized)) {
    return 'browser runtime is not installed';
  }
  if (/econnrefused|connection refused/i.test(normalized)) {
    return 'connection was refused';
  }
  if (
    /enotfound|getaddrinfo|could not resolve|could not be reached/i.test(
      normalized,
    )
  ) {
    return 'host could not be reached';
  }
  if (/timed out|timeout|deadline exceeded/i.test(normalized)) {
    return 'operation timed out';
  }

  const stripped = normalized
    .replace(/^browser command failed:\s*/i, '')
    .replace(/^error:\s*/i, '')
    .trim();
  if (!stripped || /^npm warn /i.test(stripped)) {
    return 'tool execution failed';
  }
  return stripped.length > 160
    ? `${stripped.slice(0, 159).trimEnd()}…`
    : stripped;
}

function extractToolFailureText(
  execution: NonNullable<GatewayChatResult['toolExecutions']>[number],
): string | null {
  if (execution.blocked) {
    return normalizeToolErrorText(
      execution.blockedReason || 'blocked by security policy',
    );
  }

  const parsed = parseJsonObject(execution.result);
  if (
    (parsed?.success === false || parsed?.ok === false) &&
    typeof parsed.error === 'string'
  ) {
    return normalizeToolErrorText(parsed.error);
  }

  if (!execution.isError) return null;
  return normalizeToolErrorText(String(execution.result || ''));
}

function summarizePlaceholderToolFailure(
  result: GatewayChatResult,
): string | null {
  const executions = Array.isArray(result.toolExecutions)
    ? result.toolExecutions
    : [];
  const failedExecutions = executions.filter(isFailedExecution);
  if (failedExecutions.length === 0) return null;

  const toolNames = [
    ...new Set(
      failedExecutions.map((execution) => {
        const name = String(execution.name || '').trim();
        return name || 'tool';
      }),
    ),
  ];
  const lastFailureText = extractToolFailureText(
    failedExecutions[failedExecutions.length - 1],
  );
  if (toolNames.length === 1) {
    return lastFailureText
      ? `${toolNames[0]} failed: ${lastFailureText}.`
      : `${toolNames[0]} failed.`;
  }
  return lastFailureText
    ? `Tool calls failed: ${toolNames.join(', ')}. Last error: ${lastFailureText}.`
    : `Tool calls failed: ${toolNames.join(', ')}.`;
}

export function filterChatResultForSession(
  sessionId: string,
  result: GatewayChatResult,
): GatewayChatResult {
  const showMode = normalizeSessionShowMode(
    getSessionById(sessionId)?.show_mode,
  );
  return filterGatewayChatResultForSessionShowMode(result, showMode);
}

export function isMessageSendAction(rawAction: unknown): boolean {
  if (typeof rawAction !== 'string') return false;
  const compact = rawAction
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  return (
    compact === 'send' ||
    compact === 'sendmessage' ||
    compact === 'dm' ||
    compact === 'post' ||
    compact === 'reply' ||
    compact === 'respond'
  );
}

function isMessageSendExecution(
  execution: NonNullable<GatewayChatResult['toolExecutions']>[number],
): boolean {
  if (
    String(execution.name || '')
      .trim()
      .toLowerCase() !== 'message'
  ) {
    return false;
  }
  const argsObj = parseJsonObject(execution.arguments);
  if (argsObj && isMessageSendAction(argsObj.action)) return true;
  const resultObj = parseJsonObject(execution.result);
  return Boolean(resultObj && isMessageSendAction(resultObj.action));
}

function isFailedExecution(
  execution: NonNullable<GatewayChatResult['toolExecutions']>[number],
): boolean {
  if (execution.blocked || execution.isError) return true;
  const resultObj = parseJsonObject(execution.result);
  return resultObj?.ok === false || resultObj?.success === false;
}

/**
 * True when at least one `message` send in this turn actually succeeded.
 * Failed, blocked, or `ok:false` sends do not count: the silent-reply token
 * must never be rendered as "Message sent." when nothing was sent.
 */
export function hasMessageSendToolExecution(
  result: GatewayChatResult,
): boolean {
  if (!Array.isArray(result.toolExecutions)) return false;
  return result.toolExecutions.some(
    (execution) =>
      isMessageSendExecution(execution) && !isFailedExecution(execution),
  );
}

export function hasFailedMessageSendToolExecution(
  result: GatewayChatResult,
): boolean {
  if (!Array.isArray(result.toolExecutions)) return false;
  return result.toolExecutions.some(
    (execution) =>
      isMessageSendExecution(execution) && isFailedExecution(execution),
  );
}

export function fallbackResultFromTools(result: GatewayChatResult): string {
  const executions = Array.isArray(result.toolExecutions)
    ? result.toolExecutions
    : [];
  for (let i = executions.length - 1; i >= 0; i -= 1) {
    const execution = executions[i];
    if (execution.isError) continue;
    const text = String(execution.result || '').trim();
    if (!text) continue;
    return text;
  }
  return 'Done.';
}

export function normalizePlaceholderToolReply(
  result: GatewayChatResult,
): GatewayChatResult {
  if (result.status !== 'success') return result;
  const rawResult = String(result.result || '').trim();
  if (rawResult !== 'Done.') return result;
  const executions = Array.isArray(result.toolExecutions)
    ? result.toolExecutions
    : [];
  for (let i = executions.length - 1; i >= 0; i -= 1) {
    const execution = executions[i];
    if (execution.isError) continue;
    const toolName = String(execution.name || '')
      .trim()
      .toLowerCase();
    if (toolName !== 'vision_analyze' && toolName !== 'image') continue;
    const analysis = extractVisionAnalysisFromToolResult(execution.result);
    if (!analysis) continue;
    return {
      ...result,
      result: analysis,
    };
  }
  const failureSummary = summarizePlaceholderToolFailure(result);
  if (failureSummary) {
    return {
      ...result,
      result: failureSummary,
    };
  }
  return result;
}

export function normalizeSilentMessageSendReply(
  result: GatewayChatResult,
): GatewayChatResult {
  if (result.status !== 'success') return result;
  const sentByMessageTool = hasMessageSendToolExecution(result);
  const rawResult = result.result || '';
  // When the model went silent after a send that failed, surface the failure
  // instead of a generic placeholder; the user must not see "Message sent.".
  const silentFallback = (): string => {
    if (sentByMessageTool) return 'Message sent.';
    if (hasFailedMessageSendToolExecution(result)) {
      return summarizePlaceholderToolFailure(result) ?? 'Message send failed.';
    }
    return fallbackResultFromTools(result);
  };
  if (isSilentReply(rawResult)) {
    return {
      ...result,
      result: silentFallback(),
    };
  }
  const cleanedResult = stripSilentToken(rawResult);
  if (cleanedResult === rawResult) return result;
  const nextResult = cleanedResult.trim() ? cleanedResult : silentFallback();
  return {
    ...result,
    result: nextResult,
  };
}

export function normalizePendingApprovalReply(
  result: GatewayChatResult,
): GatewayChatResult {
  if (result.status !== 'success') return result;
  const approval = extractGatewayChatApprovalEvent(result);
  if (!approval) return result;

  const summary = formatGatewayChatApprovalSummary(approval);
  if (String(result.result || '').trim() === summary) {
    return result;
  }

  return {
    ...result,
    result: summary,
  };
}
