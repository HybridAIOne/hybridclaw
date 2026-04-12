import fs from 'node:fs';
import path from 'node:path';
import { dynamicReasoningLevel } from './config.js';
import { sanitizeHonchoSessionId } from './honcho-client.js';

function normalizeString(value) {
  return String(value || '').trim();
}

function formatPeerCard(card) {
  if (!Array.isArray(card) || card.length === 0) return '';
  return card
    .map((entry) => normalizeString(entry))
    .filter(Boolean)
    .map((entry) => `- ${entry}`)
    .join('\n');
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

function isPathInsideRoot(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function resolveSafeWorkspaceFilePath(fileArg, rootPath) {
  const allowedRoot = path.resolve(String(rootPath || '.'));
  const resolvedPath = path.resolve(allowedRoot, String(fileArg || ''));

  if (!isPathInsideRoot(resolvedPath, allowedRoot)) {
    return {
      ok: false,
      error: `Refusing to read files outside the active workspace root: ${allowedRoot}`,
    };
  }

  if (!fs.existsSync(resolvedPath)) {
    return {
      ok: false,
      error: `File not found: ${resolvedPath}`,
    };
  }

  const realAllowedRoot = fs.realpathSync.native(allowedRoot);
  const realResolvedPath = fs.realpathSync.native(resolvedPath);
  if (!isPathInsideRoot(realResolvedPath, realAllowedRoot)) {
    return {
      ok: false,
      error: `Refusing to read files outside the active workspace root: ${allowedRoot}`,
    };
  }

  const stats = fs.statSync(realResolvedPath);
  if (!stats.isFile()) {
    return {
      ok: false,
      error: `Not a file: ${resolvedPath}`,
    };
  }

  return {
    ok: true,
    resolvedPath,
    realResolvedPath,
  };
}

export class HonchoControls {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async setConfigValue(key, value) {
    this.runtime.config[key] = value;
    await this.persistConfigValue(key, value);
  }

  async persistConfigValue(key, value) {
    const raw =
      typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    await this.runtime.api.writeConfigValue(key, raw);
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
    const result = await this.runtime.client.getSessionContext({
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
          this.runtime.config,
          this.runtime.resolveSessionContext(context).sessionRoot,
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
        `Workspace: ${this.runtime.config.workspaceId}`,
        '',
        message,
      ].join('\n');
    }
  }

  async handleStatusCommand(context) {
    const sessionContext = await this.runtime.prepareSession(context);
    const status = await this.runtime.client.getQueueStatus(
      sessionContext.honchoSessionId,
    );
    return [
      'Honcho status',
      `Base URL: ${this.runtime.config.baseUrl}`,
      `Workspace: ${this.runtime.config.workspaceId}`,
      `Honcho session: ${sessionContext.honchoSessionId}`,
      'Built-in memory: always on',
      `Honcho recall mode: ${this.runtime.config.recallMode}`,
      `Write frequency: ${this.runtime.config.writeFrequency}`,
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
    const sessionContext = await this.runtime.prepareSession(context);
    const results = await this.runtime.client.searchSession({
      honchoSessionId: sessionContext.honchoSessionId,
      query,
      limit: this.runtime.config.searchLimit,
    });
    return formatSearchResult(results);
  }

  async handleMapCommand(args, context) {
    const sessionRoot = this.runtime.resolveSessionContext(context).sessionRoot;
    if (args.length === 0) {
      return formatMappingsText(this.runtime.config, sessionRoot);
    }
    if (
      args.includes('--clear') ||
      normalizeString(args[0]).toLowerCase() === 'clear'
    ) {
      const sessions = { ...(this.runtime.config.sessions || {}) };
      delete sessions[sessionRoot];
      if (Object.keys(sessions).length === 0) {
        await this.runtime.api.unsetConfigValue('sessions');
        this.runtime.config.sessions = {};
      } else {
        await this.setConfigValue('sessions', sessions);
      }
      return `Removed Honcho session mapping for ${sessionRoot}.`;
    }
    const mappingName = sanitizeHonchoSessionId(args.join(' '));
    const sessions = { ...(this.runtime.config.sessions || {}) };
    sessions[sessionRoot] = mappingName;
    await this.setConfigValue('sessions', sessions);
    return `Mapped ${sessionRoot} to Honcho session ${mappingName}.`;
  }

  async handleRecallModeCommand(args, commandName) {
    if (args.length === 0) {
      return [
        'Honcho recall mode',
        'Built-in HybridClaw memory stays on; this command only changes Honcho recall behavior.',
        `Current: ${this.runtime.config.recallMode}`,
        '',
        `Set with \`/honcho ${commandName} <hybrid|context|tools>\`.`,
        'Alias: `/honcho recall <hybrid|context|tools>`.',
      ].join('\n');
    }
    const nextMode = normalizeString(args[0]).toLowerCase();
    if (!['hybrid', 'context', 'tools'].includes(nextMode)) {
      return `Usage: /honcho ${commandName} <hybrid|context|tools>`;
    }
    await this.setConfigValue('recallMode', nextMode);
    return [
      `Updated Honcho recall mode to ${nextMode}.`,
      'Run `/plugin reload` or restart the gateway to refresh tool visibility.',
    ].join('\n');
  }

  async handleModeCommand(args) {
    return this.handleRecallModeCommand(args, 'mode');
  }

  async handleRecallCommand(args) {
    return this.handleRecallModeCommand(args, 'recall');
  }

  async handlePeerCommand(args) {
    if (args.length === 0) {
      return [
        'Honcho peers',
        `User label: ${this.runtime.config.peerName || '(derived from session user id)'}`,
        `AI peer: ${this.runtime.config.aiPeer || '(derived from current agent id)'}`,
        `Dialectic reasoning floor: ${this.runtime.config.dialecticReasoningLevel}`,
      ].join('\n');
    }
    const userValue = parseFlagValue(args, '--user');
    const aiValue = parseFlagValue(args, '--ai');
    const reasoningValue = parseFlagValue(args, '--reasoning');
    if (userValue != null && userValue) {
      await this.setConfigValue('peerName', userValue);
    }
    if (aiValue != null && aiValue) {
      await this.setConfigValue('aiPeer', aiValue);
    }
    if (reasoningValue != null && reasoningValue) {
      if (
        !['minimal', 'low', 'medium', 'high', 'max'].includes(reasoningValue)
      ) {
        return 'Usage: /honcho peer [--user <name>] [--ai <name>] [--reasoning <minimal|low|medium|high|max>]';
      }
      await this.setConfigValue('dialecticReasoningLevel', reasoningValue);
    }
    return [
      'Updated Honcho peer configuration.',
      `User label: ${this.runtime.config.peerName || '(derived from session user id)'}`,
      `AI peer: ${this.runtime.config.aiPeer || '(derived from current agent id)'}`,
      `Dialectic reasoning floor: ${this.runtime.config.dialecticReasoningLevel}`,
    ].join('\n');
  }

  async handleTokensCommand(args) {
    if (args.length === 0) {
      return [
        'Honcho budgets',
        `Context tokens: ${this.runtime.config.contextTokens}`,
        `Dialectic max chars: ${this.runtime.config.dialecticMaxChars}`,
        `Dialectic max input chars: ${this.runtime.config.dialecticMaxInputChars}`,
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
      await this.setConfigValue('contextTokens', Math.trunc(parsed));
    }
    if (dialecticValue != null && dialecticValue) {
      const parsed = Number(dialecticValue);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return 'Usage: /honcho tokens [--context <n>] [--dialectic <n>] [--input <n>]';
      }
      await this.setConfigValue('dialecticMaxChars', Math.trunc(parsed));
    }
    if (inputValue != null && inputValue) {
      const parsed = Number(inputValue);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return 'Usage: /honcho tokens [--context <n>] [--dialectic <n>] [--input <n>]';
      }
      await this.setConfigValue('dialecticMaxInputChars', Math.trunc(parsed));
    }
    return [
      'Updated Honcho budgets.',
      `Context tokens: ${this.runtime.config.contextTokens}`,
      `Dialectic max chars: ${this.runtime.config.dialecticMaxChars}`,
      `Dialectic max input chars: ${this.runtime.config.dialecticMaxInputChars}`,
    ].join('\n');
  }

  async handleSyncCommand(context) {
    const sessionContext = await this.runtime.prepareSession(context);
    await this.runtime.flushBufferedMessages(context.sessionId, sessionContext);
    await this.runtime.schedulePrefetch(
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
    const sessionContext = await this.runtime.prepareSession(context);
    if (args.includes('--show')) {
      const user = await this.runtime.client.getSessionContext({
        ...sessionContext,
        includeSummary: false,
        limitToSession: false,
        peerTargetId: sessionContext.userPeerId,
        peerPerspectiveId: sessionContext.agentPeerId,
      });
      const ai = await this.runtime.client.getSessionContext({
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
    const filePath = resolveSafeWorkspaceFilePath(
      fileArg,
      sessionContext.sessionRoot || this.runtime.api.runtime.cwd,
    );
    if (!filePath.ok) {
      return filePath.error;
    }
    const content = normalizeString(
      fs.readFileSync(filePath.realResolvedPath, 'utf-8'),
    );
    if (!content) {
      return `File is empty: ${filePath.resolvedPath}`;
    }
    await this.runtime.client.syncMessages({
      honchoSessionId: sessionContext.honchoSessionId,
      userId: sessionContext.userId,
      agentId: sessionContext.agentId,
      messages: [
        {
          id: Date.now(),
          role: 'assistant',
          content: `<ai_identity_seed>\n<source>${path.basename(
            filePath.resolvedPath,
          )}</source>\n\n${content}\n</ai_identity_seed>`,
          created_at: new Date().toISOString(),
        },
      ],
    });
    return `Seeded Honcho AI identity from ${filePath.resolvedPath}.`;
  }

  async handleSetupCommand(context) {
    const sessionContext = await this.runtime.prepareSession(context, {
      prewarm: true,
      query: 'What should I know about this user?',
    });
    return [
      'Honcho setup',
      `Workspace: ${this.runtime.config.workspaceId}`,
      `Honcho session: ${sessionContext.honchoSessionId}`,
      `Recall mode: ${this.runtime.config.recallMode}`,
      '',
      'Workspace memory files were checked and seeded where available.',
      'Use `/honcho status` to verify connectivity and `/honcho identity --show` to inspect the current peer representations.',
    ].join('\n');
  }

  async handleToolProfile(args, context) {
    const targetPeer = parsePeerSelection(args.peer);
    const sessionContext = await this.runtime.prepareSession({
      sessionId: context.sessionId,
    });
    const profile = await this.buildProfile(sessionContext, targetPeer);
    return formatProfileText(profile);
  }

  async handleToolSearch(args, context) {
    const query = normalizeString(args.query);
    if (!query) {
      throw new Error('Missing required parameter: query');
    }
    const sessionContext = await this.runtime.prepareSession({
      sessionId: context.sessionId,
    });
    const targetPeer = parsePeerSelection(args.peer);
    const targetPeerId =
      targetPeer === 'agent' ? undefined : sessionContext.userPeerId;
    const representation = await this.runtime.client.getPeerRepresentation({
      peerId: sessionContext.agentPeerId,
      targetPeerId,
      honchoSessionId: sessionContext.honchoSessionId,
      query,
    });
    const messageResults = await this.runtime.client.searchSession({
      honchoSessionId: sessionContext.honchoSessionId,
      query,
      limit: this.runtime.config.searchLimit,
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
    const sessionContext = await this.runtime.prepareSession({
      sessionId: context.sessionId,
    });
    const result = await this.runtime.client.chatWithPeer({
      peerId: sessionContext.agentPeerId,
      targetPeerId: peer === 'user' ? sessionContext.userPeerId : undefined,
      honchoSessionId: sessionContext.honchoSessionId,
      query,
      reasoningLevel: dynamicReasoningLevel(
        this.runtime.config,
        query,
        peer === 'user'
          ? 'medium'
          : this.runtime.config.dialecticReasoningLevel,
      ),
    });
    return result || 'No Honcho answer was returned.';
  }

  async handleToolConclude(args, context) {
    const conclusion = normalizeString(args.conclusion);
    if (!conclusion) {
      throw new Error('Missing required parameter: conclusion');
    }
    const sessionContext = await this.runtime.prepareSession({
      sessionId: context.sessionId,
    });
    await this.runtime.client.createConclusions({
      ...sessionContext,
      observerPeerId: sessionContext.agentPeerId,
      observedPeerId: sessionContext.userPeerId,
      conclusions: [conclusion],
    });
    return `Conclusion saved: ${conclusion}`;
  }
}
