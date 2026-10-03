/**
 * signal gateway integration preserves transport-specific replies and proactive delivery.
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
import { initSignal, type SignalReplyFn } from './runtime.js';

export async function startSignalIntegration(): Promise<boolean> {
  const signalConfig = getConfigSnapshot().signal;
  const hasInboundPolicy =
    signalConfig.dmPolicy !== 'disabled' ||
    signalConfig.groupPolicy !== 'disabled';

  if (!signalConfig.enabled) {
    logger.info('Signal integration disabled: signal.enabled=false');
    return false;
  }
  if (!hasInboundPolicy) {
    logger.info('Signal integration disabled: transport is off');
    return false;
  }
  if (!signalConfig.daemonUrl) {
    logger.info('Signal integration disabled: signal.daemonUrl is not set');
    return false;
  }
  if (!signalConfig.account) {
    logger.info('Signal integration disabled: signal.account is not set');
    return false;
  }

  try {
    await initSignal(
      withInFlightTurn(
        async (
          sessionId,
          guildId,
          channelId,
          userId,
          username,
          content,
          reply: SignalReplyFn,
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
                onProactiveMessage: async (message) => {
                  await deliverProactiveMessage(
                    message.channelId || channelId,
                    message.text,
                    'delegate',
                    message.artifacts,
                  );
                },
                abortSignal: context.abortSignal,
                source: 'signal',
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
            if (artifacts.length > 0) {
              logger.warn(
                { channelId, artifactCount: artifacts.length },
                'Signal channel does not yet support outbound artifacts; dropping',
              );
            }
          } catch (error) {
            logger.error(
              { error, sessionId, channelId },
              'Signal message handling failed',
            );
            await reply(formatChannelGatewayErrorReply(error));
          }
        },
      ),
    );
  } catch (error) {
    logger.warn({ error }, 'Signal integration failed to start');
    return false;
  }

  logger.info('Signal integration started inside gateway');
  return true;
}
