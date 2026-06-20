import type { ToolExecution } from '../types/execution.js';
import { completeHatchingAfterFirstJobsEmail } from '../workspace.js';

type MessageSend = {
  recipient: string;
  subject?: string;
  content?: string;
};

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstEmailCandidate(...values: unknown[]): string {
  for (const value of values) {
    const candidate = readString(value);
    if (/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/.test(candidate)) return candidate;
  }
  return '';
}

function parseSubjectFromContent(content: string): string {
  const match = content.match(/^\s*\[Subject:\s*([^\]\n]+)\]/i);
  return match?.[1]?.trim() || '';
}

function readSuccessfulMessageSend(
  execution: ToolExecution,
): MessageSend | null {
  if (execution.name !== 'message') return null;
  if (execution.isError || execution.blocked) return null;

  const args = parseJsonObject(execution.arguments);
  if (!args || readString(args.action).toLowerCase() !== 'send') return null;

  const result = parseJsonObject(execution.result);
  if (result && result.ok === false) return null;

  const recipient = firstEmailCandidate(
    args.to,
    args.channelId,
    args.target,
    result?.channelId,
  );
  if (!recipient) return null;

  const content = readString(args.content);
  const subject =
    readString(args.subject) ||
    parseSubjectFromContent(content) ||
    readString(result?.subject);

  return {
    recipient,
    subject,
    content,
  };
}

export function completeBootstrapAfterFirstJobsEmailTool(params: {
  agentId: string;
  bootstrapFile: 'BOOTSTRAP.md' | 'OPENING.md' | null;
  toolExecutions: ToolExecution[];
  handledAt?: string;
}): { completed: boolean; updated: boolean; reason: string } | null {
  if (params.bootstrapFile !== 'BOOTSTRAP.md') return null;

  const send = params.toolExecutions
    .map(readSuccessfulMessageSend)
    .find((candidate): candidate is MessageSend => Boolean(candidate));
  if (!send) return null;

  return completeHatchingAfterFirstJobsEmail({
    agentId: params.agentId,
    recipient: send.recipient,
    subject: send.subject,
    content: send.content,
    handledAt: params.handledAt,
  });
}
