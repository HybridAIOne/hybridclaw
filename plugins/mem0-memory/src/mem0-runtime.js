import path from 'node:path';
import {
  extractMemoryText,
  Mem0PluginClient,
  normalizeMem0Results,
} from './mem0-client.js';

const MAX_COMPACTION_MESSAGE_CHARS = 500;
const MAX_COMPACTION_MESSAGES = 10;
const MAX_COMPACTION_SUMMARY_CHARS = 1500;

function normalizeString(value) {
  return String(value || '').trim();
}

function truncateText(value, maxChars) {
  const normalized = normalizeString(value);
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 3) {
    return '.'.repeat(Math.max(0, maxChars));
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function buildCompactionConclusion(summary, olderMessages) {
  const sections = ['[Pre-compaction context]'];
  const normalizedSummary = normalizeString(summary);
  if (normalizedSummary) {
    sections.push(
      '',
      'Summary:',
      truncateText(normalizedSummary, MAX_COMPACTION_SUMMARY_CHARS),
    );
  }
  const excerpts = (olderMessages || [])
    .filter((message) => {
      const role = normalizeString(message?.role).toLowerCase();
      if (role !== 'user' && role !== 'assistant') return false;
      return normalizeString(message?.content).length > 0;
    })
    .slice(-MAX_COMPACTION_MESSAGES)
    .map((message) => {
      const role = normalizeString(message.role).toLowerCase();
      return `${role}: ${truncateText(message.content, MAX_COMPACTION_MESSAGE_CHARS)}`;
    });
  if (!normalizedSummary && excerpts.length === 0) return '';
  if (excerpts.length > 0) {
    sections.push('', ...excerpts);
  }
  return sections.join('\n');
}

function getLatestUserQuery(recentMessages) {
  let latest = null;
  for (const message of recentMessages || []) {
    if (normalizeString(message?.role).toLowerCase() !== 'user') continue;
    if (!latest) {
      latest = message;
      continue;
    }
    const currentTime = Date.parse(String(message.created_at || ''));
    const latestTime = Date.parse(String(latest.created_at || ''));
    if (
      (Number.isFinite(currentTime) ? currentTime : Number.NEGATIVE_INFINITY) >=
      (Number.isFinite(latestTime) ? latestTime : Number.NEGATIVE_INFINITY)
    ) {
      latest = message;
    }
  }
  return normalizeString(latest?.content);
}

function formatMemoryBullet(entry, index, includeScore = false) {
  const text = extractMemoryText(entry);
  if (!text) return '';
  const lines = [`- ${truncateText(text, 600)}`];
  if (includeScore && typeof entry?.score === 'number') {
    lines.push(`  score=${entry.score.toFixed(3)}`);
  }
  if (Array.isArray(entry?.categories) && entry.categories.length > 0) {
    lines.push(`  categories=${entry.categories.join(', ')}`);
  }
  if (typeof entry?.id === 'string' && entry.id.trim()) {
    lines.push(`  id=${entry.id.trim()}`);
  } else {
    lines.push(`  result=${index + 1}`);
  }
  return lines.join('\n');
}

function buildPromptContext(params) {
  const sections = ['Mem0 memory context:'];

  if (params.profileEntries.length > 0) {
    sections.push(
      '',
      'Mem0 profile overview:',
      ...params.profileEntries
        .map((entry, index) => formatMemoryBullet(entry, index))
        .filter(Boolean),
    );
  }

  if (params.query && params.searchEntries.length > 0) {
    sections.push(
      '',
      `Mem0 search results for the latest user question: ${params.query}`,
      ...params.searchEntries
        .map((entry, index) => formatMemoryBullet(entry, index, true))
        .filter(Boolean),
    );
  }

  const body = truncateText(
    sections.filter(Boolean).join('\n'),
    params.maxInjectedChars,
  );
  return body === 'Mem0 memory context:' ? null : body;
}

function toMem0Messages(messages, maxChars) {
  const out = [];
  for (const message of messages || []) {
    const role = normalizeString(message?.role).toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;
    const content = truncateText(message?.content, maxChars);
    if (!content) continue;
    out.push({
      role,
      content,
    });
  }
  return out;
}

function buildMemoryWriteText(context) {
  const memoryFile = path.basename(normalizeString(context.memoryFilePath));
  const content =
    normalizeString(context.newText) ||
    normalizeString(context.content) ||
    normalizeString(context.oldText);
  if (context.action === 'remove') {
    return `HybridClaw removed saved memory from ${memoryFile}.`;
  }
  if (!content) {
    return `HybridClaw updated ${memoryFile} with action ${context.action}.`;
  }
  return [
    `HybridClaw saved explicit memory in ${memoryFile}.`,
    truncateText(content, 1200),
  ].join('\n\n');
}

export class Mem0Runtime {
  constructor(api, config) {
    this.api = api;
    this.config = config;
    this.client = new Mem0PluginClient(config);
    this.profilePrefetch = new Map();
  }

  hasApiKey() {
    return normalizeString(this.config.apiKey).length > 0;
  }

  resolveUserId(inputUserId, sessionId) {
    const configured = normalizeString(this.config.userId);
    if (configured) return configured;
    const direct = normalizeString(inputUserId);
    if (direct) return direct;
    const sessionUserId = normalizeString(
      this.api.getSessionInfo(String(sessionId || '').trim()).userId,
    );
    return sessionUserId || 'hybridclaw-user';
  }

  resolveAgentId(inputAgentId, sessionId) {
    const configured = normalizeString(this.config.agentId);
    if (configured) return configured;
    const direct = normalizeString(inputAgentId);
    if (direct) return direct;
    return normalizeString(this.api.resolveSessionAgentId(sessionId)) || 'main';
  }

  start() {
    if (!this.hasApiKey()) {
      this.api.logger.warn(
        'Mem0 memory plugin is enabled but MEM0_API_KEY is not configured.',
      );
      return;
    }
    void this.client
      .ping()
      .then(() => {
        this.api.logger.debug(
          { host: this.config.host, apiVersion: this.config.apiVersion },
          'Mem0 startup health-check passed',
        );
      })
      .catch((error) => {
        this.api.logger.warn(
          { error, host: this.config.host },
          'Mem0 startup health-check failed',
        );
      });
  }

  onSessionStart(context) {
    if (!this.hasApiKey()) return;
    if (!this.config.includeProfile || !this.config.prefetchOnSessionStart) {
      return;
    }
    const userId = this.resolveUserId(context.userId, context.sessionId);
    const agentId = this.resolveAgentId(context.agentId, context.sessionId);
    const prefetch = this.client.getProfile(userId, agentId).catch((error) => {
      this.api.logger.debug(
        { error, sessionId: context.sessionId, userId, agentId },
        'Mem0 session prefetch failed',
      );
      return [];
    });
    this.profilePrefetch.set(context.sessionId, prefetch);
    this.api.logger.debug(
      { sessionId: context.sessionId, userId, agentId },
      'Mem0 session prefetch scheduled',
    );
  }

  async onSessionEnd(context) {
    const prefetch = this.profilePrefetch.get(context.sessionId);
    this.profilePrefetch.delete(context.sessionId);
    if (prefetch) {
      await prefetch;
    }
  }

  async onSessionReset(context) {
    const previous = this.profilePrefetch.get(context.previousSessionId);
    this.profilePrefetch.delete(context.previousSessionId);
    this.profilePrefetch.delete(context.sessionId);
    if (previous) {
      await previous;
    }
  }

  async onBeforeCompaction(context) {
    if (!this.hasApiKey() || !this.config.syncCompaction) return;
    const content = buildCompactionConclusion(
      context.summary,
      context.olderMessages,
    );
    if (!content) return;
    const userId = this.resolveUserId('', context.sessionId);
    const agentId = this.resolveAgentId(context.agentId, context.sessionId);
    try {
      await this.client.storeConclusion(userId, agentId, content, {
        source: 'hybridclaw-compaction',
        session_id: context.sessionId,
      });
      this.api.logger.debug(
        {
          sessionId: context.sessionId,
          userId,
          agentId,
          olderMessageCount: context.olderMessages?.length || 0,
        },
        'Mem0 pre-compaction snapshot stored',
      );
    } catch (error) {
      this.api.logger.warn(
        {
          error,
          sessionId: context.sessionId,
          userId,
          agentId,
        },
        'Mem0 pre-compaction snapshot failed',
      );
    }
  }

  async getContextForPrompt(params) {
    if (!this.hasApiKey()) return null;
    const userId = this.resolveUserId(params.userId, params.sessionId);
    const agentId = this.resolveAgentId(params.agentId, params.sessionId);
    const query = getLatestUserQuery(params.recentMessages);
    const prefetched = this.profilePrefetch.get(params.sessionId);
    if (prefetched) this.profilePrefetch.delete(params.sessionId);
    try {
      const [profileEntries, searchEntries] = await Promise.all([
        this.config.includeProfile
          ? (prefetched ?? this.client.getProfile(userId, agentId))
          : Promise.resolve([]),
        this.config.includeSearch && query
          ? this.client.search(userId, agentId, query)
          : Promise.resolve([]),
      ]);
      const promptContext = buildPromptContext({
        query,
        profileEntries,
        searchEntries,
        maxInjectedChars: this.config.maxInjectedChars,
      });
      this.api.logger.debug(
        {
          query,
          userId,
          agentId,
          profileCount: profileEntries.length,
          searchCount: searchEntries.length,
        },
        promptContext
          ? 'Mem0 prompt context injected'
          : 'Mem0 prompt search returned no matches',
      );
      return promptContext;
    } catch (error) {
      this.api.logger.warn(
        {
          error,
          host: this.config.host,
          userId,
          agentId,
          query,
        },
        'Mem0 prompt context fetch failed',
      );
      return null;
    }
  }

  async onTurnComplete(params) {
    if (!this.hasApiKey() || !this.config.syncTurns) return;
    const messages = toMem0Messages(
      params.messages,
      this.config.messageMaxChars,
    );
    if (messages.length === 0) return;
    const userId = this.resolveUserId(params.userId, params.sessionId);
    const agentId = this.resolveAgentId(params.agentId, params.sessionId);
    try {
      await this.client.syncMessages(userId, agentId, messages, {
        source: 'hybridclaw-turn',
        session_id: params.sessionId,
      });
      this.api.logger.debug(
        {
          sessionId: params.sessionId,
          userId,
          agentId,
          syncedMessageCount: messages.length,
        },
        'Mem0 turn synced',
      );
    } catch (error) {
      this.api.logger.warn(
        {
          error,
          sessionId: params.sessionId,
          userId,
          agentId,
        },
        'Mem0 turn sync failed',
      );
    }
  }

  async onMemoryWrite(context) {
    if (!this.hasApiKey() || !this.config.mirrorNativeMemoryWrites) return;
    const userId = this.resolveUserId('', context.sessionId);
    const agentId = this.resolveAgentId(context.agentId, context.sessionId);
    try {
      await this.client.storeConclusion(
        userId,
        agentId,
        buildMemoryWriteText(context),
        {
          source: 'hybridclaw-memory-write',
          session_id: context.sessionId,
          action: context.action,
          memory_file_path: context.memoryFilePath,
        },
      );
      this.api.logger.debug(
        {
          sessionId: context.sessionId,
          userId,
          agentId,
          action: context.action,
          memoryFilePath: context.memoryFilePath,
        },
        'Mem0 native memory write mirrored',
      );
    } catch (error) {
      this.api.logger.warn(
        {
          error,
          sessionId: context.sessionId,
          action: context.action,
          memoryFilePath: context.memoryFilePath,
        },
        'Mem0 native memory write mirror failed',
      );
    }
  }

  async fetchProfile(sessionId, inputUserId) {
    const userId = this.resolveUserId(inputUserId, sessionId);
    const agentId = this.resolveAgentId('', sessionId);
    const entries = await this.client.getProfile(userId, agentId);
    return { userId, entries };
  }

  async search(sessionId, inputUserId, query, options = {}) {
    const userId = this.resolveUserId(inputUserId, sessionId);
    const agentId = this.resolveAgentId('', sessionId);
    const entries = await this.client.search(userId, agentId, query, options);
    return { userId, entries };
  }

  async storeConclusion(sessionId, inputUserId, inputAgentId, conclusion) {
    const userId = this.resolveUserId(inputUserId, sessionId);
    const agentId = this.resolveAgentId(inputAgentId, sessionId);
    const response = await this.client.storeConclusion(
      userId,
      agentId,
      conclusion,
      {
        source: 'hybridclaw-conclusion',
        session_id: sessionId,
      },
    );
    return { userId, agentId, response: normalizeMem0Results(response) };
  }

  async buildStatusText(sessionId, inputUserId, inputAgentId) {
    const userId = this.resolveUserId(inputUserId, sessionId);
    const agentId = this.resolveAgentId(inputAgentId, sessionId);
    const lines = [
      'Mem0 status',
      `Host: ${this.config.host}`,
      `API version: ${this.config.apiVersion}`,
      `User scope: ${userId}`,
      `Agent scope: ${agentId}`,
      `Read agent scope: ${this.config.readAgentScope ? 'enabled' : 'disabled'}`,
      `Search limit: ${this.config.searchLimit}`,
      `Profile limit: ${this.config.profileLimit}`,
      `Sync turns: ${this.config.syncTurns ? 'enabled' : 'disabled'}`,
      `Native memory mirroring: ${this.config.mirrorNativeMemoryWrites ? 'enabled' : 'disabled'}`,
      `API key: ${this.hasApiKey() ? 'configured' : 'missing'}`,
    ];
    if (!this.hasApiKey()) {
      lines.push('', 'Set MEM0_API_KEY before using the Mem0 memory plugin.');
      return lines.join('\n');
    }
    try {
      await this.client.ping();
      lines.push('Connection: ok');
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error || 'Unknown error');
      lines.push('Connection: failed', '', message);
    }
    return lines.join('\n');
  }

  renderPromptGuide() {
    if (!this.hasApiKey()) return null;
    return [
      'Mem0 memory guide:',
      '- Use `mem0_search` for specific facts, preferences, or project context that may already be stored for this user.',
      '- Use `mem0_profile` when you need a broader snapshot of stored memories before making assumptions.',
      '- Use `mem0_conclude` only for durable facts, preferences, or corrections worth keeping across sessions.',
    ].join('\n');
  }
}
