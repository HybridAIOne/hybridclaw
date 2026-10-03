/**
 * imessage gateway integration preserves transport-specific replies and proactive delivery.
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
  formatGatewayErrorReply,
  isDefaultChannelInterruptedReply,
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
import { buildResponseText } from '../discord/delivery.js';
import type { ReplyFn } from '../discord/runtime.js';
import { normalizeIMessageHandle } from './handle.js';
import { initIMessage, sendIMessageMediaToChat } from './runtime.js';

function isLocalIMessageSelfChatContext(context: {
  inbound?: {
    backend?: string;
    isGroup?: boolean;
    handle?: string | null;
    rawEvent?: unknown;
  };
}): boolean {
  const inbound = context.inbound;
  if (inbound?.backend !== 'local' || inbound.isGroup) {
    return false;
  }
  const rawEvent =
    inbound.rawEvent && typeof inbound.rawEvent === 'object'
      ? (inbound.rawEvent as {
          handle?: string | null;
          chatIdentifier?: string | null;
        })
      : null;
  const sender = normalizeIMessageHandle(
    String(rawEvent?.handle || inbound.handle || ''),
  );
  const chatIdentifier = normalizeIMessageHandle(
    String(rawEvent?.chatIdentifier || ''),
  );
  return Boolean(sender && chatIdentifier && sender === chatIdentifier);
}

export async function startIMessageIntegration(): Promise<boolean> {
  const imessageConfig = getConfigSnapshot().imessage;
  if (!imessageConfig.enabled) {
    logger.info('iMessage integration disabled in config');
    return false;
  }
  if (
    imessageConfig.backend === 'bluebubbles' &&
    !imessageConfig.serverUrl.trim()
  ) {
    logger.warn(
      'iMessage integration not started: imessage.serverUrl is required for the BlueBubbles backend. Configure it with `hybridclaw channels imessage setup --backend remote --server-url <url>` or disable iMessage with `hybridclaw config set imessage.enabled false`.',
    );
    return false;
  }

  try {
    await initIMessage(
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
                source: 'imessage',
              }),
            );
            if (result.status === 'error') {
              const failureText = formatChannelGatewayErrorReply(result.error);
              if (
                isDefaultChannelInterruptedReply(failureText) &&
                isLocalIMessageSelfChatContext(context)
              ) {
                return;
              }
              await reply(
                buildResponseText(failureText, undefined, result.memoryAccess),
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
            const responseText =
              cleanedResultText.trim() || result.memoryAccess
                ? buildResponseText(
                    cleanedResultText,
                    sessionShowModeShowsTools(showMode)
                      ? result.toolsUsed
                      : undefined,
                    result.memoryAccess,
                  )
                : '';

            if (artifacts.length > 0) {
              await sendIMessageMediaToChat({
                target: channelId,
                filePath: artifacts[0].path,
                mimeType: artifacts[0].mimeType,
                filename: artifacts[0].filename,
                caption: responseText || undefined,
              });
              for (let index = 1; index < artifacts.length; index += 1) {
                await sendIMessageMediaToChat({
                  target: channelId,
                  filePath: artifacts[index].path,
                  mimeType: artifacts[index].mimeType,
                  filename: artifacts[index].filename,
                });
              }
              return;
            }

            await reply(responseText);
          } catch (error) {
            logger.error(
              { error, sessionId, channelId },
              'iMessage message handling failed',
            );
            await reply(formatGatewayErrorReply(error));
          }
        },
      ),
    );
  } catch (error) {
    logger.warn({ error }, 'iMessage integration failed to start');
    return false;
  }
  logger.info(
    {
      backend: imessageConfig.backend,
      webhookPath: imessageConfig.webhookPath,
    },
    'iMessage integration started inside gateway',
  );
  return true;
}
