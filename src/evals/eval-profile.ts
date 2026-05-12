import {
  isPromptPartName,
  PROMPT_PART_NAMES,
  type PromptPartName,
} from '../agent/prompt-parts.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { normalizeTrimmedString as normalizeString } from '../utils/normalized-strings.js';

export type EvalWorkspaceMode = 'current-agent' | 'fresh-agent';

export interface EvalProfile {
  workspaceMode: EvalWorkspaceMode;
  ablateSystemPrompt: boolean;
  includePromptParts: PromptPartName[];
  omitPromptParts: PromptPartName[];
  agentId?: string;
}

export const EVAL_MODEL_PROFILE_MARKER = '__hc_eval=';

const KNOWN_FLAGS = new Set(['current-agent', 'fresh-agent', 'ablate-system']);
const KNOWN_PROMPT_PARTS = new Set<PromptPartName>(PROMPT_PART_NAMES);

function normalizeAgentId(agentId: string | null | undefined): string {
  return normalizeString(agentId);
}

export function buildDefaultEvalProfile(agentId?: string | null): EvalProfile {
  const normalizedAgentId = normalizeAgentId(agentId);
  return {
    workspaceMode: 'current-agent',
    ablateSystemPrompt: false,
    includePromptParts: [],
    omitPromptParts: [],
    ...(normalizedAgentId && normalizedAgentId !== DEFAULT_AGENT_ID
      ? { agentId: normalizedAgentId }
      : {}),
  };
}

export function isDefaultEvalProfile(profile: EvalProfile): boolean {
  return (
    profile.workspaceMode === 'current-agent' &&
    !profile.ablateSystemPrompt &&
    profile.includePromptParts.length === 0 &&
    profile.omitPromptParts.length === 0 &&
    normalizeAgentId(profile.agentId) === ''
  );
}

function normalizePromptPartList(parts: PromptPartName[]): PromptPartName[] {
  return Array.from(
    new Set(
      parts
        .map((part) => normalizeString(part).toLowerCase() as PromptPartName)
        .filter((part): part is PromptPartName => KNOWN_PROMPT_PARTS.has(part)),
    ),
  ).sort();
}

export function isKnownEvalPromptPart(value: string): value is PromptPartName {
  return isPromptPartName(value);
}

function encodePromptPartList(parts: PromptPartName[]): string {
  return normalizePromptPartList(parts).map(encodeURIComponent).join('+');
}

function decodePromptPartList(
  rawValue: string,
  label: string,
): PromptPartName[] {
  const decodedParts = rawValue
    .split('+')
    .map((entry) => normalizeString(decodeURIComponent(normalizeString(entry))))
    .filter(Boolean);
  if (decodedParts.length === 0) {
    throw new Error(`Invalid HybridClaw eval ${label} prompt profile.`);
  }
  const normalized = normalizePromptPartList(decodedParts as PromptPartName[]);
  if (normalized.length !== decodedParts.length) {
    throw new Error(`Unknown HybridClaw eval prompt part in ${label} list.`);
  }
  return normalized;
}

export function encodeEvalProfileModel(
  model: string,
  profile: EvalProfile,
): string {
  const normalizedModel = normalizeString(model) || 'hybridai/gpt-4.1-mini';
  if (isDefaultEvalProfile(profile)) return normalizedModel;

  const flags: string[] = [];
  if (profile.workspaceMode === 'fresh-agent') {
    flags.push('fresh-agent');
  }
  if (profile.ablateSystemPrompt) {
    flags.push('ablate-system');
  }
  if (profile.includePromptParts.length > 0) {
    flags.push(`include=${encodePromptPartList(profile.includePromptParts)}`);
  }
  if (profile.omitPromptParts.length > 0) {
    flags.push(`omit=${encodePromptPartList(profile.omitPromptParts)}`);
  }
  const normalizedAgentId = normalizeAgentId(profile.agentId);
  if (normalizedAgentId) {
    flags.push(`agent=${encodeURIComponent(normalizedAgentId)}`);
  }
  if (flags.length === 0) return normalizedModel;
  return `${normalizedModel}${EVAL_MODEL_PROFILE_MARKER}${flags.join(',')}`;
}

export function parseEvalProfileModel(model: string): {
  model: string;
  profile: EvalProfile;
} {
  const normalizedModel = normalizeString(model);
  const markerIndex = normalizedModel.indexOf(EVAL_MODEL_PROFILE_MARKER);
  if (markerIndex === -1) {
    return {
      model: normalizedModel,
      profile: buildDefaultEvalProfile(),
    };
  }

  const baseModel = normalizeString(normalizedModel.slice(0, markerIndex));
  const rawFlags = normalizeString(
    normalizedModel.slice(markerIndex + EVAL_MODEL_PROFILE_MARKER.length),
  );
  if (!baseModel || !rawFlags) {
    throw new Error('Invalid HybridClaw eval model profile.');
  }

  const profile = buildDefaultEvalProfile();
  for (const rawEntry of rawFlags.split(',')) {
    const entry = normalizeString(rawEntry);
    if (!entry) continue;
    if (entry.startsWith('agent=')) {
      const encoded = normalizeString(entry.slice('agent='.length));
      const agentId = normalizeAgentId(decodeURIComponent(encoded));
      if (!agentId) {
        throw new Error('Invalid HybridClaw eval agent profile.');
      }
      profile.agentId = agentId;
      continue;
    }
    if (entry.startsWith('include=')) {
      profile.includePromptParts = decodePromptPartList(
        normalizeString(entry.slice('include='.length)),
        'include',
      );
      continue;
    }
    if (entry.startsWith('omit=')) {
      profile.omitPromptParts = decodePromptPartList(
        normalizeString(entry.slice('omit='.length)),
        'omit',
      );
      continue;
    }
    if (!KNOWN_FLAGS.has(entry)) {
      throw new Error(`Unknown HybridClaw eval profile flag: ${entry}`);
    }
    switch (entry) {
      case 'current-agent':
        profile.workspaceMode = 'current-agent';
        break;
      case 'fresh-agent':
        profile.workspaceMode = 'fresh-agent';
        break;
      case 'ablate-system':
        profile.ablateSystemPrompt = true;
        break;
    }
  }

  if (profile.workspaceMode === 'fresh-agent') {
    delete profile.agentId;
  }

  return {
    model: baseModel,
    profile: {
      ...profile,
      includePromptParts: normalizePromptPartList(profile.includePromptParts),
      omitPromptParts: normalizePromptPartList(profile.omitPromptParts),
    },
  };
}

export function describeEvalProfile(profile: EvalProfile): string[] {
  const normalizedAgentId = normalizeAgentId(profile.agentId);
  const setup =
    profile.workspaceMode === 'fresh-agent'
      ? 'fresh temporary agent workspace'
      : normalizedAgentId
        ? `current agent workspace (${normalizedAgentId})`
        : 'current agent workspace';
  return [
    `Agent setup: ${setup}`,
    'Session state: fresh transient OpenAI-compatible session per request',
    `System prompt: ${profile.ablateSystemPrompt ? 'ablated' : 'enabled'}`,
    `Prompt include: ${
      profile.includePromptParts.length > 0
        ? profile.includePromptParts.join(', ')
        : 'default'
    }`,
    `Prompt omit: ${
      profile.omitPromptParts.length > 0
        ? profile.omitPromptParts.join(', ')
        : 'none'
    }`,
    `Workspace MEMORY.md: ${
      profile.workspaceMode === 'fresh-agent'
        ? 'fresh template file'
        : 'current agent file'
    }`,
  ];
}
