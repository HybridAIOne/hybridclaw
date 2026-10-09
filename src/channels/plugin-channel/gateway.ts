/**
 * Plugin channel gateway integration — connects a catalog channel's transport
 * to the gateway turn pipeline: slash commands, agent turns, replies, and
 * artifact delivery. One implementation serves every plugin channel kind.
 *
 * A missing plugin, a disabled config section, or a credential lock held by
 * another process leaves the channel off with a log line; it never starts on
 * import and never decides queue or proactive policy.
 */
import { isSilentReply, stripSilentToken } from '../../agent/silent-reply.js';
import { getConfigSnapshot } from '../../config/config.js';
import { handleTextChannelCommand } from '../../gateway/channel-message.js';
import { normalizePlaceholderToolReply } from '../../gateway/chat-result.js';
import { handleGatewayMessage } from '../../gateway/gateway-chat-service.js';
import { formatChannelGatewayErrorReply } from '../../gateway/gateway-error-service.js';
import { withInFlightTurn } from '../../gateway/in-flight-turns.js';
import { deliverProactiveMessage } from '../../gateway/proactive-dispatch.js';
import {
  normalizeSessionShowMode,
  sessionShowModeShowsTools,
} from '../../gateway/show-mode.js';
import { resolveTextChannelSlashCommands } from '../../gateway/text-channel-commands.js';
import { logger } from '../../logger.js';
import { memoryService } from '../../memory/memory-service.js';
import { ensurePluginManagerInitialized } from '../../plugins/plugin-manager.js';
import {
  getPluginChannelCoreFacts,
  getPluginChannelName,
  type PluginChannelKind,
} from '../channel-plugin-catalog.js';
import { getChannelCapabilities } from '../channel-registry.js';
import {
  describeMissingChannelTransport,
  getChannelTransport,
} from '../channel-transport.js';
import { buildResponseText } from '../discord/delivery.js';
import { initPluginChannel, sendPluginChannelMedia } from './runtime.js';

function isCredentialLockError(
  error: unknown,
): error is Error & { lockPath: string; ownerPid?: number | null } {
  return (
    error instanceof Error &&
    typeof (error as { lockPath?: unknown }).lockPath === 'string'
  );
}

export async function startPluginChannelIntegration(
  kind: PluginChannelKind,
): Promise<boolean> {
  const name = getPluginChannelName(kind);
  if (!getPluginChannelCoreFacts(kind).isEnabled(getConfigSnapshot())) {
    logger.info(`${name} integration disabled: channel is off in config`);
    return false;
  }

  try {
    await ensurePluginManagerInitialized();
  } catch (error) {
    logger.warn(
      { error },
      `${name} integration disabled: plugin manager failed to initialize`,
    );
    return false;
  }
  const registration = getChannelTransport(kind);
  if (!registration) {
    logger.warn(
      `${name} integration disabled: ${describeMissingChannelTransport(kind)}`,
    );
    return false;
  }

  const auth = await registration.getAuthStatus();
  if (!auth.linked) {
    logger.info(
      `${name} integration starting in pairing mode: no linked account found`,
    );
  }

  try {
    await initPluginChannel(
      kind,
      withInFlightTurn(
        async (
          sessionId,
          guildId,
          channelId,
          userId,
          username,
          content,
          media,
          reply,
          context,
        ) => {
          try {
            const slashCommands = resolveTextChannelSlashCommands(content);
            if (slashCommands) {
              for (const args of slashCommands) {
                await handleTextChannelCommand({
                  sessionId,
                  guildId,
                  channelId,
                  userId,
                  username,
                  args,
                  reply,
                });
              }
              return;
            }

            const result = normalizePlaceholderToolReply(
              await handleGatewayMessage({
                sessionId,
                guildId,
                channelId,
                userId,
                username,
                content,
                media,
                onProactiveMessage: async (message) => {
                  await deliverProactiveMessage(
                    message.channelId || channelId,
                    message.text,
                    'delegate',
                    message.artifacts,
                  );
                },
                abortSignal: context.abortSignal,
                source: kind,
              }),
            );
            if (result.status === 'error') {
              await reply(
                buildResponseText(
                  formatChannelGatewayErrorReply(result.error),
                  undefined,
                  result.memoryAccess,
                ),
              );
              return;
            }
            if (isSilentReply(result.result)) return;

            const cleanedText = stripSilentToken(String(result.result || ''));
            if (cleanedText.trim() || result.memoryAccess) {
              const effectiveSessionId = result.sessionId || sessionId;
              const showMode = normalizeSessionShowMode(
                memoryService.getSessionById(effectiveSessionId)?.show_mode,
              );
              await reply(
                buildResponseText(
                  cleanedText,
                  sessionShowModeShowsTools(showMode)
                    ? result.toolsUsed
                    : undefined,
                  result.memoryAccess,
                ),
              );
            }
            const artifacts = result.artifacts || [];
            if (
              artifacts.length > 0 &&
              !getChannelCapabilities(kind).attachments
            ) {
              logger.warn(
                { channelId, artifactCount: artifacts.length },
                `${name} does not support artifact delivery`,
              );
              return;
            }
            for (const artifact of artifacts) {
              try {
                await sendPluginChannelMedia(kind, {
                  jid: channelId,
                  filePath: artifact.path,
                  mimeType: artifact.mimeType,
                  filename: artifact.filename,
                });
              } catch (error) {
                logger.warn(
                  { error, channelId, artifactPath: artifact.path },
                  `Failed to send ${name} artifact`,
                );
              }
            }
          } catch (error) {
            logger.error(
              { error, sessionId, channelId },
              `${name} message handling failed`,
            );
            await reply(formatChannelGatewayErrorReply(error));
          }
        },
      ),
    );
  } catch (error) {
    if (isCredentialLockError(error)) {
      logger.warn(
        { lockPath: error.lockPath, ownerPid: error.ownerPid ?? null },
        `${name} integration disabled: auth state is locked by another HybridClaw process`,
      );
      return false;
    }
    logger.error({ error }, `${name} integration failed to start`);
    return false;
  }

  logger.info(
    auth.linked
      ? `${name} integration started inside gateway`
      : `${name} integration started in pairing mode inside gateway`,
  );
  return true;
}
