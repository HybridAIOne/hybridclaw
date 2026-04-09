import {
  getRuntimeConfig,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import { logger } from '../logger.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import { formatModelForDisplay } from '../providers/model-names.js';
import type { ChatMessage } from '../types/api.js';
import type { MediaContextItem } from '../types/container.js';

export type ConciergeProfile = 'asap' | 'balanced' | 'no_hurry';

export interface PendingConciergeState {
  originalUserContent: string;
  createdAt: string;
  media: MediaContextItem[];
}

export type ConciergeDecision =
  | { kind: 'ask_user' }
  | { kind: 'pick_profile'; profile: ConciergeProfile };

const LONG_TASK_HINT_RE =
  /\b(create|draft|write|generate|build|produce|prepare|plan|report|proposal|strategy|analysis|marketing plan|presentation|slides?|deck|document|pdf|docx|pptx|xlsx|spreadsheet|roadmap|spec)\b/i;
const ASAP_RE =
  /\b(asap|urgent|immediately|right away|as soon as possible|need it now|right now)\b/i;
const NO_HURRY_RE =
  /\b(no hurry|whenever|take your time|not urgent|can wait|no rush)\b/i;
const BALANCED_RE =
  /\b(can wait a bit|later today|soon but not urgent|not immediately)\b/i;

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

export function inferPromptUrgencyProfile(
  content: string,
): ConciergeProfile | null {
  const normalized = String(content || '').trim();
  if (!normalized) return null;
  if (ASAP_RE.test(normalized)) return 'asap';
  if (NO_HURRY_RE.test(normalized)) return 'no_hurry';
  if (BALANCED_RE.test(normalized)) return 'balanced';
  return null;
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

export function shouldTriggerConcierge(
  content: string,
  opts?: {
    explicitModelPinned?: boolean;
    interactiveOnly?: boolean;
  },
): boolean {
  if (opts?.interactiveOnly === false) return false;
  if (opts?.explicitModelPinned) return false;

  const normalized = String(content || '').trim();
  if (!normalized) return false;
  if (inferPromptUrgencyProfile(normalized)) return false;

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount < 6 && !LONG_TASK_HINT_RE.test(normalized)) return false;

  return LONG_TASK_HINT_RE.test(normalized) || normalized.length >= 140;
}

export function parseConciergeDecision(
  content: string,
): ConciergeDecision | null {
  const trimmed = String(content || '').trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const rawDecision =
    typeof record.decision === 'string'
      ? record.decision
      : typeof record.action === 'string'
        ? record.action
        : '';
  const decision = normalizeToken(rawDecision);
  if (decision === 'ask_user') return { kind: 'ask_user' };
  if (decision !== 'pick_profile') return null;

  const rawProfile =
    typeof record.profile === 'string'
      ? record.profile
      : typeof record.mode === 'string'
        ? record.mode
        : '';
  const profile = parseConciergeChoice(rawProfile);
  if (!profile) return null;
  return { kind: 'pick_profile', profile };
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

export async function decideConciergeRouting(params: {
  content: string;
  agentId?: string;
  chatbotId?: string;
}): Promise<ConciergeDecision> {
  const config = getRuntimeConfig();
  const model = config.routing.concierge.model.trim();
  if (!config.routing.concierge.enabled || !model) {
    return { kind: 'ask_user' };
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a routing concierge for HybridClaw. Decide whether the user should be asked about urgency, or whether the urgency is already clear from the request. Respond with JSON only. Valid shapes: {"decision":"ask_user"} or {"decision":"pick_profile","profile":"asap"} or {"decision":"pick_profile","profile":"balanced"} or {"decision":"pick_profile","profile":"no_hurry"}. Choose pick_profile only when urgency is explicit in the request.',
    },
    {
      role: 'user',
      content: params.content,
    },
  ];

  try {
    const result = await callAuxiliaryModel({
      task: 'skills_hub',
      messages,
      fallbackChatbotId: params.chatbotId,
      fallbackEnableRag: false,
      agentId: params.agentId,
      provider: 'auto',
      model,
      maxTokens: 80,
      temperature: 0,
      timeoutMs: 5_000,
    });
    return parseConciergeDecision(result.content) ?? { kind: 'ask_user' };
  } catch (error) {
    logger.debug({ error, model }, 'Concierge routing fell back to ask_user');
    return { kind: 'ask_user' };
  }
}
