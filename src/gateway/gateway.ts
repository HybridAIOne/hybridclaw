/**
 * Owns channel startup and shutdown; webhook handlers only consume live runtimes.
 * Voice refreshes serialize config and secret changes, preserve healthy calls on
 * credential refresh, and cannot re-enable a channel during gateway shutdown.
 */

import { resolveEffectiveTimezone } from '../../container/shared/workspace-time.js';
import {
  startA2AInboxDispatchProcessor,
  stopA2AInboxDispatchProcessor,
} from '../a2a/a2a-inbox-dispatcher.js';
import {
  startA2AOutboxProcessor,
  stopA2AOutboxProcessor,
} from '../a2a/a2a-outbound.js';
import { isA2ALocalModeEnabled } from '../a2a/local-mode.js';
import { ensureA2AInstanceKeypair } from '../a2a/trust-ledger.js';
import {
  startWebhookOutboxProcessor,
  stopWebhookOutboxProcessor,
} from '../a2a/webhook-outbound.js';
import {
  getInFlightExecutorCount,
  stopAllExecutions,
} from '../agent/executor.js';
import { isWithinActiveHours } from '../agent/proactive-policy.js';
import {
  listAgents,
  resolveAgentForRequest,
} from '../agents/agent-registry.js';
import { flushAuditTrail } from '../audit/audit-trail.js';
import {
  startObservabilityIngest,
  stopObservabilityIngest,
} from '../audit/observability-ingest.js';
import { startHybridAIAccessTokenMaintenance } from '../auth/hybridai-oauth.js';
import type {
  ChannelDescriptor,
  ExternalChannelKind,
} from '../channels/channel-descriptor.js';
import {
  CHANNEL_DESCRIPTORS,
  getChannelDescriptor,
} from '../channels/channel-descriptors.js';
import type { ChannelPluginAvailabilityChange } from '../channels/channel-plugin-catalog.js';
import { discordRuntimeLoader } from '../channels/channel-runtime-loaders.js';
import {
  isVoiceRuntimeAvailable,
  shutdownVoice,
} from '../channels/voice/runtime.js';
import {
  getConfigSnapshot,
  HEARTBEAT_CHANNEL,
  HEARTBEAT_INTERVAL,
  onConfigChange,
  onRuntimeSecretsRefresh,
  TWILIO_AUTH_TOKEN,
} from '../config/config.js';
import {
  type RuntimeConfig,
  startRuntimeConfigWatcher,
} from '../config/runtime-config.js';
import { resolveLocalInstanceId } from '../identity/agent-id.js';
import { logger } from '../logger.js';
import {
  startPeriodicCloudMemorySync,
  stopPeriodicCloudMemorySync,
} from '../memory/cloud-memory.js';
import {
  getDreamTimezone,
  hasDreamRunToday,
  isMemoryConsolidationEnabled,
  nextDreamRunAt,
  runMemoryConsolidation,
} from '../memory/consolidation-runner.js';
import {
  closeDatabase,
  deleteQueuedProactiveMessage,
  failStaleDelegationJobs,
  getFailedProactiveMessageCount,
  getMostRecentSessionChannelId,
  getQueuedProactiveMessageCount,
  initDatabase,
  listQueuedProactiveMessages,
  markQueuedProactiveMessageFailed,
  pruneFailedProactiveMessages,
} from '../memory/db.js';
import { initOtel, shutdownOtel } from '../observability/otel.js';
import {
  captureSentryException,
  initSentry,
  shutdownSentry,
} from '../observability/sentry.js';
import { hybridAIProbe } from '../providers/hybridai-health.js';
import {
  startDiscoveryLoop,
  stopDiscoveryLoop,
} from '../providers/local-discovery.js';
import { localBackendsProbe } from '../providers/local-health.js';
import { startHeartbeat, stopHeartbeat } from '../scheduler/heartbeat.js';
import { startScheduler, stopScheduler } from '../scheduler/scheduler.js';
import { persistThirdPartySkillDiscoveryDefaults } from '../skills/skills.js';
import {
  startTokenUsageBuffer,
  stopTokenUsageBuffer,
} from '../usage/token-usage-buffer.js';
import { dispatchA2AInboxItemToGateway } from './a2a-inbox-dispatch.js';
import { validateGatewayPromptEnvDefaults } from './gateway-chat-service.js';
import { startGatewayHttpServer } from './gateway-http-server.js';
import {
  initGatewayService,
  setChannelPluginAvailabilityListener,
  stopGatewayPlugins,
} from './gateway-plugin-service.js';
import { runScheduledTask } from './gateway-scheduled-dispatch.js';
import { migrateConfigSchedulerJobsToDatabase } from './gateway-scheduled-task-service.js';
import {
  getGatewayStatus,
  resumeEnabledFullAutoSessions,
} from './gateway-service.js';
import {
  getInFlightTurnCount,
  markGatewayShuttingDown,
} from './in-flight-turns.js';
import { runManagedMediaCleanup } from './managed-media-cleanup.js';
import {
  hasImmediateProactiveDeliveryPath,
  hasQueuedProactiveDeliveryPath,
  resolveHeartbeatDeliveryChannelId,
  shouldDropQueuedProactiveMessage,
} from './proactive-delivery.js';
import {
  deliverProactiveMessage,
  MAX_QUEUED_PROACTIVE_MESSAGES,
  sendProactiveMessageNow,
} from './proactive-dispatch.js';
import { deliverScheduledWebhook } from './scheduled-webhook-delivery.js';

let detachConfigListener: (() => void) | null = null;
let detachSecretsRefreshListener: (() => void) | null = null;
let voiceIntegrationRefresh = Promise.resolve();
let voiceIntegrationShuttingDown = false;
let proactiveFlushTimer: ReturnType<typeof setInterval> | null = null;
let memoryConsolidationTimer: ReturnType<typeof setTimeout> | null = null;
let a2aLocalModeTransition = Promise.resolve();

function scheduleNextMemoryConsolidationRun(): void {
  if (!isMemoryConsolidationEnabled()) {
    logger.info('Memory consolidation scheduler disabled');
    return;
  }

  const nextRunAt = nextDreamRunAt();
  const delayMs = Math.max(1_000, nextRunAt.getTime() - Date.now());
  memoryConsolidationTimer = setTimeout(() => {
    memoryConsolidationTimer = null;
    void runMemoryConsolidation({
      trigger: 'nightly',
      requireSchedulerEnabled: true,
    })
      .catch(() => undefined)
      .finally(() => {
        scheduleNextMemoryConsolidationRun();
      });
  }, delayMs);

  logger.info(
    {
      nextRunAt: nextRunAt.toISOString(),
      timeZone: resolveEffectiveTimezone(getDreamTimezone()),
    },
    'Memory consolidation scheduled for next nightly run',
  );
}

function logGatewayStartup(params: {
  status: Awaited<ReturnType<typeof getGatewayStatus>>;
  channels: Partial<Record<ExternalChannelKind, boolean>>;
}): void {
  const {
    pid: _pid,
    timestamp: _timestamp,
    codex,
    sandbox,
    observability,
    providerHealth,
    localBackends,
    pluginCommands,
    ...status
  } = params.status;

  logger.info(
    {
      ...status,
      ...(codex
        ? {
            codex: {
              authenticated: codex.authenticated,
              source: codex.source,
              reloginRequired: codex.reloginRequired,
            },
          }
        : {}),
      ...(sandbox
        ? {
            sandbox: {
              mode: sandbox.mode,
              modeExplicit: sandbox.modeExplicit,
              runningInsideContainer: sandbox.runningInsideContainer,
              activeSessions: sandbox.activeSessions,
              warning: sandbox.warning,
            },
          }
        : {}),
      ...(observability
        ? {
            observability: {
              enabled: observability.enabled,
              running: observability.running,
              paused: observability.paused,
              reason: observability.reason,
            },
          }
        : {}),
    },
    'HybridClaw gateway started',
  );

  logger.info(
    {
      ...(providerHealth ? { providerHealth } : {}),
      ...(localBackends ? { localBackends } : {}),
    },
    'Gateway provider health',
  );

  if (pluginCommands?.length) {
    logger.info({ pluginCommands }, 'Gateway plugin commands');
  }

  logger.info(
    Object.fromEntries(
      Object.entries(params.channels).map(([kind, active]) => [
        kind.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        active,
      ]),
    ),
    'Gateway channels',
  );
}

function resolveLastUsedDeliverableChannelId(): string | null {
  const channelId = getMostRecentSessionChannelId();
  if (!channelId) return null;
  return hasQueuedProactiveDeliveryPath({ channel_id: channelId })
    ? channelId
    : null;
}

async function flushQueuedProactiveMessages(): Promise<void> {
  if (!isWithinActiveHours()) return;
  const pending = listQueuedProactiveMessages(MAX_QUEUED_PROACTIVE_MESSAGES);
  if (pending.length === 0) return;
  logger.info(
    { flushing: pending.length, queued: getQueuedProactiveMessageCount() },
    'Flushing queued proactive messages',
  );

  pruneFailedProactiveMessages();
  let failedUndeliverable = 0;
  for (const item of pending) {
    if (!isWithinActiveHours()) break;
    if (shouldDropQueuedProactiveMessage(item)) {
      markQueuedProactiveMessageFailed(
        item.id,
        `No proactive delivery path for channel "${item.channel_id}"`,
      );
      failedUndeliverable += 1;
      continue;
    }
    if (!hasImmediateProactiveDeliveryPath(item)) {
      continue;
    }
    const outcome = await sendProactiveMessageNow(
      item.channel_id,
      item.text,
      `${item.source}:queued`,
    );
    if (outcome.status === 'failed') {
      markQueuedProactiveMessageFailed(
        item.id,
        outcome.reason || 'Delivery failed',
      );
      failedUndeliverable += 1;
      continue;
    }
    deleteQueuedProactiveMessage(item.id);
  }

  if (failedUndeliverable > 0) {
    logger.warn(
      {
        failed: failedUndeliverable,
        totalFailed: getFailedProactiveMessageCount(),
      },
      'Queued proactive messages marked as failed (undeliverable)',
    );
  }
}

function shouldSkipChannelConfigRefresh(
  next: RuntimeConfig,
  prev: RuntimeConfig,
): boolean {
  return (
    next.deployment.a2a_local_mode ||
    next.deployment.a2a_local_mode !== prev.deployment.a2a_local_mode
  );
}

/**
 * Starts or stops install-on-demand channel integrations when a plugin
 * runtime reload changes which channel transports are registered. This is
 * what makes an admin-console plugin install take effect immediately: the
 * install reloads the plugin manager (registering the transport), and this
 * hook then brings the channel runtime up without requiring a full gateway
 * restart. The reverse transition (transport removed by uninstall/disable)
 * shuts the channel runtime down so it does not keep using a dead transport.
 */
async function refreshChannelIntegrationsForPluginAvailability(
  changes: ChannelPluginAvailabilityChange[],
): Promise<void> {
  const externalChannelsEnabled = !isA2ALocalModeEnabled(getConfigSnapshot());
  for (const change of changes) {
    logger.info(
      { channel: change.channel, transportAvailable: change.available },
      change.available
        ? 'Channel transport plugin became available; refreshing channel integration'
        : 'Channel transport plugin became unavailable; stopping channel integration',
    );
    const descriptor = getChannelDescriptor(change.channel);
    if (!descriptor) throw new Error(`Unsupported channel: ${change.channel}`);
    await descriptor.stop().catch((error) => {
      logger.debug(
        { error, channel: change.channel },
        'Failed to stop channel during plugin availability refresh',
      );
    });
    if (change.available && externalChannelsEnabled) await descriptor.start();
  }
}

function refreshVoiceIntegration(restart = false): Promise<void> {
  voiceIntegrationRefresh = voiceIntegrationRefresh
    .then(async () => {
      await a2aLocalModeTransition;
      if (
        voiceIntegrationShuttingDown ||
        isA2ALocalModeEnabled(getConfigSnapshot())
      )
        return;
      const voiceConfig = getConfigSnapshot().voice;
      // Credential refreshes preserve healthy calls; config changes restart voice.
      if (!restart) {
        if (!voiceConfig.enabled) return;
        if (isVoiceRuntimeAvailable()) {
          if (!String(TWILIO_AUTH_TOKEN || '').trim()) {
            await shutdownVoice();
          }
          return;
        }
      } else {
        logger.info(
          {
            enabled: voiceConfig.enabled,
            provider: voiceConfig.provider,
            webhookPath: voiceConfig.webhookPath,
          },
          'Config changed, restarting Voice integration',
        );
        await shutdownVoice();
      }
      if (
        voiceIntegrationShuttingDown ||
        isA2ALocalModeEnabled(getConfigSnapshot())
      )
        return;
      await CHANNEL_DESCRIPTORS.voice.start();
    })
    .catch((error) => {
      logger.warn({ error }, 'Voice integration refresh failed');
    });
  return voiceIntegrationRefresh;
}

async function refreshVoiceIntegrationForConfigChange(
  next: ReturnType<typeof getConfigSnapshot>,
  prev: ReturnType<typeof getConfigSnapshot>,
): Promise<void> {
  if (shouldSkipChannelConfigRefresh(next, prev)) return;
  const restart = CHANNEL_DESCRIPTORS.voice.configChanged(next, prev);
  if (!restart && next.voice.twilio.authToken === prev.voice.twilio.authToken)
    return;
  await refreshVoiceIntegration(restart);
}

async function stopExternalChannelIntegrationsForA2ALocalMode(): Promise<void> {
  for (const descriptor of Object.values(CHANNEL_DESCRIPTORS)) {
    await runShutdownStep(`stop ${descriptor.kind} runtime`, descriptor.stop);
  }
}

async function startExternalChannelIntegrations(
  enabled = true,
): Promise<Partial<Record<ExternalChannelKind, boolean>>> {
  const active: Partial<Record<ExternalChannelKind, boolean>> = {};
  for (const descriptor of Object.values(CHANNEL_DESCRIPTORS)) {
    active[descriptor.kind] = enabled ? await descriptor.start() : false;
  }
  return active;
}

async function refreshChannelIntegrationForConfigChange(
  descriptor: ChannelDescriptor,
  next: RuntimeConfig,
  prev: RuntimeConfig,
): Promise<void> {
  if (shouldSkipChannelConfigRefresh(next, prev)) return;
  if (descriptor.kind === 'voice') {
    await refreshVoiceIntegrationForConfigChange(next, prev);
    return;
  }
  if (!descriptor.configChanged(next, prev)) return;
  logger.info(
    { channel: descriptor.kind },
    'Config changed, restarting channel integration',
  );
  await descriptor.stop().catch((error) => {
    logger.debug(
      { error, channel: descriptor.kind },
      'Failed to stop channel during config-change restart',
    );
  });
  await descriptor.start();
}

async function refreshA2ALocalModeForConfigChange(
  next: RuntimeConfig,
  prev: RuntimeConfig,
): Promise<void> {
  if (next.deployment.a2a_local_mode === prev.deployment.a2a_local_mode) {
    return;
  }
  if (next.deployment.a2a_local_mode) {
    logger.info('A2A local mode enabled; stopping external channel runtimes');
    await stopExternalChannelIntegrationsForA2ALocalMode();
    return;
  }
  logger.info('A2A local mode disabled; starting configured channel runtimes');
  await startExternalChannelIntegrations();
}

const SHUTDOWN_STEP_TIMEOUT_MS = 5_000;

async function runShutdownStep(
  step: string,
  run: () => Promise<void> | void,
  timeoutMs = SHUTDOWN_STEP_TIMEOUT_MS,
): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve()
    .then(run)
    .then(
      () => ({ status: 'done' as const }),
      (error) => ({ status: 'error' as const, error }),
    );
  const timeout = new Promise<{ status: 'timeout' }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });

  try {
    const result = await Promise.race([operation, timeout]);
    if (result.status === 'error') {
      logger.debug(
        { error: result.error, step },
        'Gateway shutdown step failed',
      );
    } else if (result.status === 'timeout') {
      logger.warn(
        { step, timeoutMs },
        'Gateway shutdown step timed out; continuing',
      );
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function setupShutdown(broadcastShutdown: () => void): void {
  let shuttingDown = false;
  const shutdown = async (opts?: { drain?: boolean }) => {
    if (shuttingDown) return;
    shuttingDown = true;
    voiceIntegrationShuttingDown = true;
    logger.info('Shutting down gateway...');
    if (detachConfigListener) {
      detachConfigListener();
      detachConfigListener = null;
    }
    detachSecretsRefreshListener?.();
    detachSecretsRefreshListener = null;
    setChannelPluginAvailabilityListener(null);
    await runShutdownStep('set Discord maintenance presence', () =>
      discordRuntimeLoader.current()?.setDiscordMaintenancePresence(),
    );
    if (opts?.drain) {
      markGatewayShuttingDown();
      const DRAIN_TIMEOUT_MS = 15_000;
      const DRAIN_POLL_MS = 250;
      const deadline = Date.now() + DRAIN_TIMEOUT_MS;
      const inFlight = () =>
        getInFlightExecutorCount() + getInFlightTurnCount();
      while (inFlight() > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, DRAIN_POLL_MS),
        );
      }
      const remaining = inFlight();
      if (remaining > 0) {
        logger.warn(
          { remaining, timeoutMs: DRAIN_TIMEOUT_MS },
          'Drain timed out; stopping in-flight executions',
        );
      }
      broadcastShutdown();
      stopAllExecutions();
    }
    for (const descriptor of Object.values(CHANNEL_DESCRIPTORS)) {
      if (descriptor.kind === 'voice') {
        await runShutdownStep(
          'settle Voice refresh',
          () => voiceIntegrationRefresh,
        );
      }
      await runShutdownStep(`stop ${descriptor.kind} runtime`, () =>
        descriptor.stop(opts),
      );
    }
    await runShutdownStep('run managed media cleanup', () =>
      runManagedMediaCleanup('shutdown'),
    );
    stopHeartbeat();
    stopPeriodicCloudMemorySync();
    stopA2AInboxDispatchProcessor();
    stopA2AOutboxProcessor();
    stopWebhookOutboxProcessor();
    stopObservabilityIngest();
    await stopTokenUsageBuffer().catch((error) => {
      logger.debug({ error }, 'Failed to drain token usage buffer at shutdown');
    });
    stopDiscoveryLoop();
    if (!opts?.drain) {
      stopAllExecutions();
    }
    await runShutdownStep('stop gateway plugins', stopGatewayPlugins);
    stopScheduler();
    stopMemoryConsolidationScheduler();
    await runShutdownStep('flush audit trail', flushAuditTrail);
    // Every database writer is stopped by now; checkpoint and close so no
    // WAL is left behind if the process is killed during the flushes below.
    await runShutdownStep('close database', closeDatabase);
    await runShutdownStep('shut down OTel', shutdownOtel);
    await runShutdownStep('flush Sentry', shutdownSentry);
    if (proactiveFlushTimer) {
      clearInterval(proactiveFlushTimer);
      proactiveFlushTimer = null;
    }
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown({ drain: true });
  });
}

function startOrRestartHeartbeat(): void {
  stopHeartbeat();
  const { agentId } = resolveAgentForRequest({});
  startHeartbeat(agentId, HEARTBEAT_INTERVAL, (text) => {
    const channelId = resolveHeartbeatDeliveryChannelId({
      explicitChannelId: HEARTBEAT_CHANNEL,
      lastUsedChannelId: resolveLastUsedDeliverableChannelId(),
    });
    if (!channelId) {
      logger.info(
        { text },
        'Heartbeat message dropped: no delivery channel available',
      );
      return;
    }
    void deliverProactiveMessage(channelId, text, 'heartbeat');
    logger.info({ channelId, text }, 'Heartbeat message');
  });
}

function stopMemoryConsolidationScheduler(): void {
  if (!memoryConsolidationTimer) return;
  clearTimeout(memoryConsolidationTimer);
  memoryConsolidationTimer = null;
}

function startOrRestartMemoryConsolidationScheduler(): void {
  stopMemoryConsolidationScheduler();
  if (!isMemoryConsolidationEnabled()) {
    logger.info('Memory consolidation scheduler disabled');
    return;
  }

  if (!hasDreamRunToday()) {
    void runMemoryConsolidation({
      trigger: 'startup',
      requireSchedulerEnabled: true,
    }).catch(() => undefined);
  }
  scheduleNextMemoryConsolidationRun();
}

function logWarmProcessPoolStartup(config: RuntimeConfig['container']): void {
  const warmPool = config.warmPool;
  if (!warmPool.enabled || warmPool.maxIdlePerAgent <= 0) return;
  logger.info(
    {
      sandboxMode: config.sandboxMode,
      minIdlePerActiveAgent: warmPool.minIdlePerActiveAgent,
      maxIdlePerAgent: warmPool.maxIdlePerAgent,
      effectiveMinIdlePerActiveAgent: Math.min(
        warmPool.minIdlePerActiveAgent,
        warmPool.maxIdlePerAgent,
      ),
      memoryPressureRssMb: warmPool.memoryPressureRssMb,
      coldStartBudgetMs: warmPool.coldStartBudgetMs,
      warmScope:
        'runtime process only; request-specific MCP, plugin, media, and model setup still runs after input',
      warmFill:
        'filled after recent traffic for an agent; gateway startup does not pre-spawn workers',
      disableConfig: 'container.warmPool.enabled=false',
    },
    'Warm process pool enabled; idle workers prewarm runtime process startup only',
  );
}

async function main(): Promise<void> {
  await initSentry();
  await initOtel();
  logger.info('Starting HybridClaw gateway');
  startRuntimeConfigWatcher();
  ensureA2AInstanceKeypair();
  logger.info(
    { instanceId: resolveLocalInstanceId() },
    'Local instance identity ready',
  );
  logWarmProcessPoolStartup(getConfigSnapshot().container);
  validateGatewayPromptEnvDefaults();
  initDatabase();
  const failedDelegationJobs = failStaleDelegationJobs('gateway_restart');
  if (failedDelegationJobs > 0) {
    logger.warn(
      { count: failedDelegationJobs },
      'Marked stale delegation jobs failed after gateway startup',
    );
  }
  migrateConfigSchedulerJobsToDatabase();
  listAgents();
  await initGatewayService();
  startHybridAIAccessTokenMaintenance();
  try {
    persistThirdPartySkillDiscoveryDefaults();
  } catch (error) {
    logger.warn(
      { error },
      'Failed to persist third-party skill discovery defaults during startup',
    );
  }
  resumeEnabledFullAutoSessions();
  void runManagedMediaCleanup('startup').catch((error) => {
    logger.warn({ error }, 'Managed media cleanup failed during startup');
  });
  const httpServer = startGatewayHttpServer();
  setupShutdown(httpServer.broadcastShutdown.bind(httpServer));
  const externalChannelsEnabled = !isA2ALocalModeEnabled(getConfigSnapshot());
  if (!externalChannelsEnabled) {
    logger.info('A2A local mode enabled; external channels will not start');
  }
  const activeChannels = await startExternalChannelIntegrations(
    externalChannelsEnabled,
  );

  startOrRestartHeartbeat();
  startPeriodicCloudMemorySync({
    resolveAgentIds: () => listAgents().map((agent) => agent.id),
  });
  startA2AInboxDispatchProcessor(dispatchA2AInboxItemToGateway);
  startA2AOutboxProcessor();
  startWebhookOutboxProcessor();
  startObservabilityIngest();
  startTokenUsageBuffer();
  startDiscoveryLoop();
  void localBackendsProbe.get().catch((err) => {
    logger.warn({ err }, 'Startup warm-up of local backends probe failed');
  });
  void hybridAIProbe.get().catch((err) => {
    logger.warn({ err }, 'Startup warm-up of HybridAI probe failed');
  });
  setChannelPluginAvailabilityListener(
    refreshChannelIntegrationsForPluginAvailability,
  );
  detachConfigListener = onConfigChange((next, prev) => {
    a2aLocalModeTransition = a2aLocalModeTransition
      .then(() => refreshA2ALocalModeForConfigChange(next, prev))
      .catch((error) => {
        logger.warn(
          { error },
          'A2A local mode channel transition failed after config change',
        );
      });
    for (const descriptor of Object.values(CHANNEL_DESCRIPTORS)) {
      void refreshChannelIntegrationForConfigChange(
        descriptor,
        next,
        prev,
      ).catch((error) => {
        logger.warn(
          { error, channel: descriptor.kind },
          'Channel integration restart failed after config change',
        );
      });
    }

    const shouldRestart =
      next.hybridai.defaultChatbotId !== prev.hybridai.defaultChatbotId ||
      next.heartbeat.intervalMs !== prev.heartbeat.intervalMs ||
      next.heartbeat.enabled !== prev.heartbeat.enabled;
    if (shouldRestart) {
      logger.info(
        {
          heartbeatEnabled: next.heartbeat.enabled,
          heartbeatIntervalMs: next.heartbeat.intervalMs,
          heartbeatAgentId: next.hybridai.defaultChatbotId || 'default',
        },
        'Config changed, restarting heartbeat',
      );
      startOrRestartHeartbeat();
    }

    const memoryChanged =
      JSON.stringify(next.memory) !== JSON.stringify(prev.memory);
    if (memoryChanged) {
      logger.info(
        {
          consolidationIntervalHours: next.memory.consolidationIntervalHours,
          decayRate: next.memory.decayRate,
        },
        'Config changed, restarting memory consolidation scheduler',
      );
      startOrRestartMemoryConsolidationScheduler();
    }

    const shouldRestartObservability =
      JSON.stringify(next.observability) !==
        JSON.stringify(prev.observability) ||
      next.hybridai.defaultChatbotId !== prev.hybridai.defaultChatbotId;
    const localConfigChanged =
      JSON.stringify(next.local) !== JSON.stringify(prev.local);
    if (localConfigChanged) {
      logger.info(
        'Config changed, restarting local discovery and invalidating health cache',
      );
      startDiscoveryLoop();
      localBackendsProbe.invalidate();
    }
    if (!shouldRestartObservability) return;

    logger.info(
      {
        enabled: next.observability.enabled,
        botId: next.observability.botId || next.hybridai.defaultChatbotId || '',
        agentId: next.observability.agentId,
      },
      'Config changed, restarting observability ingest',
    );
    startObservabilityIngest();
  });
  detachSecretsRefreshListener = onRuntimeSecretsRefresh(() => {
    void refreshVoiceIntegration();
  });
  startScheduler((request) =>
    runScheduledTask(request, {
      deliverProactiveMessage,
      deliverWebhookMessage: deliverScheduledWebhook,
      resolveLastUsedDeliverableChannelId,
    }),
  );
  startOrRestartMemoryConsolidationScheduler();
  proactiveFlushTimer = setInterval(() => {
    void flushQueuedProactiveMessages().catch((err) => {
      logger.warn({ err }, 'Failed to flush queued proactive messages');
    });
  }, 60_000);
  void flushQueuedProactiveMessages().catch((err) => {
    logger.warn({ err }, 'Initial proactive queue flush failed');
  });

  logGatewayStartup({
    status: await getGatewayStatus(),
    channels: activeChannels,
  });
  httpServer.setReady();
}

main().catch(async (err) => {
  logger.fatal({ err }, 'Failed to start gateway');
  captureSentryException(err, {
    mechanism: 'gateway.startup',
  });
  await shutdownSentry();
  process.exit(1);
});
