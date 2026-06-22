import type { ToolExecution } from '../types/execution.js';
import {
  completeHatchingAfterMessageSend,
  recordHatchingTurnWithoutMessage,
} from '../workspace.js';

type MessageSend = {
  recipient?: string;
  subject?: string;
};

export type BootstrapHatchingTurnResult = {
  completed: boolean;
  updated: boolean;
  reason: string;
  turnsWithoutMessage?: number;
};

const HATCHING_CHANNEL_SETUP_LINKS = [
  'Optional channel setup:',
  '- [Set up WhatsApp](/admin/channels#whatsapp)',
  '- [Set up Discord](/admin/channels#discord)',
  '- [Set up Telegram](/admin/channels#telegram)',
].join('\n');

const HATCHING_CHANNEL_LINKS = [
  {
    name: 'WhatsApp',
    path: '/admin/channels#whatsapp',
    markdown: '[Set up WhatsApp](/admin/channels#whatsapp)',
  },
  {
    name: 'Discord',
    path: '/admin/channels#discord',
    markdown: '[Set up Discord](/admin/channels#discord)',
  },
  {
    name: 'Telegram',
    path: '/admin/channels#telegram',
    markdown: '[Set up Telegram](/admin/channels#telegram)',
  },
] as const;

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

function firstRecipientCandidate(...values: unknown[]): string {
  for (const value of values) {
    const candidate = readString(value);
    if (candidate) return candidate;
  }
  return '';
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

  const recipient = firstRecipientCandidate(
    args.to,
    args.channelId,
    args.target,
    result?.channelId,
  );

  const subject = readString(args.subject) || readString(result?.subject);

  return {
    recipient,
    subject,
  };
}

export function recordBootstrapHatchingTurnResult(params: {
  agentId: string;
  bootstrapFile: 'BOOTSTRAP.md' | 'OPENING.md' | null;
  toolExecutions: ToolExecution[];
  handledAt?: string;
}): BootstrapHatchingTurnResult | null {
  if (params.bootstrapFile !== 'BOOTSTRAP.md') return null;

  const send = params.toolExecutions
    .map(readSuccessfulMessageSend)
    .find((candidate): candidate is MessageSend => Boolean(candidate));
  if (!send) {
    return recordHatchingTurnWithoutMessage({ agentId: params.agentId });
  }

  return completeHatchingAfterMessageSend({
    agentId: params.agentId,
    recipient: send.recipient,
    subject: send.subject,
    handledAt: params.handledAt,
  });
}

export function appendHatchingChannelSetupLinks(params: {
  resultText: string;
  hatchingCompletion: BootstrapHatchingTurnResult | null;
}): string {
  if (
    !params.hatchingCompletion?.completed ||
    params.hatchingCompletion.reason !== 'message sent'
  ) {
    return params.resultText;
  }
  let resultText = params.resultText;
  for (const link of HATCHING_CHANNEL_LINKS) {
    const escapedPath = link.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    resultText = resultText.replace(
      new RegExp(`-?\\s*${link.name}:\\s+\`?${escapedPath}\`?`, 'g'),
      `- ${link.markdown}`,
    );
  }
  if (
    HATCHING_CHANNEL_LINKS.every((link) => resultText.includes(link.markdown))
  ) {
    return resultText;
  }
  return `${resultText.trimEnd()}\n\n${HATCHING_CHANNEL_SETUP_LINKS}`;
}
