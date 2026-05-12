import fs from 'node:fs';
import path from 'node:path';
import { dynamicReasoningLevel, resolveHonchoSessionKey } from './config.js';
import {
  buildAgentPeerId,
  buildUserPeerId,
  formatHonchoLabel,
  sanitizeHonchoSessionId,
} from './honcho-client.js';
import {
  getHonchoSessionState,
  getSessionState,
  loadPersistedState,
  savePersistedState,
} from './runtime-state.js';
import { normalizeString, truncateText } from './utils.js';

const SESSION_HISTORY_BACKFILL_LIMIT = 500;

function latestUserQuery(messages) {
  let latest = null;
  for (const message of messages || []) {
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
  const content = normalizeString(latest?.content);
  return content.length >= 3 ? content : '';
}

function formatPeerCard(card) {
  if (!Array.isArray(card) || card.length === 0) return '';
  return card
    .map((entry) => normalizeString(entry))
    .filter(Boolean)
    .map((entry) => `- ${entry}`)
    .join('\n');
}

function formatRecentMessages(result, ids) {
  if (!Array.isArray(result?.messages) || result.messages.length === 0)
    return '';
  return result.messages
    .map((message) => {
      const label = formatHonchoLabel(
        message.peer_id,
        ids.userPeerId,
        ids.agentPeerId,
      );
      return `${label}: ${normalizeString(message.content)}`;
    })
    .filter(Boolean)
    .join('\n');
}

function formatPromptContext(payload, config) {
  const sections = ['# Honcho Memory Context'];

  const userRepresentation = normalizeString(
    payload?.user?.peer_representation,
  );
  const userCard = formatPeerCard(payload?.user?.peer_card);
  const summary = normalizeString(payload?.user?.summary?.content);
  const aiRepresentation = normalizeString(payload?.ai?.peer_representation);
  const aiCard = formatPeerCard(payload?.ai?.peer_card);
  const recentMessages = formatRecentMessages(payload?.user, payload?.ids);
  const dialectic = normalizeString(payload?.dialectic);

  if (config.includeSummary && summary) {
    sections.push('## Summary', summary);
  }
  if (config.includePeerRepresentation && userRepresentation) {
    sections.push('## User Representation', userRepresentation);
  }
  if (config.includePeerCard && userCard) {
    sections.push('## User Peer Card', userCard);
  }
  if (config.includeAiPeerRepresentation && aiRepresentation) {
    sections.push('## AI Self-Representation', aiRepresentation);
  }
  if (config.includeAiPeerCard && aiCard) {
    sections.push('## AI Identity Card', aiCard);
  }
  if (config.includeRecentMessages && recentMessages) {
    sections.push('## Recent Honcho Messages', recentMessages);
  }
  if (dialectic) {
    sections.push('## Dialectic Guidance', dialectic);
  }

  if (sections.length === 1) return null;
  return truncateText(sections.join('\n\n'), config.maxInjectedChars);
}

function normalizeConclusionText(value) {
  return normalizeString(
    String(value || '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/^[-*]\s+/, '')
      .replace(/^\d+\.\s+/, ''),
  );
}

function collectUserProfileConclusions(context) {
  if (normalizeString(context?.memoryFilePath) !== 'USER.md') return [];

  const action = normalizeString(context?.action).toLowerCase();
  let raw = '';
  if (action === 'append' || action === 'write') {
    raw = normalizeString(context?.content);
  } else if (action === 'replace') {
    raw = normalizeString(context?.newText);
  }
  if (!raw) return [];

  const lineConclusions = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = normalizeString(line);
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^[-*]\s+/u.test(trimmed) || /^\d+\.\s+/u.test(trimmed)) {
      const conclusion = normalizeConclusionText(trimmed);
      if (conclusion) {
        lineConclusions.push(conclusion);
      }
    }
  }

  if (lineConclusions.length > 0) {
    return [...new Set(lineConclusions)];
  }
  if (raw.includes('\n')) return [];

  const singleConclusion = normalizeConclusionText(raw);
  return singleConclusion ? [singleConclusion] : [];
}

function numericMessageId(message) {
  const value = Number(message?.id);
  return Number.isFinite(value) ? value : 0;
}

function minPositiveMessageId(messages) {
  let minimum = Number.POSITIVE_INFINITY;
  for (const message of messages || []) {
    const id = numericMessageId(message);
    if (id > 0 && id < minimum) {
      minimum = id;
    }
  }
  return Number.isFinite(minimum) ? minimum : null;
}

function filterMirrorableMessages(messages, options = {}) {
  const afterId = Number(options.afterId || 0);
  const beforeIdExclusive =
    typeof options.beforeIdExclusive === 'number' &&
    Number.isFinite(options.beforeIdExclusive) &&
    options.beforeIdExclusive > 0
      ? Math.trunc(options.beforeIdExclusive)
      : Number.POSITIVE_INFINITY;
  return (messages || [])
    .filter((message) => {
      const role = normalizeString(message?.role).toLowerCase();
      if (role !== 'user' && role !== 'assistant') return false;
      const id = numericMessageId(message);
      if (id <= afterId) return false;
      if (id >= beforeIdExclusive) return false;
      return true;
    })
    .sort((left, right) => numericMessageId(left) - numericMessageId(right));
}

export class HonchoRuntime {
  constructor(api, config, client) {
    this.api = api;
    this.config = config;
    this.client = client;
    this.statePath = path.join(
      api.runtime.homeDir,
      'data',
      'plugins',
      'honcho-memory',
      'state.json',
    );
    this.persistedState = loadPersistedState(this.statePath);
    this.contextPrefetch = new Map();
    this.dialecticPrefetch = new Map();
    this.pendingWrites = new Map();
    this.bufferedMessages = new Map();
    this.sessionContexts = new Map();
    this.stateWriteDirty = false;
    this.stateWritePromise = null;
  }

  async start() {
    try {
      await this.client.ensureWorkspace();
      this.api.logger.debug(
        {
          baseUrl: this.config.baseUrl,
          workspaceId: this.config.workspaceId,
        },
        'Honcho startup health-check passed',
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error || 'Unknown error');
      throw new Error(`Honcho startup health-check failed: ${message}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async stop() {
    for (const sessionId of this.bufferedMessages.keys()) {
      await this.flushBufferedMessages(sessionId);
    }
    await Promise.allSettled([...this.pendingWrites.values()]);
    this.persistState();
    await this.flushPendingStateWrite();
  }

  async onSessionStart(context) {
    void this.prepareSession(context, {
      prewarm: true,
      query: 'What should I know about this user?',
    });
  }

  async onSessionEnd(context) {
    const sessionContext = await this.prepareSession(context);
    await this.flushBufferedMessages(context.sessionId, sessionContext);
    this.contextPrefetch.delete(context.sessionId);
    this.dialecticPrefetch.delete(context.sessionId);
    this.bufferedMessages.delete(context.sessionId);
    this.sessionContexts.delete(context.sessionId);
  }

  async onSessionReset(context) {
    this.contextPrefetch.delete(context.previousSessionId);
    this.dialecticPrefetch.delete(context.previousSessionId);
    this.bufferedMessages.delete(context.previousSessionId);
    this.pendingWrites.delete(context.previousSessionId);
    this.sessionContexts.delete(context.previousSessionId);
    this.sessionContexts.delete(context.sessionId);
    this.persistState();
  }

  async onMemoryWrite(context) {
    const conclusions = collectUserProfileConclusions(context);
    if (conclusions.length === 0) return;

    try {
      const sessionContext = await this.prepareSession({
        sessionId: context.sessionId,
        agentId: context.agentId,
      });
      await this.client.createConclusions({
        ...sessionContext,
        observerPeerId: this.config.agentObserveOthers
          ? sessionContext.agentPeerId
          : sessionContext.userPeerId,
        observedPeerId: sessionContext.userPeerId,
        conclusions,
      });
      await this.schedulePrefetch(sessionContext, '', { force: true });
      this.api.logger.debug(
        {
          sessionId: context.sessionId,
          honchoSessionId: sessionContext.honchoSessionId,
          memoryFilePath: context.memoryFilePath,
          conclusionCount: conclusions.length,
        },
        'Honcho native user profile write saved as conclusions',
      );
    } catch (error) {
      this.api.logger.warn(
        {
          error,
          sessionId: context.sessionId,
          memoryFilePath: context.memoryFilePath,
        },
        'Honcho native user profile write sync failed',
      );
    }
  }

  async getContextForPrompt(params) {
    if (this.config.recallMode === 'tools') return null;
    const sessionState = getSessionState(this.persistedState, params.sessionId);
    if (
      this.config.injectionFrequency === 'first-turn' &&
      sessionState.promptInjections > 0
    ) {
      return null;
    }

    const contextEntry = this.contextPrefetch.get(params.sessionId);
    const dialecticEntry = this.dialecticPrefetch.get(params.sessionId);
    if (contextEntry?.status === 'pending' && contextEntry.promise) {
      await contextEntry.promise;
    }
    if (dialecticEntry?.status === 'pending' && dialecticEntry.promise) {
      await dialecticEntry.promise;
    }
    let payload =
      contextEntry?.status === 'fulfilled' ? contextEntry.value : null;
    const dialectic =
      dialecticEntry?.status === 'fulfilled' ? dialecticEntry.value : '';
    if (!payload && sessionState.promptInjections === 0) {
      try {
        const sessionContext = await this.prepareSession(params);
        payload = await this.fetchPromptContextPayload(sessionContext);
        this.contextPrefetch.set(params.sessionId, {
          status: 'fulfilled',
          value: payload,
        });
      } catch (error) {
        this.api.logger.warn(
          {
            error,
            sessionId: params.sessionId,
          },
          'Honcho first-turn prompt context bake failed',
        );
      }
    }
    if (!payload && !dialectic) {
      void this.prepareSession(params)
        .then((sessionContext) =>
          this.schedulePrefetch(
            sessionContext,
            latestUserQuery(params.recentMessages),
            {
              force: true,
            },
          ),
        )
        .catch((error) => {
          this.api.logger.warn(
            {
              error,
              sessionId: params.sessionId,
            },
            'Honcho prompt prefetch bootstrap failed',
          );
        });
    }
    if (!payload && !dialectic) return null;

    const promptContext = formatPromptContext(
      {
        ...payload,
        dialectic,
      },
      this.config,
    );
    if (!promptContext) return null;
    sessionState.promptInjections += 1;
    this.persistState();
    return promptContext;
  }

  renderPromptGuide(context) {
    const sessionInfo = this.resolveSessionContext({
      sessionId: context.sessionId,
      userId: context.userId,
      agentId: context.agentId,
    });
    const lines = [
      '# Honcho Memory',
      `Session: ${sessionInfo.honchoSessionId}`,
      'Built-in HybridClaw memory remains active alongside Honcho.',
      `Honcho recall mode: ${this.config.recallMode}.`,
      'Commands: /honcho status, /honcho sessions, /honcho map <name>, /honcho mode [hybrid|context|tools], /honcho recall [hybrid|context|tools], /honcho identity [--show|file].',
    ];
    if (this.config.recallMode !== 'context') {
      lines.push(
        'Tools: honcho_profile, honcho_search, honcho_context, honcho_conclude.',
      );
    }
    return lines.join('\n');
  }

  async backfillStoredSessionHistory(sessionContext, options = {}) {
    const platformSessionId = normalizeString(
      sessionContext?.platformSessionId,
    );
    if (!platformSessionId) return;
    const sessionState = getSessionState(
      this.persistedState,
      platformSessionId,
    );
    if (sessionState.historyBackfilled) return;

    const storedMessages = this.api.getSessionMessages(
      platformSessionId,
      SESSION_HISTORY_BACKFILL_LIMIT,
    );
    const historyToMirror = filterMirrorableMessages(storedMessages, {
      afterId: Number(sessionState.lastSyncedMessageId || 0),
      beforeIdExclusive:
        typeof options.beforeMessageIdExclusive === 'number' &&
        Number.isFinite(options.beforeMessageIdExclusive)
          ? Math.trunc(options.beforeMessageIdExclusive)
          : undefined,
    });

    if (historyToMirror.length > 0) {
      await this.client.syncMessages({
        honchoSessionId: sessionContext.honchoSessionId,
        userId: sessionContext.userId,
        agentId: sessionContext.agentId,
        messages: historyToMirror,
      });
      sessionState.lastSyncedMessageId = Math.max(
        Number(sessionState.lastSyncedMessageId || 0),
        ...historyToMirror.map((message) => numericMessageId(message)),
      );
      this.api.logger.debug(
        {
          sessionId: platformSessionId,
          honchoSessionId: sessionContext.honchoSessionId,
          backfilledCount: historyToMirror.length,
        },
        'Honcho backfilled stored session history',
      );
    }

    sessionState.historyBackfilled = true;
    this.persistState();
  }

  async onTurnComplete(params) {
    const sessionState = getSessionState(this.persistedState, params.sessionId);
    sessionState.turnCount += 1;
    const currentTurnStartId = minPositiveMessageId(params.messages);
    const sessionContext = await this.prepareSession(params, {
      prewarm: false,
      backfillBeforeMessageId: currentTurnStartId,
    });
    const lastSyncedMessageId = Number(sessionState.lastSyncedMessageId || 0);
    const unsyncedMessages = filterMirrorableMessages(params.messages, {
      afterId: lastSyncedMessageId,
    });
    if (unsyncedMessages.length === 0) {
      this.persistState();
      return;
    }

    const buffered = this.bufferedMessages.get(params.sessionId) || [];
    buffered.push(...unsyncedMessages);
    this.bufferedMessages.set(params.sessionId, buffered);

    const latestQuery = latestUserQuery(unsyncedMessages);

    if (!this.config.saveMessages) {
      sessionState.lastSyncedMessageId = Math.max(
        lastSyncedMessageId,
        ...unsyncedMessages.map((message) => Number(message.id) || 0),
      );
      this.bufferedMessages.set(params.sessionId, []);
      this.persistState();
      void this.schedulePrefetch(sessionContext, latestQuery);
      return;
    }

    const writeFrequency = this.config.writeFrequency;
    if (writeFrequency === 'async') {
      this.enqueueWrite(params.sessionId, async () => {
        await this.flushBufferedMessages(params.sessionId, sessionContext);
        await this.schedulePrefetch(sessionContext, latestQuery);
      });
      return;
    }

    if (writeFrequency === 'turn') {
      await this.flushBufferedMessages(params.sessionId, sessionContext);
      await this.schedulePrefetch(sessionContext, latestQuery);
      return;
    }

    if (
      typeof writeFrequency === 'number' &&
      Number.isFinite(writeFrequency) &&
      writeFrequency > 0
    ) {
      if (sessionState.turnCount % Math.trunc(writeFrequency) === 0) {
        await this.flushBufferedMessages(params.sessionId, sessionContext);
      }
      await this.schedulePrefetch(sessionContext, latestQuery);
      return;
    }

    await this.schedulePrefetch(sessionContext, latestQuery);
  }

  async flushBufferedMessages(sessionId, preparedContext = null) {
    const buffered = this.bufferedMessages.get(sessionId) || [];
    if (buffered.length === 0) return;
    const sessionContext =
      preparedContext || (await this.prepareSession({ sessionId }));
    const sessionState = getSessionState(this.persistedState, sessionId);
    if (buffered.length > 0) {
      await this.client.syncMessages({
        honchoSessionId: sessionContext.honchoSessionId,
        userId: sessionContext.userId,
        agentId: sessionContext.agentId,
        messages: buffered,
      });
    }

    sessionState.lastSyncedMessageId = Math.max(
      Number(sessionState.lastSyncedMessageId || 0),
      ...buffered.map((message) => Number(message.id) || 0),
    );
    this.bufferedMessages.set(sessionId, []);
    this.persistState();
  }

  enqueueWrite(sessionId, task) {
    const current = this.pendingWrites.get(sessionId) || Promise.resolve();
    const next = current
      .catch(() => {})
      .then(task)
      .catch((error) => {
        this.api.logger.warn(
          { error, sessionId },
          'Honcho background task failed',
        );
      })
      .finally(() => {
        if (this.pendingWrites.get(sessionId) === next) {
          this.pendingWrites.delete(sessionId);
        }
      });
    this.pendingWrites.set(sessionId, next);
  }

  async schedulePrefetch(sessionContext, query, options = {}) {
    if (this.config.recallMode === 'tools') return;
    const sessionState = getSessionState(
      this.persistedState,
      sessionContext.platformSessionId,
    );
    const turnCount = Number(sessionState.turnCount || 0);
    const force = Boolean(options.force);
    const hasContextEntry = this.contextPrefetch.has(
      sessionContext.platformSessionId,
    );
    const hasDialecticEntry = this.dialecticPrefetch.has(
      sessionContext.platformSessionId,
    );
    if (
      force ||
      !hasContextEntry ||
      turnCount - Number(sessionState.lastContextTurn || 0) >=
        this.config.contextCadence
    ) {
      sessionState.lastContextTurn = turnCount;
      this.createContextPrefetch(sessionContext);
    }
    if (
      query &&
      (force ||
        !hasDialecticEntry ||
        turnCount - Number(sessionState.lastDialecticTurn || 0) >=
          this.config.dialecticCadence)
    ) {
      sessionState.lastDialecticTurn = turnCount;
      this.createDialecticPrefetch(sessionContext, query);
    }
    this.persistState();
  }

  async fetchPromptContextPayload(sessionContext) {
    const userPromise = this.client.getSessionContext({
      ...sessionContext,
      includeSummary: this.config.includeSummary,
      limitToSession: this.config.limitToSession,
      peerTargetId: sessionContext.userPeerId,
      peerPerspectiveId: sessionContext.agentPeerId,
    });
    const aiPromise =
      this.config.includeAiPeerRepresentation || this.config.includeAiPeerCard
        ? this.client.getSessionContext({
            ...sessionContext,
            includeSummary: false,
            limitToSession: this.config.limitToSession,
            peerTargetId: sessionContext.agentPeerId,
            peerPerspectiveId: sessionContext.userPeerId,
          })
        : Promise.resolve(null);
    const [user, ai] = await Promise.all([userPromise, aiPromise]);
    return {
      user,
      ai,
      ids: {
        userPeerId: sessionContext.userPeerId,
        agentPeerId: sessionContext.agentPeerId,
      },
    };
  }

  createContextPrefetch(sessionContext) {
    const entry = {
      status: 'pending',
      value: null,
      promise: null,
    };
    this.contextPrefetch.set(sessionContext.platformSessionId, entry);
    entry.promise = (async () => {
      try {
        const payload = await this.fetchPromptContextPayload(sessionContext);
        entry.status = 'fulfilled';
        entry.value = payload;
      } catch (error) {
        entry.status = 'rejected';
        this.api.logger.warn(
          {
            error,
            sessionId: sessionContext.platformSessionId,
            honchoSessionId: sessionContext.honchoSessionId,
          },
          'Honcho prompt context prefetch failed',
        );
      }
    })();
  }

  createDialecticPrefetch(sessionContext, query) {
    const entry = {
      status: 'pending',
      value: '',
      promise: null,
    };
    this.dialecticPrefetch.set(sessionContext.platformSessionId, entry);
    entry.promise = (async () => {
      try {
        const value = await this.client.chatWithPeer({
          peerId: sessionContext.agentPeerId,
          targetPeerId: sessionContext.userPeerId,
          honchoSessionId: sessionContext.honchoSessionId,
          query,
          reasoningLevel: dynamicReasoningLevel(
            this.config,
            query,
            this.config.dialecticReasoningLevel,
          ),
        });
        entry.status = 'fulfilled';
        entry.value = value;
      } catch (error) {
        entry.status = 'rejected';
        this.api.logger.warn(
          {
            error,
            sessionId: sessionContext.platformSessionId,
            honchoSessionId: sessionContext.honchoSessionId,
          },
          'Honcho dialectic prefetch failed',
        );
      }
    })();
  }

  resolveSessionContext(params) {
    const platformSessionId = normalizeString(params.sessionId);
    const cachedContext = platformSessionId
      ? this.sessionContexts.get(platformSessionId)
      : null;
    const sessionInfo = this.api.getSessionInfo(platformSessionId);
    const userId =
      normalizeString(params.userId) ||
      normalizeString(sessionInfo.userId) ||
      normalizeString(cachedContext?.userId) ||
      'anonymous';
    const agentId =
      normalizeString(params.agentId) ||
      normalizeString(sessionInfo.agentId) ||
      normalizeString(cachedContext?.agentId) ||
      'main';
    const workspacePath =
      normalizeString(sessionInfo.workspacePath) ||
      normalizeString(cachedContext?.workspacePath) ||
      this.api.runtime.cwd;
    const sessionRoot =
      normalizeString(params.workspacePath) ||
      normalizeString(cachedContext?.sessionRoot) ||
      normalizeString(sessionInfo.workspaceRoot) ||
      this.api.runtime.cwd;
    const honchoSessionId = sanitizeHonchoSessionId(
      resolveHonchoSessionKey({
        config: this.config,
        cwd: sessionRoot,
        platformSessionId,
      }),
    );
    const sessionContext = {
      platformSessionId,
      honchoSessionId,
      userId,
      agentId,
      workspacePath,
      sessionRoot,
      userPeerId: buildUserPeerId(userId),
      agentPeerId: buildAgentPeerId(agentId, this.config.aiPeer),
    };
    if (platformSessionId) {
      this.sessionContexts.set(platformSessionId, sessionContext);
    }
    return sessionContext;
  }

  async prepareSession(params, options = {}) {
    const sessionContext = this.resolveSessionContext(params);
    await this.client.ensureConversation({
      honchoSessionId: sessionContext.honchoSessionId,
      userId: sessionContext.userId,
      agentId: sessionContext.agentId,
    });
    if (options.seedWorkspace !== false) {
      await this.seedWorkspaceFiles(sessionContext);
    }
    await this.backfillStoredSessionHistory(sessionContext, {
      beforeMessageIdExclusive:
        typeof options.backfillBeforeMessageId === 'number' &&
        Number.isFinite(options.backfillBeforeMessageId)
          ? Math.trunc(options.backfillBeforeMessageId)
          : undefined,
    });
    if (options.prewarm) {
      await this.schedulePrefetch(
        sessionContext,
        normalizeString(options.query) || 'What should I know about this user?',
        { force: true },
      );
    }
    return sessionContext;
  }

  async seedWorkspaceFiles(sessionContext) {
    const honchoSessionState = getHonchoSessionState(
      this.persistedState,
      sessionContext.honchoSessionId,
    );
    const workspacePath = sessionContext.workspacePath;
    if (!workspacePath || !fs.existsSync(workspacePath)) return;

    const seedableFiles = [
      {
        name: 'SOUL.md',
        role: 'assistant',
        source: 'workspace:SOUL.md',
        wrap: (content) =>
          `<ai_identity_seed>\n<source>SOUL.md</source>\n\n${content}\n</ai_identity_seed>`,
      },
      {
        name: 'IDENTITY.md',
        role: 'assistant',
        source: 'workspace:IDENTITY.md',
        wrap: (content) =>
          `<ai_identity_seed>\n<source>IDENTITY.md</source>\n\n${content}\n</ai_identity_seed>`,
      },
      {
        name: 'AGENTS.md',
        role: 'assistant',
        source: 'workspace:AGENTS.md',
        wrap: (content) =>
          `<ai_identity_seed>\n<source>AGENTS.md</source>\n\n${content}\n</ai_identity_seed>`,
      },
      {
        name: 'USER.md',
        role: 'user',
        source: 'workspace:USER.md',
        wrap: (content) =>
          `<prior_memory_file>\n<source>USER.md</source>\n\n${content}\n</prior_memory_file>`,
      },
      {
        name: 'MEMORY.md',
        role: 'user',
        source: 'workspace:MEMORY.md',
        wrap: (content) =>
          `<prior_memory_file>\n<source>MEMORY.md</source>\n\n${content}\n</prior_memory_file>`,
      },
    ];

    for (const file of seedableFiles) {
      if (honchoSessionState.seededSources.includes(file.source)) {
        continue;
      }
      const filePath = path.join(workspacePath, file.name);
      if (!fs.existsSync(filePath)) continue;
      const content = normalizeString(fs.readFileSync(filePath, 'utf-8'));
      if (!content) continue;
      await this.client.syncMessages({
        honchoSessionId: sessionContext.honchoSessionId,
        userId: sessionContext.userId,
        agentId: sessionContext.agentId,
        messages: [
          {
            id: Date.now(),
            role: file.role,
            content: file.wrap(content),
            created_at: new Date().toISOString(),
          },
        ],
      });
      honchoSessionState.seededSources.push(file.source);
      this.persistState();
    }
  }

  persistState() {
    this.stateWriteDirty = true;
    if (this.stateWritePromise) return;
    this.stateWritePromise = new Promise((resolve) => {
      setImmediate(() => {
        this.stateWritePromise = null;
        this.writePersistedStateNow();
        resolve();
      });
    });
  }

  async flushPendingStateWrite() {
    while (this.stateWritePromise) {
      await this.stateWritePromise;
    }
    if (this.stateWriteDirty) {
      this.writePersistedStateNow();
    }
  }

  writePersistedStateNow() {
    if (!this.stateWriteDirty) return;
    this.stateWriteDirty = false;
    try {
      savePersistedState(this.statePath, this.persistedState);
    } catch (error) {
      this.api.logger.warn(
        {
          error,
          statePath: this.statePath,
        },
        'Honcho state persistence failed',
      );
    }
  }
}
