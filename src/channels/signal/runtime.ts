import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import { getConfigSnapshot } from '../../config/config.js';
import type { RuntimeSignalConfig } from '../../config/runtime-config.js';
import { logger } from '../../logger.js';
import { SIGNAL_CAPABILITIES } from '../channel.js';
import { registerChannel } from '../channel-registry.js';
import {
  type SignalReceiveEvent,
  type SignalSseSubscription,
  streamSignalEvents,
} from './api.js';
import { sendChunkedSignalText, sendSignalTyping } from './delivery.js';
import { processInboundSignalMessage } from './inbound.js';
import { createSignalTypingController } from './typing.js';

export type SignalReplyFn = (content: string) => Promise<void>;

export interface SignalMessageContext {
  abortSignal: AbortSignal;
  event: SignalReceiveEvent;
  account: string;
}

export type SignalMessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  reply: SignalReplyFn,
  context: SignalMessageContext,
) => Promise<void>;

const SIGNAL_RECONNECT_BASE_MS = 1_500;
const SIGNAL_RECONNECT_MAX_MS = 30_000;

let runtimeInitialized = false;
let shutdownController: AbortController | null = null;
let activeSubscription: SignalSseSubscription | null = null;
let activeAccount: string | null = null;
let activeDaemonUrl: string | null = null;
let activeSignalConfig: RuntimeSignalConfig | null = null;
const inFlightControllers = new Set<AbortController>();

function createSignalShutdownAbortError(): Error {
  return new Error('Signal runtime shutting down.');
}

function abortInFlightHandlers(): void {
  for (const controller of inFlightControllers) {
    if (controller.signal.aborted) continue;
    controller.abort(createSignalShutdownAbortError());
  }
}

function resolveSignalConfig(): RuntimeSignalConfig {
  return (
    getConfigSnapshot().signal || {
      enabled: false,
      daemonUrl: '',
      account: '',
      dmPolicy: 'disabled',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      textChunkLimit: 4_000,
      reconnectIntervalMs: 5_000,
    }
  );
}

function resolveActiveSignalConfig(): RuntimeSignalConfig {
  return runtimeInitialized && activeSignalConfig
    ? activeSignalConfig
    : resolveSignalConfig();
}

async function dispatchEvent(
  event: SignalReceiveEvent,
  messageHandler: SignalMessageHandler,
): Promise<void> {
  const config = resolveActiveSignalConfig();
  const account = activeAccount || config.account;
  const daemonUrl = activeDaemonUrl || config.daemonUrl;
  if (!account || !daemonUrl) return;

  const inbound = processInboundSignalMessage({
    config,
    envelope: event.envelope,
    ownAccount: account,
    agentId: DEFAULT_AGENT_ID,
  });
  if (!inbound) return;

  const controller = new AbortController();
  inFlightControllers.add(controller);
  if (shutdownController?.signal.aborted && !controller.signal.aborted) {
    controller.abort(createSignalShutdownAbortError());
  }

  const reply: SignalReplyFn = async (content) => {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof Error ? reason : createSignalShutdownAbortError();
    }
    await sendChunkedSignalText({
      daemonUrl,
      account,
      target: inbound.channelId,
      text: content,
    });
  };

  const typingController = createSignalTypingController(async (stop) => {
    await sendSignalTyping({
      daemonUrl,
      account,
      target: inbound.channelId,
      stop,
    });
    return true;
  });
  typingController.start();

  try {
    await messageHandler(
      inbound.sessionId,
      inbound.guildId,
      inbound.channelId,
      inbound.userId,
      inbound.username,
      inbound.content,
      reply,
      {
        abortSignal: controller.signal,
        event,
        account,
      },
    );
  } finally {
    inFlightControllers.delete(controller);
    typingController.stop();
  }
}

async function runEventLoop(
  messageHandler: SignalMessageHandler,
): Promise<void> {
  let backoffMs = SIGNAL_RECONNECT_BASE_MS;

  while (!shutdownController?.signal.aborted) {
    const config = resolveActiveSignalConfig();
    const daemonUrl = activeDaemonUrl || config.daemonUrl;
    const account = activeAccount || config.account;
    if (!daemonUrl || !account) {
      logger.warn('Signal runtime missing daemonUrl or account; stopping');
      return;
    }

    const subscription = streamSignalEvents({
      daemonUrl,
      account,
      onEvent: (event) => {
        backoffMs = SIGNAL_RECONNECT_BASE_MS;
        void dispatchEvent(event, messageHandler).catch((error) => {
          logger.warn({ error }, 'Signal message handler failed');
        });
      },
      onError: (error) => {
        if (!shutdownController?.signal.aborted) {
          logger.warn({ error }, 'Signal event stream error');
        }
      },
    });
    activeSubscription = subscription;

    try {
      await subscription.done;
    } finally {
      activeSubscription = null;
    }

    if (shutdownController?.signal.aborted) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, backoffMs);
      shutdownController?.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    backoffMs = Math.min(backoffMs * 2, SIGNAL_RECONNECT_MAX_MS);
  }
}

export async function initSignal(
  messageHandler: SignalMessageHandler,
): Promise<void> {
  if (runtimeInitialized) return;

  const signalConfig = resolveSignalConfig();
  const daemonUrl = String(signalConfig.daemonUrl || '').trim();
  const account = String(signalConfig.account || '').trim();
  if (!daemonUrl) {
    throw new Error('Signal daemon URL is not configured.');
  }
  if (!account) {
    throw new Error('Signal account is not configured.');
  }

  registerChannel({
    kind: 'signal',
    id: 'signal',
    capabilities: SIGNAL_CAPABILITIES,
  });

  activeSignalConfig = signalConfig;
  activeDaemonUrl = daemonUrl;
  activeAccount = account;
  shutdownController = new AbortController();
  runtimeInitialized = true;

  void runEventLoop(messageHandler).catch((error) => {
    if (!shutdownController?.signal.aborted) {
      logger.warn({ error }, 'Signal runtime stopped unexpectedly');
    }
  });
}

export async function sendToSignalChat(
  target: string,
  text: string,
): Promise<void> {
  const config = resolveActiveSignalConfig();
  const daemonUrl = activeDaemonUrl || config.daemonUrl;
  const account = activeAccount || config.account;
  if (!daemonUrl || !account) {
    throw new Error('Signal runtime not configured.');
  }
  await sendChunkedSignalText({ daemonUrl, account, target, text });
}

export async function shutdownSignal(): Promise<void> {
  shutdownController?.abort();
  abortInFlightHandlers();
  activeSubscription?.abort();
  activeSubscription = null;
  activeAccount = null;
  activeDaemonUrl = null;
  activeSignalConfig = null;
  shutdownController = null;
  runtimeInitialized = false;
}
