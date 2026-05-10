import type { RuntimeConfig } from '../config/runtime-config.js';
import { formatModelForDisplay } from '../providers/model-names.js';
import type { MediaContextItem } from '../types/container.js';

export type ConciergeProfile = 'asap' | 'balanced' | 'no_hurry';

export interface PendingConciergeState {
  originalUserContent: string;
  createdAt: string;
  media: MediaContextItem[];
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeConciergeProfileName(
  value: string,
): ConciergeProfile | null {
  const normalized = normalizeToken(String(value || ''));
  if (!normalized) return null;
  if (normalized === 'asap') return 'asap';
  if (normalized === 'balanced') return 'balanced';
  if (
    normalized === 'no_hurry' ||
    normalized === 'no-hurry' ||
    normalized === 'no hurry'
  ) {
    return 'no_hurry';
  }
  return null;
}

export function buildConciergeQuestion(opts?: {
  invalidChoice?: boolean;
}): string {
  const prefix = opts?.invalidChoice ? 'Please reply with 1, 2, or 3.\n\n' : '';
  return (
    `${prefix}This might take a while. When do you need the result?\n` +
    '1) As soon as possible\n' +
    '2) Can wait a bit\n' +
    '3) No hurry'
  );
}

export function parseConciergeChoice(content: string): ConciergeProfile | null {
  const normalized = normalizeToken(String(content || ''));
  if (!normalized) return null;
  if (
    normalized === '1' ||
    normalized === 'asap' ||
    normalized === 'as soon as possible'
  ) {
    return 'asap';
  }
  if (
    normalized === '2' ||
    normalized === 'balanced' ||
    normalized === 'can wait a bit'
  ) {
    return 'balanced';
  }
  if (
    normalized === '3' ||
    normalized === 'no hurry' ||
    normalized === 'no_hurry' ||
    normalized === 'no-hurry'
  ) {
    return 'no_hurry';
  }
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => normalizeToken(line))
    .filter(Boolean);
  if (lines.length > 1) {
    return parseConciergeChoice(lines[lines.length - 1]);
  }
  return normalizeConciergeProfileName(normalized);
}

export function resolveConciergeProfileModel(
  config: RuntimeConfig,
  profile: ConciergeProfile,
): string {
  if (profile === 'asap') return config.routing.concierge.profiles.asap.trim();
  if (profile === 'balanced') {
    return config.routing.concierge.profiles.balanced.trim();
  }
  return config.routing.concierge.profiles.noHurry.trim();
}

export function buildConciergeResumePrompt(
  originalUserContent: string,
  profile: ConciergeProfile,
): string {
  const label =
    profile === 'asap'
      ? 'As soon as possible'
      : profile === 'balanced'
        ? 'Can wait a bit'
        : 'No hurry';
  return `${originalUserContent}\n\n[ExecutionPreference]\nUser selected: ${label}`;
}

export function buildConciergeExecutionNotice(
  profile: ConciergeProfile,
  model: string,
): string | null {
  if (profile === 'asap') return null;
  const eta =
    profile === 'balanced' ? 'about 2 to 5 minutes' : 'about 10 to 20 minutes';
  return `Using \`${formatModelForDisplay(model)}\`. Expected ready in ${eta}.\n\n`;
}
