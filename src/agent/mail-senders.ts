/**
 * The accounts a chat's agent can send email from, and what the prompt says
 * about them. The list comes from config and the platform's connector state,
 * never from what the user wrote: the agent's email channel mailbox (its own
 * or the shared default) and the user's connected Google and Microsoft 365
 * accounts. With two or more, the model must know which one a mail goes out
 * from before it sends; the Hy app asks with the existing `ask_questions`
 * card, one option per account, and other clients ask in words.
 *
 * NOT a send guard or the email runtime (`channels/email/runtime.ts` picks
 * the SMTP account): the model still chooses the tool, and approvals apply.
 */
import { resolveAgentSenderEmailAddress } from '../channels/email/agent-account.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import type { ConnectorDirectoryEntry } from '../scopes/scope-connectors.js';

export type MailSenderKind = 'agent' | 'shared' | 'google' | 'microsoft365';

export interface MailSender {
  kind: MailSenderKind;
  /** Null when the platform does not say which account it is. */
  address: string | null;
}

export type MailConnectorState = Pick<
  ConnectorDirectoryEntry,
  'id' | 'kind' | 'connected' | 'account'
>;

// The platform's connector ids for mail the user can send in their own name,
// with a tool name its namespace covers (`scope-connectors.ts` maps both).
const USER_MAIL_CONNECTORS = [
  { kind: 'google', toolName: 'hybridai__google__send_mail' },
  { kind: 'microsoft365', toolName: 'hybridai__microsoft365__send_mail' },
] as const;

// What a button shows for an account whose address the platform keeps to
// itself; brand names, so they read the same in every language.
const SERVICE_OPTION: Record<'google' | 'microsoft365', string> = {
  google: 'Gmail',
  microsoft365: 'Outlook',
};

const DESCRIPTION: Record<MailSenderKind, string> = {
  agent: "this agent's own mailbox, sent with the `message` tool",
  shared:
    'the shared default mailbox, which this agent sends from because it has none of its own, sent with the `message` tool',
  google:
    "the user's connected Google account (Gmail), sent with the Google connector's send-mail tool",
  microsoft365:
    "the user's connected Microsoft 365 account (Outlook), sent with the Microsoft connector's send-mail tool",
};

// The `ask_questions` card's limits (`container/src/tools/questions.ts`).
const QUESTION_OPTIONS_MAX = 5;
const QUESTION_OPTION_MAX = 80;

export const MAIL_SENDER_QUESTION = 'Which account should the email go from?';

export function listMailSenders(input: {
  /** The email channel's address for this agent, when `message` can send email. */
  agentEmail: { address: string; own: boolean } | null;
  connectors: readonly MailConnectorState[] | null;
  isToolOffered: (toolName: string) => boolean;
}): MailSender[] {
  const senders: MailSender[] = [];
  if (input.agentEmail) {
    senders.push({
      kind: input.agentEmail.own ? 'agent' : 'shared',
      address: input.agentEmail.address,
    });
  }
  for (const { kind, toolName } of USER_MAIL_CONNECTORS) {
    const entry = input.connectors?.find(
      (connector) => connector.id === kind && connector.kind === 'connector',
    );
    if (!entry?.connected || !input.isToolOffered(toolName)) continue;
    senders.push({ kind, address: entry.account });
  }
  return senders;
}

function senderOption(sender: MailSender): string {
  if (sender.address) return sender.address;
  return SERVICE_OPTION[sender.kind as 'google' | 'microsoft365'];
}

/**
 * The `ask_questions` arguments that ask which account to send from, or
 * null when the card cannot show every account as its own option.
 */
export function buildMailSenderQuestions(
  senders: readonly MailSender[],
): { questions: [{ question: string; options: string[] }] } | null {
  const options = senders.map(senderOption);
  if (
    options.length < 2 ||
    options.length > QUESTION_OPTIONS_MAX ||
    new Set(options.map((option) => option.toLowerCase())).size !==
      options.length ||
    options.some((option) => option.length > QUESTION_OPTION_MAX)
  ) {
    return null;
  }
  return { questions: [{ question: MAIL_SENDER_QUESTION, options }] };
}

/** Prompt lines for an agent with more than one account to send from. */
export function buildMailSenderPromptLines(
  senders: readonly MailSender[],
  options: { card: boolean },
): string[] {
  if (senders.length < 2) return [];
  const questions = options.card ? buildMailSenderQuestions(senders) : null;
  const ask = questions
    ? `To ask, call \`ask_questions\` with ${JSON.stringify(questions)}, the question in the user's language and every option exactly as written, then end your turn with one short sentence. The pick arrives as the user's next message.`
    : 'To ask, name the accounts in one short question and end your turn.';
  return [
    `You can send email from ${senders.length} accounts:`,
    ...senders.map(
      (sender) => `- \`${senderOption(sender)}\`: ${DESCRIPTION[sender.kind]}.`,
    ),
    'Before you send an email, know which of these it goes from. Use the one the user named, or the one the request settles: a reply goes from the account its thread is in, "from you" means the mailbox you send from with `message`, and "from me" means the user\'s account when exactly one is connected. Otherwise ask before sending, and send only after the answer.',
    ask,
  ];
}

/**
 * The prompt lines for a chat with `agentId`: the email channel's mailbox
 * when `message` can send email, the user's connected mail accounts whose
 * tools the chat keeps, and the card when `ask_questions` is offered.
 */
export function describeMailSenders(input: {
  agentId: string;
  emailChannelActive: boolean;
  connectors: readonly MailConnectorState[] | null | undefined;
  isToolOffered: (toolName: string) => boolean;
}): string[] {
  const agentEmail =
    input.emailChannelActive && input.isToolOffered('message')
      ? resolveAgentSenderEmailAddress(getRuntimeConfig(), input.agentId)
      : null;
  return buildMailSenderPromptLines(
    listMailSenders({
      agentEmail,
      connectors: input.connectors ?? null,
      isToolOffered: input.isToolOffered,
    }),
    { card: input.isToolOffered('ask_questions') },
  );
}
