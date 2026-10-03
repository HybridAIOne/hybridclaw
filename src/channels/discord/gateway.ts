/**
 * discord gateway integration preserves transport-specific replies and proactive delivery.
 * The descriptor selects targets and lifecycle; this module connects the runtime
 * to execution without starting it on import or owning queue policy.
 */
import { isSilentReply, stripSilentToken } from '../../agent/silent-reply.js';
import { createSilentReplyStreamFilter } from '../../agent/silent-reply-stream.js';
import { DISCORD_TOKEN } from '../../config/config.js';
import { createApprovalPresentation } from '../../gateway/approval-presentation.js';
import {
  buildArtifactAttachments,
  handlePendingApprovalRouting,
  handleTextChannelCommand,
  simplifyImageAttachmentNarration,
} from '../../gateway/channel-message.js';
import { extractGatewayChatApprovalEvent } from '../../gateway/chat-approval.js';
import {
  normalizePendingApprovalReply,
  normalizePlaceholderToolReply,
} from '../../gateway/chat-result.js';
import { handleGatewayMessage } from '../../gateway/gateway-chat-service.js';
import {
  formatAgentErrorReply,
  formatGatewayErrorReply,
  isDiscordInvalidTokenError,
} from '../../gateway/gateway-error-service.js';
import { withInFlightTurn } from '../../gateway/in-flight-turns.js';
import { clearPendingApproval } from '../../gateway/pending-approvals.js';
import { deliverProactiveMessage } from '../../gateway/proactive-dispatch.js';
import {
  normalizeSessionShowMode,
  sessionShowModeShowsTools,
} from '../../gateway/show-mode.js';
import { logger } from '../../logger.js';
import { memoryService } from '../../memory/memory-service.js';
import { discordRuntimeLoader } from '../channel-runtime-loaders.js';
import { buildResponseText } from './delivery.js';
import { rewriteUserMentionsForMessage } from './mentions.js';
import type { ReplyFn } from './runtime.js';

const DISCORD_APPROVAL_PRESENTATION = createApprovalPresentation('buttons');

export async function startDiscordIntegration(): Promise<boolean> {
  if (!String(DISCORD_TOKEN || '').trim()) {
    logger.info('DISCORD_TOKEN not set; Discord integration disabled');
    return false;
  }

  try {
    const discord = await discordRuntimeLoader.loadForStart();
    if (!discord) return false;
    await discord.initDiscord(
      withInFlightTurn(
        async (
          sessionId: string,
          guildId: string | null,
          channelId: string,
          userId: string,
          username: string,
          content: string,
          media,
          _reply: ReplyFn,
          context,
        ) => {
          try {
            let sawTextDelta = false;
            const streamFilter = createSilentReplyStreamFilter();
            const appendStreamText = async (text: string): Promise<void> => {
              if (!text) return;
              if (!sawTextDelta) sawTextDelta = true;
              await context.stream.append(text);
            };
            const result = normalizePendingApprovalReply(
              normalizePlaceholderToolReply(
                await handleGatewayMessage({
                  sessionId,
                  guildId,
                  channelId,
                  userId,
                  username,
                  content,
                  media,
                  source: 'discord',
                  allowSilentReply: context.replyOptional,
                  onTextDelta: (delta) => {
                    const filteredDelta = streamFilter.push(delta);
                    if (!filteredDelta) return;
                    void appendStreamText(filteredDelta);
                  },
                  onToolProgress: (event) => {
                    if (sawTextDelta) return;
                    if (event.phase === 'start') {
                      context.emitLifecyclePhase('toolUse');
                    } else {
                      context.emitLifecyclePhase('thinking');
                    }
                  },
                  onProactiveMessage: async (message) => {
                    await deliverProactiveMessage(
                      message.channelId || channelId,
                      message.text,
                      'delegate',
                      message.artifacts,
                    );
                  },
                  abortSignal: context.abortSignal,
                }),
              ),
            );
            if (result.status === 'error') {
              await context.stream.fail(
                buildResponseText(
                  formatAgentErrorReply(result.error),
                  undefined,
                  result.memoryAccess,
                ),
              );
              return;
            }
            const pendingApproval = extractGatewayChatApprovalEvent(result);
            const effectiveSessionId = result.sessionId || sessionId;
            if (!pendingApproval) {
              const bufferedDelta = streamFilter.flush();
              if (bufferedDelta) {
                await appendStreamText(bufferedDelta);
              }
            }
            if (streamFilter.isSilent() || isSilentReply(result.result)) {
              await clearPendingApproval(effectiveSessionId, {
                disableButtons: true,
              });
              await context.stream.discard();
              return;
            }
            const rawText = stripSilentToken(String(result.result));
            const showMode = normalizeSessionShowMode(
              memoryService.getSessionById(effectiveSessionId)?.show_mode,
            );
            const userText = simplifyImageAttachmentNarration(
              rawText,
              result.artifacts,
            );
            const renderedText = await rewriteUserMentionsForMessage(
              userText,
              context.sourceMessage,
              context.mentionLookup,
            );
            const responseText = buildResponseText(
              renderedText,
              sessionShowModeShowsTools(showMode)
                ? result.toolsUsed
                : undefined,
              result.memoryAccess,
            );
            if (pendingApproval) {
              const { cleanup } = await handlePendingApprovalRouting({
                pendingApproval,
                responseText,
                sessionId: effectiveSessionId,
                userId,
                channelId,
                buttonPresentation: DISCORD_APPROVAL_PRESENTATION,
                sendApprovalNotification: context.sendApprovalNotification,
                sendText: (text) => context.stream.finalize(text),
                formatTextPrompt: ({ approvalUserId, storedPrompt }) =>
                  `<@${approvalUserId}> ${storedPrompt}`,
              });
              if (cleanup) {
                await context.stream.discard();
              }
              return;
            }
            const attachments = await buildArtifactAttachments(
              result.artifacts,
            );
            if (!rawText.trim()) {
              await clearPendingApproval(effectiveSessionId, {
                disableButtons: true,
              });
              await context.stream.discard();
              return;
            }
            await clearPendingApproval(effectiveSessionId, {
              disableButtons: true,
            });
            if (result.components && !sawTextDelta) {
              await _reply(responseText, attachments, result.components);
              await context.stream.discard();
              return;
            }
            await context.stream.finalize(responseText, attachments);
          } catch (error) {
            logger.error(
              { error, sessionId, channelId },
              'Discord message handling failed',
            );
            await context.stream.fail(formatGatewayErrorReply(error));
          }
        },
      ),
      async (
        sessionId: string,
        guildId: string | null,
        channelId: string,
        userId: string,
        username: string,
        args: string[],
        reply: ReplyFn,
      ) => {
        try {
          await handleTextChannelCommand({
            sessionId,
            guildId,
            channelId,
            userId,
            username,
            args,
            reply,
          });
        } catch (error) {
          logger.error(
            { error, sessionId, channelId, args },
            'Discord command handling failed',
          );
          await reply(formatGatewayErrorReply(error));
        }
      },
    );
  } catch (error) {
    if (isDiscordInvalidTokenError(error)) {
      logger.warn(
        'Discord integration disabled: DISCORD_TOKEN was rejected by Discord. Update or clear the token and restart the gateway.',
      );
      return false;
    }
    logger.error({ error }, 'Discord integration failed to start');
    return false;
  }
  logger.info('Discord integration started inside gateway');
  return true;
}
