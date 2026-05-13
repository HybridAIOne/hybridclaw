import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const CONCIERGE_PENDING_STATE_KEY = 'plugins.concierge-router.pending';
export const CONCIERGE_ROUTING_METADATA_KEY = 'conciergeRouter';

const LONG_TASK_HINT_RE =
  /\b(create|draft|write|generate|build|produce|prepare|plan|report|proposal|strategy|analysis|marketing plan|presentation|slides?|deck|document|pdf|docx|pptx|xlsx|spreadsheet|roadmap|spec)\b/i;
const ASAP_RE =
  /\b(asap|urgent|immediately|right away|as soon as possible|need it now|right now)\b/i;
const NO_HURRY_RE =
  /\b(no hurry|whenever|take your time|not urgent|can wait|no rush)\b/i;
const BALANCED_RE =
  /\b(can wait a bit|later today|soon but not urgent|not immediately)\b/i;

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export function normalizeConciergeProfileName(value) {
  const normalized = normalizeToken(value);
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

export function buildConciergeQuestion(opts = {}) {
  const prefix = opts.invalidChoice ? 'Please reply with 1, 2, or 3.\n\n' : '';
  return (
    `${prefix}This might take a while. When do you need the result?\n` +
    '1) As soon as possible\n' +
    '2) Can wait a bit\n' +
    '3) No hurry'
  );
}

export function inferPromptUrgencyProfile(content) {
  const normalized = String(content || '').trim();
  if (!normalized) return null;
  if (ASAP_RE.test(normalized)) return 'asap';
  if (NO_HURRY_RE.test(normalized)) return 'no_hurry';
  if (BALANCED_RE.test(normalized)) return 'balanced';
  return null;
}

export function parseConciergeChoice(content) {
  const normalized = normalizeToken(content);
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
  content,
  opts = { explicitModelPinned: false, interactiveOnly: true },
) {
  if (opts.interactiveOnly === false) return false;
  if (opts.explicitModelPinned) return false;

  const normalized = String(content || '').trim();
  if (!normalized) return false;
  if (inferPromptUrgencyProfile(normalized)) return false;

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount < 6 && !LONG_TASK_HINT_RE.test(normalized)) return false;

  return LONG_TASK_HINT_RE.test(normalized) || normalized.length >= 140;
}

export function parseConciergeDecision(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const rawDecision =
    typeof parsed.decision === 'string'
      ? parsed.decision
      : typeof parsed.action === 'string'
        ? parsed.action
        : '';
  const decision = normalizeToken(rawDecision);
  if (decision === 'ask_user') return { kind: 'ask_user' };
  if (decision !== 'pick_profile') return null;

  const rawProfile =
    typeof parsed.profile === 'string'
      ? parsed.profile
      : typeof parsed.mode === 'string'
        ? parsed.mode
        : '';
  const profile = parseConciergeChoice(rawProfile);
  if (!profile) return null;
  return { kind: 'pick_profile', profile };
}

export function resolveConciergeProfileModel(config, profile) {
  const profiles = config?.profiles || {};
  if (profile === 'asap') return String(profiles.asap || '').trim();
  if (profile === 'balanced') return String(profiles.balanced || '').trim();
  return String(profiles.noHurry || profiles.no_hurry || '').trim();
}

export function buildConciergeResumePrompt(originalUserContent, profile) {
  const label =
    profile === 'asap'
      ? 'As soon as possible'
      : profile === 'balanced'
        ? 'Can wait a bit'
        : 'No hurry';
  return `${originalUserContent}\n\n[ExecutionPreference]\nUser selected: ${label}`;
}

export function buildConciergeExecutionNotice(profile, model) {
  if (profile === 'asap') return null;
  const eta =
    profile === 'balanced' ? 'about 2 to 5 minutes' : 'about 10 to 20 minutes';
  return `Using \`${formatModelForDisplay(model)}\`. Expected ready in ${eta}.\n\n`;
}

function formatModelForDisplay(model) {
  const trimmed = String(model || '').trim();
  if (!trimmed) return '';
  if (
    /^(hybridai|openai|openai-codex|anthropic|openrouter|mistral|huggingface|ollama|lmstudio|llamacpp|vllm)\//i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  return `hybridai/${trimmed}`;
}

export function buildConciergeChoiceCustomId(params) {
  return `concierge:${params.profile}:${params.userId}:${encodeURIComponent(params.sessionId)}`;
}

export function parseConciergeChoiceCustomId(customId) {
  const match = String(customId || '').match(
    /^concierge:(asap|balanced|no_hurry):(\d{16,22}):(.+)$/,
  );
  if (!match) return null;
  const [, profile, userId, encodedSessionId] = match;
  try {
    return {
      profile,
      userId,
      sessionId: decodeURIComponent(encodedSessionId),
    };
  } catch {
    return null;
  }
}

export function buildConciergeChoiceComponents(params) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: 'As soon as possible',
          custom_id: buildConciergeChoiceCustomId({
            profile: 'asap',
            sessionId: params.sessionId,
            userId: params.userId,
          }),
        },
        {
          type: 2,
          style: 1,
          label: 'Can wait a bit',
          custom_id: buildConciergeChoiceCustomId({
            profile: 'balanced',
            sessionId: params.sessionId,
            userId: params.userId,
          }),
        },
        {
          type: 2,
          style: 2,
          label: 'No hurry',
          custom_id: buildConciergeChoiceCustomId({
            profile: 'no_hurry',
            sessionId: params.sessionId,
            userId: params.userId,
          }),
        },
      ],
    },
  ];
}

export function resolveConciergeConfig(api) {
  const legacy = api.config?.routing?.concierge || {};
  const plugin = api.pluginConfig || {};
  const profiles = plugin.profiles || legacy.profiles || {};
  return {
    enabled:
      typeof plugin.enabled === 'boolean'
        ? plugin.enabled
        : Boolean(legacy.enabled),
    model: String(plugin.model || legacy.model || 'gemini-3-flash').trim(),
    webhookSecret: String(
      plugin.webhookSecret || legacy.webhookSecret || '',
    ).trim(),
    profiles: {
      asap: String(profiles.asap || 'gpt-5').trim(),
      balanced: String(profiles.balanced || 'gpt-5-mini').trim(),
      noHurry: String(
        profiles.noHurry || profiles.no_hurry || 'gpt-5-nano',
      ).trim(),
    },
  };
}

export function resolvePendingStatePath(api) {
  const stateScope = crypto
    .createHash('sha256')
    .update(`${api.runtime.homeDir}\n${api.runtime.cwd}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(
    api.runtime.homeDir,
    '.hybridclaw',
    'plugin-state',
    'concierge-router',
    `pending-${stateScope}.json`,
  );
}

export function createPendingStore(api) {
  const statePath = resolvePendingStatePath(api);
  let cache = null;
  let loadPromise = null;
  let writeQueue = Promise.resolve();

  async function readAll() {
    if (cache) return cache;
    if (!loadPromise) {
      loadPromise = fs
        .readFile(statePath, 'utf-8')
        .then((raw) => {
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
        })
        .catch(() => ({}));
    }
    cache = await loadPromise;
    return cache;
  }

  async function writeAll(value) {
    cache = value;
    const snapshot = structuredClone(value);
    writeQueue = writeQueue
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(statePath), { recursive: true });
        const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(
          tempPath,
          `${JSON.stringify(snapshot, null, 2)}\n`,
          'utf-8',
        );
        await fs.rename(tempPath, statePath);
      });
    return writeQueue;
  }

  function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const originalUserContent =
      typeof entry.originalUserContent === 'string'
        ? entry.originalUserContent.trim()
        : '';
    if (!originalUserContent) return null;
    return {
      originalUserContent,
      createdAt:
        typeof entry.createdAt === 'string'
          ? entry.createdAt
          : new Date().toISOString(),
      media: Array.isArray(entry.media) ? entry.media : [],
      userId: typeof entry.userId === 'string' ? entry.userId.trim() : '',
      channelId:
        typeof entry.channelId === 'string' ? entry.channelId.trim() : '',
      agentId: typeof entry.agentId === 'string' ? entry.agentId.trim() : '',
      chatbotId:
        typeof entry.chatbotId === 'string' ? entry.chatbotId.trim() : '',
    };
  }

  return {
    async get(sessionId) {
      const entry = (await readAll())[sessionId];
      return normalizeEntry(entry);
    },
    async set(sessionId, state) {
      const all = await readAll();
      all[sessionId] = state;
      await writeAll(all);
    },
    async delete(sessionId) {
      const all = await readAll();
      if (!(sessionId in all)) return;
      delete all[sessionId];
      await writeAll(all);
    },
    async has(sessionId) {
      return (await this.get(sessionId)) !== null;
    },
  };
}

export async function decideConciergeRouting(api, config, params) {
  const model = String(config.model || '').trim();
  if (!config.enabled || !model) {
    return { kind: 'ask_user' };
  }

  const messages = [
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
    const result = await api.callAuxiliaryModel({
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
    api.logger.debug(
      { error, model },
      'Concierge routing fell back to ask_user',
    );
    return { kind: 'ask_user' };
  }
}

export function buildRoutingMetadata(config, params) {
  const model =
    resolveConciergeProfileModel(config, params.profile) || params.currentModel;
  return {
    [CONCIERGE_ROUTING_METADATA_KEY]: {
      profile: params.profile,
      model,
      notice: buildConciergeExecutionNotice(params.profile, model),
      effectiveUserTurnContent:
        params.effectiveUserTurnContent || params.originalUserContent,
      effectiveUserTurnContentExpanded: buildConciergeResumePrompt(
        params.originalUserContent,
        params.profile,
      ),
      effectiveUserTurnContentStripped:
        params.effectiveUserTurnContentStripped || params.originalUserContent,
      ...(params.media ? { media: params.media } : {}),
    },
  };
}
