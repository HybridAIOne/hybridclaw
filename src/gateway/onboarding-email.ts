import fs from 'node:fs';
import path from 'node:path';

import {
  isEmailAddress,
  normalizeEmailAddress,
} from '../channels/email/allowlist.js';
import {
  type EmailTextSendOptions,
  sendToEmail,
} from '../channels/email/runtime.js';
import type { ToolExecution } from '../types/execution.js';
import { parseJsonObject } from '../utils/json-object.js';

type StartupBootstrapFile = 'BOOTSTRAP.md' | 'OPENING.md' | null;

export type OnboardingFirstJobsEmailResult =
  | { status: 'skipped'; reason: string }
  | {
      status: 'already-sent';
      recipient: string;
      subject: string;
      delivery: string;
    }
  | {
      status: 'sent';
      recipient: string;
      subject: string;
      delivery: string;
      notice: string;
    }
  | {
      status: 'failed';
      recipient: string;
      subject: string;
      delivery: string;
      notice: string;
      error: unknown;
    };

export interface MaybeSendOnboardingFirstJobsEmailParams {
  workspacePath: string;
  agentName: string;
  startupBootstrapFile: StartupBootstrapFile;
  toolExecutions: ToolExecution[];
  pendingApproval?: boolean;
  now?: Date;
  sendEmail?: (
    to: string,
    text: string,
    options?: EmailTextSendOptions,
  ) => Promise<void>;
}

interface UserOnboardingProfile {
  content: string;
  userPath: string;
  name: string | null;
  callName: string | null;
  email: string;
  primaryWork: string | null;
  goals: string | null;
  tools: string | null;
  workingStyle: string | null;
  helpfulLinks: Array<{ label: string; value: string }>;
  suggestedJobs: string[];
  firstJobsEmailStatus: string | null;
  firstJobsEmailSubject: string | null;
}

const MISSING_VALUE_RE =
  /\b(?:pending|unknown|to be determined|tbd|none|n\/a)\b/i;

function sanitizeInline(value: string | null | undefined): string | null {
  const trimmed = String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!trimmed || MISSING_VALUE_RE.test(trimmed) || trimmed.startsWith('_(')) {
    return null;
  }
  return trimmed;
}

function stripMarkdownEmphasis(value: string): string {
  return value.replace(/[*_`]+/g, '').trim();
}

function readMarkdownField(content: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(
    new RegExp(`^\\s*-\\s*\\*\\*${escaped}:\\*\\*\\s*(.+)$`, 'im'),
  );
  return sanitizeInline(match?.[1]);
}

function readMarkdownSection(content: string, title: string): string {
  const body: string[] = [];
  let inSection = false;

  for (const line of content.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) {
      if (inSection) break;
      inSection = line.trim().toLowerCase() === `## ${title.toLowerCase()}`;
      continue;
    }
    if (inSection) body.push(line);
  }

  return body.join('\n');
}

function readSectionField(section: string, label: string): string | null {
  return readMarkdownField(section, label);
}

function readHelpfulLinks(
  content: string,
): Array<{ label: string; value: string }> {
  const section = readMarkdownSection(content, 'Helpful Links');
  const links: Array<{ label: string; value: string }> = [];
  for (const label of [
    'Agent chat',
    'WhatsApp channel setup',
    'Documentation',
  ]) {
    const value = readSectionField(section, label);
    if (value) links.push({ label, value });
  }
  return links;
}

function readSuggestedJobs(content: string): string[] {
  const section = readMarkdownSection(content, 'Suggested First Jobs');
  const jobs: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:[-*]\s+|\d+[.)]\s+)(.+)$/);
    const job = sanitizeInline(match?.[1]);
    if (!job) continue;
    if (
      /\b(?:after hatching|practical jobs|\[specific job|todo|tbd)\b/i.test(job)
    ) {
      continue;
    }
    jobs.push(stripMarkdownEmphasis(job));
  }
  return jobs.slice(0, 8);
}

function readUserOnboardingProfile(
  workspacePath: string,
): UserOnboardingProfile | null {
  const userPath = path.join(workspacePath, 'USER.md');
  if (!fs.existsSync(userPath)) return null;
  const content = fs.readFileSync(userPath, 'utf-8');
  const email = normalizeEmailAddress(
    readMarkdownField(content, 'Email') || '',
  );
  if (!email) return null;

  const firstJobsEmail = readMarkdownSection(content, 'First Jobs Email');
  return {
    content,
    userPath,
    name: readMarkdownField(content, 'Name'),
    callName: readMarkdownField(content, 'What to call them'),
    email,
    primaryWork: readMarkdownField(content, 'Primary work / activity'),
    goals: readMarkdownField(content, 'HybridClaw goals'),
    tools: readMarkdownField(content, 'Important tools and platforms'),
    workingStyle: readMarkdownField(content, 'Preferred working style'),
    helpfulLinks: readHelpfulLinks(content),
    suggestedJobs: readSuggestedJobs(content),
    firstJobsEmailStatus: readSectionField(firstJobsEmail, 'Status'),
    firstJobsEmailSubject: readSectionField(firstJobsEmail, 'Subject'),
  };
}

function hasSentStatus(status: string | null): boolean {
  return /^sent\b/i.test(status || '');
}

function formatDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function resolveSubject(profile: UserOnboardingProfile): string {
  const existing = sanitizeInline(profile.firstJobsEmailSubject);
  if (existing) return existing;

  const focus = profile.primaryWork || profile.goals;
  if (focus) {
    return `First HybridClaw jobs for ${stripMarkdownEmphasis(focus).slice(0, 72)}`;
  }
  const name = profile.callName || profile.name;
  return name
    ? `A few first HybridClaw jobs for ${name}`
    : 'A few first HybridClaw jobs for you';
}

function buildEmailBody(params: {
  profile: UserOnboardingProfile;
  agentName: string;
}): string {
  const { profile } = params;
  const greeting = profile.callName || profile.name || 'there';
  const lines = [
    `Hi ${greeting},`,
    '',
    `I'm set up now, and I wanted to send you a concrete starting point for working with ${params.agentName}.`,
  ];

  const contextParts = [
    profile.primaryWork ? `your work around ${profile.primaryWork}` : null,
    profile.goals ? `your goals for ${profile.goals}` : null,
    profile.tools ? `the tools you mentioned (${profile.tools})` : null,
  ].filter((part): part is string => Boolean(part));
  if (contextParts.length > 0) {
    lines.push(
      '',
      `Based on ${contextParts.join(', ')}, here are a few good first jobs:`,
    );
  } else {
    lines.push('', 'Here are a few good first jobs:');
  }

  lines.push('', ...profile.suggestedJobs.map((job) => `- ${job}`));

  if (profile.helpfulLinks.length > 0) {
    lines.push('', 'Useful links:');
    for (const link of profile.helpfulLinks) {
      lines.push(`- ${link.label}: ${link.value}`);
    }
  }

  if (profile.workingStyle) {
    lines.push(
      '',
      `I'll keep your working style in mind: ${profile.workingStyle}.`,
    );
  }

  lines.push(
    '',
    'Send me any one of these when you want to start, or hand me the messy version and I will turn it into next steps.',
    '',
    params.agentName,
  );

  return lines.join('\n');
}

function replaceFirstJobsEmailSection(params: {
  content: string;
  status: string;
  recipient: string;
  subject: string;
  delivery: string;
  date: string;
}): string {
  const replacement = [
    '## First Jobs Email',
    '',
    `- **Status:** ${params.status}`,
    `- **Recipient:** ${params.recipient}`,
    `- **Subject:** ${params.subject}`,
    `- **Delivery:** ${params.delivery}`,
    `- **Last handled:** ${params.date}`,
  ];
  const lines = params.content.replace(/\s+$/u, '').split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === '## first jobs email',
  );
  if (start === -1) {
    return `${lines.join('\n')}\n\n${replacement.join('\n')}\n`;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^##\s+/.test(line) || line === '---') {
      end = index;
      break;
    }
  }

  return [...lines.slice(0, start), ...replacement, '', ...lines.slice(end)]
    .join('\n')
    .replace(/\s+$/u, '\n');
}

function writeFirstJobsEmailStatus(params: {
  profile: UserOnboardingProfile;
  status: string;
  subject: string;
  delivery: string;
  now: Date;
}): void {
  fs.writeFileSync(
    params.profile.userPath,
    replaceFirstJobsEmailSection({
      content: params.profile.content,
      status: params.status,
      recipient: params.profile.email,
      subject: params.subject,
      delivery: params.delivery,
      date: formatDate(params.now),
    }),
    'utf-8',
  );
}

function resolveExecutionEmailTarget(execution: ToolExecution): string | null {
  const args = parseJsonObject(execution.arguments || '{}');
  const result = parseJsonObject(execution.result || '{}');
  const values = [args?.channelId, args?.to, args?.target, result?.channelId];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = normalizeEmailAddress(value);
    if (normalized) return normalized;
  }
  return null;
}

function hasSuccessfulEmailSend(params: {
  toolExecutions: ToolExecution[];
  recipient: string;
}): boolean {
  for (const execution of params.toolExecutions) {
    if (
      execution.name !== 'message' ||
      execution.isError ||
      execution.blocked
    ) {
      continue;
    }
    const args = parseJsonObject(execution.arguments || '{}');
    const result = parseJsonObject(execution.result || '{}');
    const action = String(result?.action || args?.action || '').toLowerCase();
    if (action !== 'send') continue;
    if (result?.ok === false) continue;
    if (String(result?.transport || '').toLowerCase() !== 'email') continue;
    if (resolveExecutionEmailTarget(execution) !== params.recipient) continue;
    return true;
  }
  return false;
}

function formatFailureStatus(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (
    /not configured|missing|disabled|not active|shutting down/i.test(message)
  ) {
    return 'send failed - email channel unavailable';
  }
  return 'send failed - automatic send failed';
}

export async function maybeSendOnboardingFirstJobsEmail(
  params: MaybeSendOnboardingFirstJobsEmailParams,
): Promise<OnboardingFirstJobsEmailResult> {
  if (params.startupBootstrapFile !== 'BOOTSTRAP.md') {
    return { status: 'skipped', reason: 'bootstrap_not_active' };
  }
  if (params.pendingApproval) {
    return { status: 'skipped', reason: 'pending_approval' };
  }

  const profile = readUserOnboardingProfile(params.workspacePath);
  if (!profile) return { status: 'skipped', reason: 'missing_user_email' };
  if (hasSentStatus(profile.firstJobsEmailStatus)) {
    return { status: 'skipped', reason: 'already_marked_sent' };
  }
  if (profile.suggestedJobs.length === 0) {
    return { status: 'skipped', reason: 'missing_suggested_jobs' };
  }
  if (!isEmailAddress(profile.email)) {
    return { status: 'skipped', reason: 'invalid_email' };
  }

  const now = params.now || new Date();
  const subject = resolveSubject(profile);
  const delivery = `email channel, ${formatDate(now)}`;
  if (
    hasSuccessfulEmailSend({
      toolExecutions: params.toolExecutions,
      recipient: profile.email,
    })
  ) {
    writeFirstJobsEmailStatus({
      profile,
      status: 'sent',
      subject,
      delivery,
      now,
    });
    return {
      status: 'already-sent',
      recipient: profile.email,
      subject,
      delivery,
    };
  }

  const body = buildEmailBody({
    profile,
    agentName: sanitizeInline(params.agentName) || 'HybridClaw',
  });
  try {
    await (params.sendEmail || sendToEmail)(profile.email, body, {
      subject,
      fromName: sanitizeInline(params.agentName),
    });
    writeFirstJobsEmailStatus({
      profile,
      status: 'sent',
      subject,
      delivery,
      now,
    });
    return {
      status: 'sent',
      recipient: profile.email,
      subject,
      delivery,
      notice: `I sent the first-jobs email to ${profile.email}.`,
    };
  } catch (error) {
    const status = formatFailureStatus(error);
    writeFirstJobsEmailStatus({
      profile,
      status,
      subject,
      delivery: 'not sent',
      now,
    });
    return {
      status: 'failed',
      recipient: profile.email,
      subject,
      delivery: 'not sent',
      notice:
        'I could not send the first-jobs email automatically because the email channel was not available.',
      error,
    };
  }
}
