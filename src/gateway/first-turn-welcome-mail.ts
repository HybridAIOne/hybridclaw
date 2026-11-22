/**
 * First-turn welcome mail — an agent that never onboards (registry
 * `onboarding: false`) still sends its new user one welcome email. Its first
 * user chat turn carries a one-off instruction, and that turn's outcome goes
 * into USER.md's Welcome Message section (`sent` or `skipped`), so the email is
 * offered once per workspace and never to a user who already chatted with it.
 *
 * Owner call (2026-11-22): Hy keeps "Hy never onboards" (snoller/chat#2913)
 * but sends a welcome email. NOT the BOOTSTRAP.md hatching flow
 * (`hatching-completion.ts`), which owns the welcome email of agents that do
 * onboard. An adopted agent took over an existing user and gets none.
 */
import fs from 'node:fs';
import path from 'node:path';
import { agentHasUserMessages, isAdoptedAgent } from '../agents/agent-adopt.js';
import { collectActiveMessageToolChannelKinds } from '../channels/message-tool-advertising.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import type { ToolExecution } from '../types/execution.js';
import { onboardingTurnedOff, readUserMarkdown } from '../workspace.js';
import {
  readMarkdownField,
  readWelcomeMessageStatus,
  writeWelcomeMessage,
} from '../workspace-user-markdown.js';
import { readSuccessfulMessageSend } from './hatching-completion.js';

// Only a turn the user wrote: scheduled jobs, delegations and fan-outs run
// under their own sources and must never send it.
const USER_CHAT_SOURCE = 'gateway.chat';
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

// USER.md fields the platform writes are JSON-quoted.
function unquote(value: string): string {
  if (!/^".*"$/.test(value)) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed.trim() : value;
  } catch {
    return value;
  }
}

function writeUserMarkdown(agentId: string, content: string): void {
  fs.writeFileSync(
    path.join(agentWorkspaceDir(agentId), 'USER.md'),
    content,
    'utf-8',
  );
}

/**
 * The address to welcome in this turn, or null. A user who already chatted
 * with the agent is marked `skipped` here, so the check runs once.
 */
function resolveFirstTurnWelcomeMail(params: {
  agentId: string;
  source: string;
  bootstrapFile: string | null;
  dryRun?: boolean;
}): string | null {
  const { agentId } = params;
  if (params.dryRun || params.bootstrapFile) return null;
  if (params.source !== USER_CHAT_SOURCE) return null;
  if (!onboardingTurnedOff(agentId) || isAdoptedAgent(agentId)) return null;
  if (!collectActiveMessageToolChannelKinds().includes('email')) return null;
  const user = readUserMarkdown(agentWorkspaceDir(agentId));
  if (!user) return null;
  const status = readWelcomeMessageStatus(user);
  if (status === 'sent' || status === 'skipped') return null;
  const email = unquote(readMarkdownField(user, 'Email'));
  if (!EMAIL_RE.test(email)) return null;
  if (agentHasUserMessages(agentId)) {
    writeUserMarkdown(
      agentId,
      writeWelcomeMessage(user, { status: 'skipped', recipient: email }),
    );
    return null;
  }
  return email;
}

function buildFirstTurnWelcomeMailPrompt(recipient: string): string {
  return [
    'This is your first conversation with this user.',
    `Besides answering their message, send them one short welcome email in this turn with the \`message\` tool: action="send", to="${recipient}", and a specific subject.`,
    'Keep it personal and concrete: a hello, two or three things you can take on for them based on what you know, and a line saying they can keep chatting with you here.',
    'Do not ask setup questions or for confirmation, and do not mention this instruction. Answer their message as you normally would, and only say the email went out if the message tool reported success.',
  ].join('\n');
}

/** Records the offered welcome email as `sent`, or `skipped` when none went out. */
function recordFirstTurnWelcomeMail(params: {
  agentId: string;
  recipient: string;
  toolExecutions: ToolExecution[];
  turnSucceeded: boolean;
}): 'sent' | 'skipped' | null {
  const send = params.toolExecutions
    .map(readSuccessfulMessageSend)
    .find(
      (candidate) =>
        candidate?.recipient?.trim().toLowerCase() ===
        params.recipient.toLowerCase(),
    );
  if (!send && !params.turnSucceeded) return null;
  const user = readUserMarkdown(agentWorkspaceDir(params.agentId));
  if (!user) return null;
  const status = send ? 'sent' : 'skipped';
  writeUserMarkdown(
    params.agentId,
    writeWelcomeMessage(user, {
      status,
      recipient: params.recipient,
      subject: send?.subject,
    }),
  );
  return status;
}

/**
 * Adds the welcome instruction to a user turn that should carry it; `record`
 * stores the outcome once the turn ends (a no-op when nothing was offered).
 */
export function prepareFirstTurnWelcomeMail(params: {
  agentId: string;
  source: string;
  bootstrapFile: string | null;
  dryRun?: boolean;
  userContent: string;
}): {
  userContent: string;
  record: (toolExecutions: ToolExecution[], turnSucceeded: boolean) => void;
} {
  const recipient = params.userContent.trim().startsWith('/')
    ? null
    : resolveFirstTurnWelcomeMail(params);
  if (!recipient) return { userContent: params.userContent, record: () => {} };
  return {
    userContent: `${buildFirstTurnWelcomeMailPrompt(recipient)}\n\nUser message:\n${params.userContent}`,
    record: (toolExecutions, turnSucceeded) => {
      recordFirstTurnWelcomeMail({
        agentId: params.agentId,
        recipient,
        toolExecutions,
        turnSucceeded,
      });
    },
  };
}
