/**
 * slack gateway integration preserves transport-specific replies and proactive delivery.
 * The descriptor selects targets and lifecycle; this module connects the runtime
 * to execution without starting it on import or owning queue policy.
 */
import { isSilentReply, stripSilentToken } from '../../agent/silent-reply.js';
import {
  getConfigSnapshot,
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
} from '../../config/config.js';
import { createApprovalPresentation } from '../../gateway/approval-presentation.js';
import {
  executeTextChannelGatewayTurn,
  handlePendingApprovalRouting,
  handleTextChannelCommand,
} from '../../gateway/channel-message.js';
import { extractGatewayChatApprovalEvent } from '../../gateway/chat-approval.js';
import {
  formatAgentErrorReply,
  formatGatewayErrorReply,
} from '../../gateway/gateway-error-service.js';
import { withInFlightTurn } from '../../gateway/in-flight-turns.js';
import { deliverProactiveMessage } from '../../gateway/proactive-dispatch.js';
import {
  normalizeSessionShowMode,
  sessionShowModeShowsTools,
} from '../../gateway/show-mode.js';
import { logger } from '../../logger.js';
import { memoryService } from '../../memory/memory-service.js';
import { slackRuntimeLoader } from '../channel-runtime-loaders.js';
import { buildResponseText } from '../discord/delivery.js';
import type { ReplyFn } from '../discord/runtime.js';

const SLACK_APPROVAL_PRESENTATION = createApprovalPresentation('buttons');

export async function startSlackIntegration(): Promise<boolean> {
  const slackConfig = getConfigSnapshot().slack;
  const hasCredentials =
    Boolean(trimValue(SLACK_BOT_TOKEN)) && Boolean(trimValue(SLACK_APP_TOKEN));

  if (!slackConfig.enabled) {
    logger.info('Slack integration disabled');
    return false;
  }
  if (!hasCredentials) {
    logger.info(
      'Slack integration disabled: SLACK_BOT_TOKEN or SLACK_APP_TOKEN runtime secret is missing',
    );
    return false;
  }

  try {
    const slack = await slackRuntimeLoader.loadForStart();
    if (!slack) return false;
    await slack.initSlack(
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
            const textReply: ReplyFn = async (message) => {
              await reply(message);
            };
            let sawTextDelta = false;
            const result = await executeTextChannelGatewayTurn({
              sessionId,
              guildId,
              channelId,
              userId,
              username,
              content,
              media,
              source: 'slack',
              reply: textReply,
              onProactiveMessage: async (message) => {
                await deliverProactiveMessage(
                  message.channelId || channelId,
                  message.text,
                  'delegate',
                  message.artifacts,
                );
              },
              onTextDelta: (delta) => {
                if (!delta || sawTextDelta) return;
                sawTextDelta = true;
                context.emitLifecyclePhase?.('streaming');
              },
              onToolProgress: (event) => {
                if (sawTextDelta) return;
                if (event.phase === 'start') {
                  context.emitLifecyclePhase?.('toolUse');
                } else {
                  context.emitLifecyclePhase?.('thinking');
                }
              },
            });
            if (!result) {
              return;
            }
            if (result.status === 'error') {
              await reply(
                buildResponseText(
                  formatAgentErrorReply(result.error),
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
            const pendingApproval = extractGatewayChatApprovalEvent(result);
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
            if (pendingApproval) {
              await handlePendingApprovalRouting({
                pendingApproval,
                responseText,
                sessionId: effectiveSessionId,
                userId,
                channelId,
                buttonPresentation: SLACK_APPROVAL_PRESENTATION,
                sendApprovalNotification: context.sendApprovalNotification,
                sendText: reply,
              });
              return;
            }
            if (responseText) {
              await reply(responseText);
            }
            for (const artifact of artifacts) {
              await slack.sendSlackFileToTarget({
                target: context.inbound.target,
                filePath: artifact.path,
                filename: artifact.filename,
              });
            }
          } catch (error) {
            logger.error(
              { error, sessionId, channelId },
              'Slack message handling failed',
            );
            await reply(formatGatewayErrorReply(error));
          }
        },
      ),
      async (sessionId, guildId, channelId, userId, username, args, reply) => {
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
            'Slack command handling failed',
          );
          await reply(formatGatewayErrorReply(error));
        }
      },
    );
  } catch (error) {
    logger.error({ error }, 'Slack integration failed to start');
    return false;
  }

  logger.info('Slack integration started inside gateway');
  return true;
}

function trimValue(value: string | null | undefined): string {
  return String(value || '').trim();
}
