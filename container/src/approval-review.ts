/**
 * Human-readable facts from the exact pending call, independent of the short
 * command preview. This projection never changes approval scope or execution.
 * Credentials and attachment bytes are not part of the review transport.
 */
import { isRecord } from './search-utils.js';

let emailSender: string | undefined;
let userMailSendTools: string[] = [];
let phoneApp = false;

/** The address the gateway's email channel sends from for this agent. */
export function setApprovalEmailSender(address: string | undefined): void {
  emailSender = address?.trim() || undefined;
}

/**
 * The user's own mail: the connector tools that send from their account, and
 * whether this turn comes from the phone app, where mail is always theirs.
 */
export function setUserMailContext(params: {
  toolNames: string[];
  client?: string;
}): void {
  userMailSendTools = params.toolNames.filter((name) =>
    /__(?:send_mail|send_email)$/i.test(name),
  );
  phoneApp = params.client === 'mobile';
}

/**
 * Why a message-tool email may not go out from the agent's own mailbox, or
 * undefined when it may. Once the user has a mail account of their own here,
 * mail to other people is in their name and goes from that account.
 */
export function ownMailboxRefusal(): string | undefined {
  if (userMailSendTools.length > 0) {
    return `this would send from the agent's own mailbox, not the user's; send it from the user's account with ${userMailSendTools.join(' or ')}`;
  }
  if (phoneApp) {
    return "this would send from the agent's own mailbox, not the user's; ask the user to connect their mail account first";
  }
  return undefined;
}

const MESSAGE_TARGET_KEYS = [
  'channelId',
  'channel',
  'to',
  'target',
  'user',
  'username',
  'userId',
  'memberId',
] as const;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Who a message-tool call names; none means the current conversation. */
export function messageToolTarget(
  args: Record<string, unknown>,
): string | undefined {
  for (const key of MESSAGE_TARGET_KEYS) {
    const value = stringValue(args[key]);
    if (value) return value;
  }
  return undefined;
}

/** The address a message-tool send mails to, when its target is one. */
export function messageToolEmailTarget(
  args: Record<string, unknown>,
): string | undefined {
  const target = messageToolTarget(args)?.replace(/^email:/i, '');
  return target && EMAIL_RE.test(target) ? target : undefined;
}

function stringList(value: unknown): string[] | undefined {
  const list = (Array.isArray(value) ? value : [value])
    .map(stringValue)
    .filter((item): item is string => Boolean(item));
  return list.length ? list : undefined;
}

// The same fields the message tool reads for an email send, in the shape the
// phone's email card reads for connector sends.
function messageEmailReview(
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (stringValue(args.action)?.toLowerCase() !== 'send') return undefined;
  const to = messageToolEmailTarget(args);
  if (!to) return undefined;
  const subject = stringValue(args.subject) ?? stringValue(args.title);
  const body =
    stringValue(args.content) ??
    stringValue(args.text) ??
    stringValue(args.message);
  const file = ['filePath', 'attachmentPath', 'mediaPath', 'imagePath', 'file']
    .map((key) => stringValue(args[key]))
    .find(Boolean);
  const cc = stringList(args.cc);
  const bcc = stringList(args.bcc);
  return {
    transport: 'email',
    ...(emailSender ? { from: emailSender } : {}),
    to: [to],
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    ...(subject ? { subject } : {}),
    ...(body ? { body } : {}),
    ...(file ? { attachments: [file] } : {}),
  };
}

const scalarFields = [
  'account',
  'subject',
  'content_type',
  'file_name',
  'filename',
  'name',
  'file_id',
  'fileId',
  'path',
  'file_path',
  'email',
  'emailAddress',
  'recipient',
  'role',
  'type',
  'destination',
  'url',
] as const;

function address(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(address);
  if (!isRecord(value)) return null;
  if (isRecord(value.emailAddress))
    return { emailAddress: address(value.emailAddress) };
  return typeof value.address === 'string' ? { address: value.address } : null;
}

function project(args: Record<string, unknown>): Record<string, unknown> {
  const review: Record<string, unknown> = {};
  for (const key of scalarFields) {
    if (typeof args[key] === 'string') review[key] = args[key];
  }
  for (const key of [
    'from',
    'to',
    'cc',
    'bcc',
    'toRecipients',
    'ccRecipients',
    'bccRecipients',
  ]) {
    if (key in args) review[key] = address(args[key]);
  }
  if (typeof args.body === 'string') review.body = args.body;
  else if (isRecord(args.body) && typeof args.body.content === 'string') {
    review.body = {
      content: args.body.content,
      ...(typeof args.body.contentType === 'string'
        ? { contentType: args.body.contentType }
        : {}),
    };
  }
  if (Array.isArray(args.attachments)) {
    review.attachments = args.attachments.map((item) => {
      if (typeof item === 'string') return item;
      const attachment: Record<string, unknown> = {};
      if (isRecord(item)) {
        for (const key of ['name', 'filename', 'path', 'contentType']) {
          if (typeof item[key] === 'string') attachment[key] = item[key];
        }
        if (
          typeof item.size === 'number' &&
          Number.isFinite(item.size) &&
          item.size >= 0
        )
          attachment.size = item.size;
      }
      return attachment;
    });
  }
  if (isRecord(args.permission)) {
    const permission: Record<string, unknown> = {};
    for (const key of ['emailAddress', 'role', 'type']) {
      if (typeof args.permission[key] === 'string')
        permission[key] = args.permission[key];
    }
    review.permission = permission;
  }
  return review;
}

export function approvalReviewArguments(
  toolName: string,
  argsJson: string,
): string | undefined {
  if (toolName === 'message') {
    try {
      const args: unknown = JSON.parse(argsJson);
      const review = isRecord(args) ? messageEmailReview(args) : undefined;
      return review ? bounded(review) : undefined;
    } catch {
      return undefined;
    }
  }
  // Only connector calls have these field semantics; never reinterpret shell/browser inputs.
  if (
    !toolName.includes('__') &&
    !['outlook_send_mail', 'send_mail', 'send_email', 'sendmail'].includes(
      toolName,
    )
  )
    return undefined;
  try {
    const args: unknown = JSON.parse(argsJson);
    if (!isRecord(args)) return undefined;
    const review = project(args);
    if (isRecord(args.message)) review.message = project(args.message);
    if (!Object.keys(review).length) return undefined;
    return bounded(review);
  } catch {
    return undefined;
  }
}

function bounded(review: Record<string, unknown>): string | undefined {
  const encoded = JSON.stringify(review);
  // 256 KiB keeps the phone's review bounded without ever cutting a message in half.
  return Buffer.byteLength(encoded, 'utf8') <= 262_144 ? encoded : undefined;
}
