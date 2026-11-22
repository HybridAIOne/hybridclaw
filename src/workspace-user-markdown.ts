/**
 * USER.md markdown primitives: `- **Field:** value` lines and `## Section`
 * bodies, plus the Welcome Message section that records whether the agent's
 * welcome email went out (`sent`) or was given up on (`skipped`).
 *
 * Pure string functions; reading and writing the file stays with the callers
 * (`workspace.ts`, `gateway/first-turn-welcome-mail.ts`).
 */
import { escapeRegExp } from '@hybridclaw/shared/regex';

const WELCOME_MESSAGE_SECTION = 'Welcome Message';

export function cleanMarkdownInline(value: string | undefined): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[<>]/g, '')
    .trim();
}

export function markdownFieldPattern(fieldName: string): RegExp {
  return new RegExp(
    `^([ \\t]*)-[ \\t]*\\*\\*${escapeRegExp(fieldName)}:\\*\\*[ \\t]*([^\\r\\n]*)$`,
    'im',
  );
}

export function readMarkdownField(content: string, fieldName: string): string {
  const value = cleanMarkdownInline(
    content.match(markdownFieldPattern(fieldName))?.[2],
  );
  // The template's hints, such as `_(optional)_`, are not values.
  return /^_\(.*\)_$/.test(value) ? '' : value;
}

function replaceMarkdownSection(
  content: string,
  title: string,
  nextBody: string[],
): string {
  const lines = content.split(/\r?\n/);
  const nextLines: string[] = [];
  let inSection = false;
  let replaced = false;

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (inSection) {
        nextLines.push(...nextBody, '', line);
        inSection = false;
        replaced = true;
        continue;
      }
      inSection = line.trim().toLowerCase() === `## ${title.toLowerCase()}`;
    }

    if (!inSection) {
      nextLines.push(line);
    } else if (/^##\s+/.test(line)) {
      nextLines.push(line);
    }
  }

  if (inSection) {
    nextLines.push(...nextBody, '');
    replaced = true;
  }

  if (!replaced) {
    nextLines.push('', `## ${title}`, '', ...nextBody, '');
  }

  return `${nextLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

function replaceMarkdownField(
  content: string,
  fieldName: string,
  nextValue: string,
  options: { onlyIfMissing?: boolean } = {},
): string {
  const escaped = escapeRegExp(fieldName);
  const fieldPattern = new RegExp(
    `^(\\s*-\\s*\\*\\*${escaped}:\\*\\*[ \\t]*)([^\\r\\n]*)$`,
    'im',
  );
  const existing = content.match(fieldPattern)?.[2]?.trim() || '';
  if (
    options.onlyIfMissing &&
    existing &&
    !/\b(?:pending|unknown|to be determined|tbd|none)\b/i.test(existing)
  ) {
    return content;
  }
  if (fieldPattern.test(content)) {
    return content.replace(
      fieldPattern,
      (_match, prefix: string) =>
        `${prefix}${/[ \t]$/.test(prefix) ? '' : ' '}${nextValue}`,
    );
  }
  return content.replace(
    /^(-\s+\*\*What to call them:\*\*.*)$/im,
    `$1\n- **${fieldName}:** ${nextValue}`,
  );
}

function readMarkdownSection(content: string, title: string): string {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === `## ${title.toLowerCase()}`,
  );
  if (start < 0) return '';
  const end = lines.findIndex(
    (line, index) => index > start && /^##\s+/.test(line),
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/** The Welcome Message status in USER.md: `pending`, `sent`, `skipped`, or ''. */
export function readWelcomeMessageStatus(content: string): string {
  return readMarkdownField(
    readMarkdownSection(content, WELCOME_MESSAGE_SECTION),
    'Status',
  ).toLowerCase();
}

export function writeWelcomeMessage(
  content: string,
  params: {
    status: 'sent' | 'skipped';
    recipient: string;
    subject?: string;
    handledAt?: string;
  },
): string {
  const recipient = cleanMarkdownInline(params.recipient);
  const handledAt =
    cleanMarkdownInline(params.handledAt) || new Date().toISOString();
  const sent = params.status === 'sent';
  const subject = sent ? cleanMarkdownInline(params.subject) || 'Welcome' : '';
  const next = sent
    ? replaceMarkdownField(content, 'Email', recipient, { onlyIfMissing: true })
    : content;
  return replaceMarkdownSection(next, WELCOME_MESSAGE_SECTION, [
    `- **Status:** ${params.status}`,
    `- **Recipient:** ${recipient}`,
    `- **Subject:** ${subject}`,
    `- **Delivery:** ${sent ? 'email' : 'not sent'}`,
    `- **Last handled:** ${handledAt}`,
  ]);
}
