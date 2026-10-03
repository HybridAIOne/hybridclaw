/**
 * telegram gateway integration preserves transport-specific replies and proactive delivery.
 * The descriptor selects targets and lifecycle; this module connects the runtime
 * to execution without starting it on import or owning queue policy.
 */
import { isSilentReply, stripSilentToken } from '../../agent/silent-reply.js';
import { getConfigSnapshot } from '../../config/config.js';
import {
  handleTextChannelCommand,
  resolveImplicitNumericApprovalArgs,
} from '../../gateway/channel-message.js';
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
import { buildResponseText } from '../discord/delivery.js';
import type { ReplyFn } from '../discord/runtime.js';
import {
  hasTelegramBotToken,
  initTelegram,
  sendTelegramMediaToChat,
  type TelegramReplyFn,
} from './runtime.js';

export async function startTelegramIntegration(): Promise<boolean> {
  const telegramConfig = getConfigSnapshot().telegram;
  const hasInboundPolicy =
    telegramConfig.dmPolicy !== 'disabled' ||
    telegramConfig.groupPolicy !== 'disabled';
  const hasBotToken = hasTelegramBotToken();

  if (!telegramConfig.enabled) {
    logger.info('Telegram integration disabled: telegram.enabled=false');
    return false;
  }
  if (!hasInboundPolicy) {
    logger.info('Telegram integration disabled: transport is off');
    return false;
  }
  if (!hasBotToken) {
    logger.info(
      'Telegram integration disabled: TELEGRAM_BOT_TOKEN is not configured',
    );
    return false;
  }

  try {
    await initTelegram(
      withInFlightTurn(
        async (
          sessionId,
          guildId,
          channelId,
          userId,
          username,
          content,
          media,
          reply: TelegramReplyFn,
          context,
        ) => {
          try {
            const implicitApprovalArgs = resolveImplicitNumericApprovalArgs({
              sessionId,
              userId,
              content,
            });
            if (implicitApprovalArgs) {
              const bridgedReply: ReplyFn = async (message) => {
                await reply(message);
              };
              await handleTextChannelCommand({
                sessionId,
                guildId,
                channelId,
                userId,
                username,
                args: implicitApprovalArgs,
                reply: bridgedReply,
              });
              return;
            }

            const slashCommands = resolveTextChannelSlashCommands(content);
            if (slashCommands) {
              const bridgedReply: ReplyFn = async (message) => {
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
                  reply: bridgedReply,
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
                source: 'telegram',
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
                await sendTelegramMediaToChat({
                  target: channelId,
                  filePath: artifact.path,
                  mimeType: artifact.mimeType,
                  filename: artifact.filename,
                });
              } catch (error) {
                logger.warn(
                  { error, channelId, artifactPath: artifact.path },
                  'Failed to send Telegram artifact',
                );
              }
            }
          } catch (error) {
            logger.error(
              { error, sessionId, channelId },
              'Telegram message handling failed',
            );
            await reply(formatChannelGatewayErrorReply(error));
          }
        },
      ),
    );
  } catch (error) {
    logger.warn({ error }, 'Telegram integration failed to start');
    return false;
  }

  logger.info('Telegram integration started inside gateway');
  return true;
}
