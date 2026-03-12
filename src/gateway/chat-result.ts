import { isSilentReply, stripSilentToken } from '../agent/silent-reply.js';
import { getSessionById } from '../memory/db.js';
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

export function hasMessageSendToolExecution(
  result: GatewayChatResult,
): boolean {
  if (!Array.isArray(result.toolExecutions)) return false;
  for (const execution of result.toolExecutions) {
    if (
      String(execution.name || '')
        .trim()
        .toLowerCase() !== 'message'
    ) {
      continue;
    }

    const argsObj = parseJsonObject(execution.arguments);
    if (argsObj && isMessageSendAction(argsObj.action)) return true;

    const resultObj = parseJsonObject(execution.result);
    if (resultObj && isMessageSendAction(resultObj.action)) return true;
  }
  return false;
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
  return result;
}

export function normalizeSilentMessageSendReply(
  result: GatewayChatResult,
): GatewayChatResult {
  if (result.status !== 'success') return result;
  const sentByMessageTool = hasMessageSendToolExecution(result);
  const rawResult = result.result || '';
  if (isSilentReply(rawResult)) {
    return {
      ...result,
      result: sentByMessageTool
        ? 'Message sent.'
        : fallbackResultFromTools(result),
    };
  }
  const cleanedResult = stripSilentToken(rawResult);
  if (cleanedResult === rawResult) return result;
  const nextResult = cleanedResult.trim()
    ? cleanedResult
    : sentByMessageTool
      ? 'Message sent.'
      : fallbackResultFromTools(result);
  return {
    ...result,
    result: nextResult,
  };
}
