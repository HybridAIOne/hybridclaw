/**
 * whatsapp gateway integration preserves transport-specific replies and proactive delivery.
 * The descriptor selects targets and lifecycle; this module connects the runtime
 * to execution without starting it on import or owning queue policy.
 */
import { isSilentReply, stripSilentToken } from '../../agent/silent-reply.js';
import { getConfigSnapshot } from '../../config/config.js';
import { handleTextChannelCommand } from '../../gateway/channel-message.js';
import { normalizePlaceholderToolReply } from '../../gateway/chat-result.js';
import { handleGatewayMessage } from '../../gateway/gateway-chat-service.js';
import {
  formatChannelGatewayErrorReply,
  isWhatsAppAuthLockError,
} from '../../gateway/gateway-error-service.js';
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
import { buildResponseText } from '../discord/delivery.js';
import type { ReplyFn } from '../discord/runtime.js';
import { getWhatsAppAuthStatus } from './auth.js';
import {
  initWhatsApp,
  isWhatsAppTransportInstalled,
  sendWhatsAppMediaToChat,
  WHATSAPP_PLUGIN_INSTALL_HINT,
} from './runtime.js';

export async function startWhatsAppIntegration(): Promise<boolean> {
  const whatsappConfig = getConfigSnapshot().whatsapp;
  const transportEnabled =
    whatsappConfig.dmPolicy !== 'disabled' ||
    whatsappConfig.groupPolicy !== 'disabled';
  if (!transportEnabled) {
    logger.info('WhatsApp integration disabled: transport is off');
    return false;
  }

  try {
    await ensurePluginManagerInitialized();
  } catch (error) {
    logger.warn(
      { error },
      'WhatsApp integration disabled: plugin manager failed to initialize',
    );
    return false;
  }
  if (!isWhatsAppTransportInstalled()) {
    logger.warn(
      `WhatsApp integration disabled: transport plugin is not installed. ${WHATSAPP_PLUGIN_INSTALL_HINT}`,
    );
    return false;
  }

  const whatsappAuth = await getWhatsAppAuthStatus();
  if (!whatsappAuth.linked) {
    logger.info(
      'WhatsApp integration starting in pairing mode: no linked auth state found',
    );
  }

  try {
    await initWhatsApp(
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
              const textReply: ReplyFn = async (message) => {
                await reply(message);
              };
              for (const args of slashCommands) {
                await handleTextChannelCommand({
                  sessionId,
                  guildId,
                  channelId,
                  userId,
                  username,
                  args,
                  reply: textReply,
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
                source: 'whatsapp',
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

            const cleanedResultText = stripSilentToken(
              String(result.result || ''),
            );
            const artifacts = result.artifacts || [];
            if (isSilentReply(result.result)) {
              return;
            }
            if (
              !cleanedResultText.trim() &&
              artifacts.length === 0 &&
              !result.memoryAccess
            ) {
              return;
            }

            const effectiveSessionId = result.sessionId || sessionId;
            const showMode = normalizeSessionShowMode(
              memoryService.getSessionById(effectiveSessionId)?.show_mode,
            );
            if (cleanedResultText.trim() || result.memoryAccess) {
              const responseText = buildResponseText(
                cleanedResultText,
                sessionShowModeShowsTools(showMode)
                  ? result.toolsUsed
                  : undefined,
                result.memoryAccess,
              );
              await reply(responseText);
            }
            for (const artifact of artifacts) {
              try {
                await sendWhatsAppMediaToChat({
                  jid: channelId,
                  filePath: artifact.path,
                  mimeType: artifact.mimeType,
                  filename: artifact.filename,
                });
              } catch (error) {
                logger.warn(
                  { error, channelId, artifactPath: artifact.path },
                  'Failed to send WhatsApp artifact',
                );
              }
            }
          } catch (error) {
            logger.error(
              { error, sessionId, channelId },
              'WhatsApp message handling failed',
            );
            await reply(formatChannelGatewayErrorReply(error));
          }
        },
      ),
    );
  } catch (error) {
    if (isWhatsAppAuthLockError(error)) {
      logger.warn(
        {
          lockPath: error.lockPath,
          ownerPid: error.ownerPid ?? null,
        },
        'WhatsApp integration disabled: auth state is locked by another HybridClaw process',
      );
      return false;
    }
    logger.error({ error }, 'WhatsApp integration failed to start');
    return false;
  }
  logger.info(
    whatsappAuth.linked
      ? 'WhatsApp integration started inside gateway'
      : 'WhatsApp integration started in pairing mode inside gateway',
  );
  return true;
}
