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

function normalizeString(value) {
  return String(value || '').trim();
}

function truncateText(value, maxChars) {
  const normalized = normalizeString(value);
  if (!maxChars || normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

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

function formatProfileText(params) {
  const sections = ['Honcho profile'];
  const representation = normalizeString(params.representation);
  const peerCard = formatPeerCard(params.peerCard);
  if (representation) {
    sections.push('', 'Representation:', representation);
  }
  if (peerCard) {
    sections.push('', 'Peer card:', peerCard);
  }
  if (!representation && !peerCard) {
    sections.push('', 'No Honcho profile data is available yet.');
  }
  return sections.join('\n');
}

function formatSearchResult(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return 'No Honcho message results found for this session.';
  }
  return results
    .map((message, index) =>
      [
        `[${index + 1}] ${normalizeString(message.peer_id) || 'peer'} @ ${
          normalizeString(message.created_at) || 'unknown'
        }`,
        normalizeString(message.content),
      ].join('\n'),
    )
    .join('\n\n');
}

function formatMappingsText(config, cwd) {
  const rows = Object.entries(config.sessions || {});
  if (rows.length === 0) {
    return [
      'Honcho session mappings',
      'No directory mappings configured.',
      '',
      'Use `/honcho map <name>` to map the current working directory.',
    ].join('\n');
  }
  return [
    'Honcho session mappings',
    ...rows
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([mappedPath, name]) =>
          `${mappedPath === cwd ? '* ' : '  '}${mappedPath} → ${name}`,
      ),
  ].join('\n');
}

function parseFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] ?? '';
}

function parsePeerSelection(value, fallback = 'user') {
  const normalized = normalizeString(value).toLowerCase();
  if (
    normalized === 'ai' ||
    normalized === 'assistant' ||
    normalized === 'agent'
  ) {
    return 'agent';
  }
  if (normalized === 'user') return 'user';
  return fallback;
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
      this.api.logger.warn(
        {
          error,
          baseUrl: this.config.baseUrl,
          workspaceId: this.config.workspaceId,
        },
        'Honcho startup health-check failed',
      );
    }
  }

  async stop() {
    for (const sessionId of this.bufferedMessages.keys()) {
      await this.flushBufferedMessages(sessionId);
    }
    await Promise.allSettled([...this.pendingWrites.values()]);
    this.persistState();
  }

  async onSessionStart(context) {
    void this.prepareSession(context, {
      seedWorkspace: true,
      prewarm: true,
      query: 'What should I know about this user?',
    });
  }

  async onSessionEnd(context) {
    const sessionContext = await this.prepareSession(context, {
      seedWorkspace: true,
    });
    await this.flushBufferedMessages(context.sessionId, sessionContext);
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
      const sessionContext = await this.prepareSession(
        {
          sessionId: context.sessionId,
          agentId: context.agentId,
        },
        { seedWorkspace: true },
      );
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
    const payload =
      contextEntry?.status === 'fulfilled' ? contextEntry.value : null;
    const dialectic =
      dialecticEntry?.status === 'fulfilled' ? dialecticEntry.value : '';
    if (!payload && !dialectic) {
      void this.prepareSession(params, {
        seedWorkspace: true,
      })
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

  async onTurnComplete(params) {
    const sessionState = getSessionState(this.persistedState, params.sessionId);
    sessionState.turnCount += 1;
    const lastSyncedMessageId = Number(sessionState.lastSyncedMessageId || 0);
    const unsyncedMessages = (params.messages || []).filter(
      (message) => Number(message.id) > lastSyncedMessageId,
    );
    if (unsyncedMessages.length === 0) {
      this.persistState();
      return;
    }

    const buffered = this.bufferedMessages.get(params.sessionId) || [];
    buffered.push(...unsyncedMessages);
    this.bufferedMessages.set(params.sessionId, buffered);

    const sessionContext = await this.prepareSession(params, {
      seedWorkspace: true,
      prewarm: false,
    });
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
      preparedContext ||
      (await this.prepareSession({ sessionId }, { seedWorkspace: true }));
    const sessionState = getSessionState(this.persistedState, sessionId);
    const messagesToMirror = [];
    for (const message of buffered) {
      const role = normalizeString(message.role).toLowerCase();
      if (role !== 'user' && role !== 'assistant') continue;
      messagesToMirror.push(message);
    }

    if (messagesToMirror.length > 0) {
      await this.client.syncMessages({
        honchoSessionId: sessionContext.honchoSessionId,
        userId: sessionContext.userId,
        agentId: sessionContext.agentId,
        messages: messagesToMirror,
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

  createContextPrefetch(sessionContext) {
    const entry = {
      status: 'pending',
      value: null,
    };
    this.contextPrefetch.set(sessionContext.platformSessionId, entry);
    void (async () => {
      try {
        const user = await this.client.getSessionContext({
          ...sessionContext,
          includeSummary: this.config.includeSummary,
          limitToSession: this.config.limitToSession,
          peerTargetId: sessionContext.userPeerId,
          peerPerspectiveId: sessionContext.agentPeerId,
        });
        const ai =
          this.config.includeAiPeerRepresentation ||
          this.config.includeAiPeerCard
            ? await this.client.getSessionContext({
                ...sessionContext,
                includeSummary: false,
                limitToSession: this.config.limitToSession,
                peerTargetId: sessionContext.agentPeerId,
                peerPerspectiveId: sessionContext.userPeerId,
              })
            : null;
        entry.status = 'fulfilled';
        entry.value = {
          user,
          ai,
          ids: {
            userPeerId: sessionContext.userPeerId,
            agentPeerId: sessionContext.agentPeerId,
          },
        };
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
    };
    this.dialecticPrefetch.set(sessionContext.platformSessionId, entry);
    void (async () => {
      try {
        const floor =
          this.config.dialecticReasoningLevel === 'minimal'
            ? 'minimal'
            : this.config.dialecticReasoningLevel;
        const value = await this.client.chatWithPeer({
          peerId: sessionContext.agentPeerId,
          targetPeerId: sessionContext.userPeerId,
          honchoSessionId: sessionContext.honchoSessionId,
          query,
          reasoningLevel: dynamicReasoningLevel(this.config, query, floor),
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
    const sessionRoot =
      normalizeString(sessionInfo.workspacePath) ||
      normalizeString(cachedContext?.workspacePath) ||
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
      workspacePath: sessionRoot,
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
    if (options.seedWorkspace) {
      await this.seedWorkspaceFiles(sessionContext);
    }
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
        enabled: true,
        wrap: (content) =>
          `<ai_identity_seed>\n<source>SOUL.md</source>\n\n${content}\n</ai_identity_seed>`,
      },
      {
        name: 'IDENTITY.md',
        role: 'assistant',
        source: 'workspace:IDENTITY.md',
        enabled: true,
        wrap: (content) =>
          `<ai_identity_seed>\n<source>IDENTITY.md</source>\n\n${content}\n</ai_identity_seed>`,
      },
      {
        name: 'AGENTS.md',
        role: 'assistant',
        source: 'workspace:AGENTS.md',
        enabled: true,
        wrap: (content) =>
          `<ai_identity_seed>\n<source>AGENTS.md</source>\n\n${content}\n</ai_identity_seed>`,
      },
      {
        name: 'USER.md',
        role: 'user',
        source: 'workspace:USER.md',
        enabled: true,
        wrap: (content) =>
          `<prior_memory_file>\n<source>USER.md</source>\n\n${content}\n</prior_memory_file>`,
      },
      {
        name: 'MEMORY.md',
        role: 'user',
        source: 'workspace:MEMORY.md',
        enabled: true,
        wrap: (content) =>
          `<prior_memory_file>\n<source>MEMORY.md</source>\n\n${content}\n</prior_memory_file>`,
      },
    ];

    for (const file of seedableFiles) {
      if (!file.enabled) continue;
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
    savePersistedState(this.statePath, this.persistedState);
  }

  async handleCommand(args, context) {
    const normalizedArgs = (args || [])
      .map((arg) => normalizeString(arg))
      .filter(Boolean);
    const subcommand = normalizeString(
      normalizedArgs[0] || 'status',
    ).toLowerCase();
    try {
      if (subcommand === 'search') {
        return await this.handleSearchCommand(normalizedArgs.slice(1), context);
      }
      if (subcommand === 'sessions') {
        return formatMappingsText(
          this.config,
          this.resolveSessionContext(context).workspacePath,
        );
      }
      if (subcommand === 'map') {
        return await this.handleMapCommand(normalizedArgs.slice(1), context);
      }
      if (subcommand === 'mode') {
        return await this.handleModeCommand(normalizedArgs.slice(1));
      }
      if (subcommand === 'recall') {
        return await this.handleRecallCommand(normalizedArgs.slice(1));
      }
      if (subcommand === 'peer') {
        return await this.handlePeerCommand(normalizedArgs.slice(1));
      }
      if (subcommand === 'tokens') {
        return await this.handleTokensCommand(normalizedArgs.slice(1));
      }
      if (subcommand === 'identity') {
        return await this.handleIdentityCommand(
          normalizedArgs.slice(1),
          context,
        );
      }
      if (subcommand === 'setup') {
        return await this.handleSetupCommand(context);
      }
      if (subcommand === 'sync') {
        return await this.handleSyncCommand(context);
      }
      return await this.handleStatusCommand(context);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error || 'Unknown error');
      return [
        'Honcho command failed.',
        `Workspace: ${this.config.workspaceId}`,
        '',
        message,
      ].join('\n');
    }
  }

  async handleStatusCommand(context) {
    const sessionContext = await this.prepareSession(context, {
      seedWorkspace: true,
    });
    const status = await this.client.getQueueStatus(
      sessionContext.honchoSessionId,
    );
    return [
      'Honcho status',
      `Base URL: ${this.config.baseUrl}`,
      `Workspace: ${this.config.workspaceId}`,
      `Honcho session: ${sessionContext.honchoSessionId}`,
      'Built-in memory: always on',
      `Honcho recall mode: ${this.config.recallMode}`,
      `Write frequency: ${this.config.writeFrequency}`,
      `Pending work units: ${Number(status?.pending_work_units || 0)}`,
      `In-progress work units: ${Number(status?.in_progress_work_units || 0)}`,
      `Completed work units: ${Number(status?.completed_work_units || 0)}`,
    ].join('\n');
  }

  async handleSearchCommand(args, context) {
    const query = args.join(' ').trim();
    if (!query) {
      return 'Usage: /honcho search <query>';
    }
    const sessionContext = await this.prepareSession(context, {
      seedWorkspace: true,
    });
    const results = await this.client.searchSession({
      honchoSessionId: sessionContext.honchoSessionId,
      query,
      limit: this.config.searchLimit,
    });
    return formatSearchResult(results);
  }

  async handleMapCommand(args, context) {
    const workspacePath = this.resolveSessionContext(context).workspacePath;
    if (args.length === 0) {
      return formatMappingsText(this.config, workspacePath);
    }
    if (
      args.includes('--clear') ||
      normalizeString(args[0]).toLowerCase() === 'clear'
    ) {
      const sessions = { ...(this.config.sessions || {}) };
      delete sessions[workspacePath];
      if (Object.keys(sessions).length === 0) {
        await this.api.unsetConfigValue('sessions');
      } else {
        await this.persistConfigValue('sessions', sessions);
      }
      this.config.sessions = sessions;
      return `Removed Honcho session mapping for ${workspacePath}.`;
    }
    const mappingName = sanitizeHonchoSessionId(args.join(' '));
    const sessions = { ...(this.config.sessions || {}) };
    sessions[workspacePath] = mappingName;
    await this.persistConfigValue('sessions', sessions);
    this.config.sessions = sessions;
    return `Mapped ${workspacePath} to Honcho session ${mappingName}.`;
  }

  async handleModeCommand(args) {
    if (args.length === 0) {
      return [
        'Honcho recall mode',
        'Built-in HybridClaw memory stays on; this command only changes Honcho recall behavior.',
        `Current: ${this.config.recallMode}`,
        '',
        'Set with `/honcho mode <hybrid|context|tools>`.',
        'Alias: `/honcho recall <hybrid|context|tools>`.',
      ].join('\n');
    }
    const nextMode = normalizeString(args[0]).toLowerCase();
    if (!['hybrid', 'context', 'tools'].includes(nextMode)) {
      return 'Usage: /honcho mode <hybrid|context|tools>';
    }
    this.config.recallMode = nextMode;
    await this.persistConfigValue('recallMode', nextMode);
    return [
      `Updated Honcho recall mode to ${nextMode}.`,
      'Run `/plugin reload` or restart the gateway to refresh tool visibility.',
    ].join('\n');
  }

  async handleRecallCommand(args) {
    const result = await this.handleModeCommand(args);
    if (args.length > 0) return result;
    return String(result).replace('/honcho mode', '/honcho recall');
  }

  async handlePeerCommand(args) {
    if (args.length === 0) {
      return [
        'Honcho peers',
        `User label: ${this.config.peerName || '(derived from session user id)'}`,
        `AI peer: ${this.config.aiPeer || '(derived from current agent id)'}`,
        `Dialectic reasoning floor: ${this.config.dialecticReasoningLevel}`,
      ].join('\n');
    }
    const userValue = parseFlagValue(args, '--user');
    const aiValue = parseFlagValue(args, '--ai');
    const reasoningValue = parseFlagValue(args, '--reasoning');
    if (userValue != null && userValue) {
      this.config.peerName = userValue;
      await this.persistConfigValue('peerName', userValue);
    }
    if (aiValue != null && aiValue) {
      this.config.aiPeer = aiValue;
      await this.persistConfigValue('aiPeer', aiValue);
    }
    if (reasoningValue != null && reasoningValue) {
      if (
        !['minimal', 'low', 'medium', 'high', 'max'].includes(reasoningValue)
      ) {
        return 'Usage: /honcho peer [--user <name>] [--ai <name>] [--reasoning <minimal|low|medium|high|max>]';
      }
      this.config.dialecticReasoningLevel = reasoningValue;
      await this.persistConfigValue('dialecticReasoningLevel', reasoningValue);
    }
    return [
      'Updated Honcho peer configuration.',
      `User label: ${this.config.peerName || '(derived from session user id)'}`,
      `AI peer: ${this.config.aiPeer || '(derived from current agent id)'}`,
      `Dialectic reasoning floor: ${this.config.dialecticReasoningLevel}`,
    ].join('\n');
  }

  async handleTokensCommand(args) {
    if (args.length === 0) {
      return [
        'Honcho budgets',
        `Context tokens: ${this.config.contextTokens}`,
        `Dialectic max chars: ${this.config.dialecticMaxChars}`,
        `Dialectic max input chars: ${this.config.dialecticMaxInputChars}`,
      ].join('\n');
    }
    const contextValue = parseFlagValue(args, '--context');
    const dialecticValue = parseFlagValue(args, '--dialectic');
    const inputValue = parseFlagValue(args, '--input');
    if (contextValue != null && contextValue) {
      const parsed = Number(contextValue);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return 'Usage: /honcho tokens [--context <n>] [--dialectic <n>] [--input <n>]';
      }
      this.config.contextTokens = Math.trunc(parsed);
      await this.persistConfigValue('contextTokens', this.config.contextTokens);
    }
    if (dialecticValue != null && dialecticValue) {
      const parsed = Number(dialecticValue);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return 'Usage: /honcho tokens [--context <n>] [--dialectic <n>] [--input <n>]';
      }
      this.config.dialecticMaxChars = Math.trunc(parsed);
      await this.persistConfigValue(
        'dialecticMaxChars',
        this.config.dialecticMaxChars,
      );
    }
    if (inputValue != null && inputValue) {
      const parsed = Number(inputValue);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return 'Usage: /honcho tokens [--context <n>] [--dialectic <n>] [--input <n>]';
      }
      this.config.dialecticMaxInputChars = Math.trunc(parsed);
      await this.persistConfigValue(
        'dialecticMaxInputChars',
        this.config.dialecticMaxInputChars,
      );
    }
    return [
      'Updated Honcho budgets.',
      `Context tokens: ${this.config.contextTokens}`,
      `Dialectic max chars: ${this.config.dialecticMaxChars}`,
      `Dialectic max input chars: ${this.config.dialecticMaxInputChars}`,
    ].join('\n');
  }

  async handleSyncCommand(context) {
    const sessionContext = await this.prepareSession(context, {
      seedWorkspace: true,
    });
    await this.flushBufferedMessages(context.sessionId, sessionContext);
    await this.schedulePrefetch(
      sessionContext,
      'What should I know about this conversation right now?',
      { force: true },
    );
    return [
      'Honcho sync complete.',
      `Honcho session: ${sessionContext.honchoSessionId}`,
      'Buffered messages were flushed and prompt context was refreshed.',
    ].join('\n');
  }

  async handleIdentityCommand(args, context) {
    const sessionContext = await this.prepareSession(context, {
      seedWorkspace: true,
    });
    if (args.includes('--show')) {
      const user = await this.client.getSessionContext({
        ...sessionContext,
        includeSummary: false,
        limitToSession: false,
        peerTargetId: sessionContext.userPeerId,
        peerPerspectiveId: sessionContext.agentPeerId,
      });
      const ai = await this.client.getSessionContext({
        ...sessionContext,
        includeSummary: false,
        limitToSession: false,
        peerTargetId: sessionContext.agentPeerId,
        peerPerspectiveId: sessionContext.userPeerId,
      });
      return [
        'Honcho identity',
        '',
        formatProfileText({
          representation: user?.peer_representation,
          peerCard: user?.peer_card,
        }),
        '',
        'AI peer',
        normalizeString(ai?.peer_representation) ||
          'No AI representation is available yet.',
        formatPeerCard(ai?.peer_card),
      ]
        .filter(Boolean)
        .join('\n');
    }
    const fileArg = args.find((arg) => !arg.startsWith('--'));
    if (!fileArg) {
      return [
        'Usage: /honcho identity --show',
        '   or: /honcho identity <path>',
      ].join('\n');
    }
    const resolvedPath = path.isAbsolute(fileArg)
      ? fileArg
      : path.resolve(this.api.runtime.cwd, fileArg);
    if (!fs.existsSync(resolvedPath)) {
      return `File not found: ${resolvedPath}`;
    }
    const content = normalizeString(fs.readFileSync(resolvedPath, 'utf-8'));
    if (!content) {
      return `File is empty: ${resolvedPath}`;
    }
    await this.client.syncMessages({
      honchoSessionId: sessionContext.honchoSessionId,
      userId: sessionContext.userId,
      agentId: sessionContext.agentId,
      messages: [
        {
          id: Date.now(),
          role: 'assistant',
          content: `<ai_identity_seed>\n<source>${path.basename(
            resolvedPath,
          )}</source>\n\n${content}\n</ai_identity_seed>`,
          created_at: new Date().toISOString(),
        },
      ],
    });
    return `Seeded Honcho AI identity from ${resolvedPath}.`;
  }

  async handleSetupCommand(context) {
    const sessionContext = await this.prepareSession(context, {
      seedWorkspace: true,
      prewarm: true,
      query: 'What should I know about this user?',
    });
    return [
      'Honcho setup',
      `Workspace: ${this.config.workspaceId}`,
      `Honcho session: ${sessionContext.honchoSessionId}`,
      `Recall mode: ${this.config.recallMode}`,
      '',
      'Workspace memory files were checked and seeded where available.',
      'Use `/honcho status` to verify connectivity and `/honcho identity --show` to inspect the current peer representations.',
    ].join('\n');
  }

  async persistConfigValue(key, value) {
    const raw =
      typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    await this.api.writeConfigValue(key, raw);
  }

  async buildProfile(sessionContext, targetPeer) {
    const peerTargetId =
      targetPeer === 'agent'
        ? sessionContext.agentPeerId
        : sessionContext.userPeerId;
    const peerPerspectiveId =
      targetPeer === 'agent'
        ? sessionContext.userPeerId
        : sessionContext.agentPeerId;
    const result = await this.client.getSessionContext({
      ...sessionContext,
      includeSummary: false,
      limitToSession: false,
      peerTargetId,
      peerPerspectiveId,
    });
    return {
      representation: result?.peer_representation || '',
      peerCard: result?.peer_card || [],
    };
  }

  async handleToolProfile(args, context) {
    const targetPeer = parsePeerSelection(args.peer);
    const sessionContext = await this.prepareSession(
      {
        sessionId: context.sessionId,
      },
      { seedWorkspace: true },
    );
    const profile = await this.buildProfile(sessionContext, targetPeer);
    return formatProfileText(profile);
  }

  async handleToolSearch(args, context) {
    const query = normalizeString(args.query);
    if (!query) {
      throw new Error('Missing required parameter: query');
    }
    const sessionContext = await this.prepareSession(
      {
        sessionId: context.sessionId,
      },
      { seedWorkspace: true },
    );
    const targetPeer = parsePeerSelection(args.peer);
    const targetPeerId =
      targetPeer === 'agent' ? undefined : sessionContext.userPeerId;
    const representation = await this.client.getPeerRepresentation({
      peerId: sessionContext.agentPeerId,
      targetPeerId,
      honchoSessionId: sessionContext.honchoSessionId,
      query,
    });
    const messageResults = await this.client.searchSession({
      honchoSessionId: sessionContext.honchoSessionId,
      query,
      limit: this.config.searchLimit,
    });
    return [
      'Honcho search',
      '',
      formatProfileText({
        representation:
          representation?.representation || representation?.peer_representation,
        peerCard: representation?.peer_card || representation?.card || [],
      }),
      '',
      'Session message matches:',
      formatSearchResult(messageResults),
    ].join('\n');
  }

  async handleToolContext(args, context) {
    const query = normalizeString(args.query);
    if (!query) {
      throw new Error('Missing required parameter: query');
    }
    const peer = parsePeerSelection(args.peer);
    const sessionContext = await this.prepareSession(
      {
        sessionId: context.sessionId,
      },
      { seedWorkspace: true },
    );
    const queryPeerId = sessionContext.agentPeerId;
    const targetPeerId =
      peer === 'user' ? sessionContext.userPeerId : undefined;
    const result = await this.client.chatWithPeer({
      peerId: queryPeerId,
      targetPeerId,
      honchoSessionId: sessionContext.honchoSessionId,
      query,
      reasoningLevel: dynamicReasoningLevel(
        this.config,
        query,
        peer === 'user' ? 'medium' : this.config.dialecticReasoningLevel,
      ),
    });
    return result || 'No Honcho answer was returned.';
  }

  async handleToolConclude(args, context) {
    const conclusion = normalizeString(args.conclusion);
    if (!conclusion) {
      throw new Error('Missing required parameter: conclusion');
    }
    const sessionContext = await this.prepareSession(
      {
        sessionId: context.sessionId,
      },
      { seedWorkspace: true },
    );
    const observerPeerId = sessionContext.agentPeerId;
    const observedPeerId = sessionContext.userPeerId;
    await this.client.createConclusions({
      ...sessionContext,
      observerPeerId,
      observedPeerId,
      conclusions: [conclusion],
    });
    return `Conclusion saved: ${conclusion}`;
  }
}
