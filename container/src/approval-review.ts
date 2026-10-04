/**
 * Human-readable facts from the exact pending call, independent of the short
 * command preview. This projection never changes approval scope or execution.
 * Credentials and attachment bytes are not part of the review transport.
 */
import { isRecord } from './search-utils.js';

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
    const encoded = JSON.stringify(review);
    // 256 KiB keeps the phone's review bounded without ever cutting a message in half.
    return Buffer.byteLength(encoded, 'utf8') <= 262_144 ? encoded : undefined;
  } catch {
    return undefined;
  }
}
