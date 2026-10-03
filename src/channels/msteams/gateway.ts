/**
 * MSTeams gateway handlers preserve transport-specific replies and approvals.
 * The descriptor owns lifecycle selection; this module only connects the
 * channel runtime to gateway execution and does not classify targets.
 */
import type { Attachment } from 'botframework-schema';
import { isSilentReply, stripSilentToken } from '../../agent/silent-reply.js';
import { createSilentReplyStreamFilter } from '../../agent/silent-reply-stream.js';
import {
  getConfigSnapshot,
  MSTEAMS_APP_ID,
  MSTEAMS_APP_PASSWORD,
} from '../../config/config.js';
import {
  createApprovalPresentation,
  getApprovalVisibleText,
} from '../../gateway/approval-presentation.js';
import {
  handlePendingApprovalRouting,
  handleTextChannelCommand,
  resolveImplicitNumericApprovalArgs,
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
} from '../../gateway/gateway-error-service.js';
import { withInFlightTurn } from '../../gateway/in-flight-turns.js';
import {
  normalizeSessionShowMode,
  sessionShowModeShowsTools,
} from '../../gateway/show-mode.js';
import { logger } from '../../logger.js';
import { getLatestAssistantMessageId } from '../../memory/db.js';
import { memoryService } from '../../memory/memory-service.js';
import {
  msteamsAttachmentsLoader,
  msteamsRuntimeLoader,
} from '../channel-runtime-loaders.js';
import type { ReplyFn } from '../discord/runtime.js';
import {
  buildResponseText as buildMSTeamsResponseText,
  buildMSTeamsSessionSwitcherCard,
  stripUnusableMSTeamsArtifactLinks,
} from './delivery.js';
import {
  mapMSTeamsReactionToRating,
  recordMSTeamsRatingTargets,
  resolveMSTeamsRatingTarget,
} from './reactions.js';

const TEAMS_APPROVAL_PRESENTATION = createApprovalPresentation('text');

function formatMSTeamsActivityVerb(toolName: string): string {
  const action = toolName.trim().toLowerCase().split('__').at(-1) || '';
  if (/search|query|find|lookup/.test(action)) return 'Searching…';
  if (/read|open|fetch|get|list|browse/.test(action)) return 'Reading…';
  if (/create|generate|render|image/.test(action)) return 'Creating…';
  if (/write|edit|update|apply|patch/.test(action)) return 'Updating…';
  if (/exec|run|test|build|bash|shell|command/.test(action)) {
    return 'Running…';
  }
  if (/send|post|message|email|notify/.test(action)) return 'Sending…';
  return 'Working…';
}

export async function startMSTeamsIntegration(): Promise<boolean> {
  const teamsConfig = getConfigSnapshot().msteams;
  const hasCredentials =
    Boolean(String(MSTEAMS_APP_ID || '').trim()) &&
    Boolean(String(MSTEAMS_APP_PASSWORD || '').trim());

  if (!teamsConfig.enabled) {
    logger.info('Microsoft Teams integration disabled');
    return false;
  }
  if (teamsConfig.webhook.port !== getConfigSnapshot().ops.healthPort) {
    logger.info(
      {
        configuredWebhookPort: teamsConfig.webhook.port,
        gatewayPort: getConfigSnapshot().ops.healthPort,
        webhookPath: teamsConfig.webhook.path,
      },
      'Microsoft Teams webhook uses the shared gateway HTTP port; configured webhook.port is informational only',
    );
  }

  const recordMSTeamsReactionTargetsForStream = (
    sessionId: string,
    stream: { getDeliveredActivityIds(): string[] },
  ): void => {
    try {
      const messageId = getLatestAssistantMessageId(sessionId);
      if (!messageId) return;
      recordMSTeamsRatingTargets({
        sessionId,
        activityIds: stream.getDeliveredActivityIds(),
        messageId,
      });
    } catch (error) {
      logger.debug(
        { error, sessionId },
        'Failed to record Teams reaction rating targets',
      );
    }
  };

  const { initMSTeams } = await msteamsRuntimeLoader.load();
  initMSTeams(
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
          const implicitApprovalArgs = resolveImplicitNumericApprovalArgs({
            sessionId,
            userId,
            content,
          });
          if (implicitApprovalArgs) {
            const bridgedReply: ReplyFn = async (content) => {
              await reply(content);
            };
            await handleTextChannelCommand({
              msteamsTenantId: context.tenantId,
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
                source: 'msteams',
                agentId: context.agentId,
                msteamsTenantId: context.tenantId,
                onTextDelta: (delta) => {
                  const filteredDelta = streamFilter.push(delta);
                  if (!filteredDelta) return;
                  void appendStreamText(filteredDelta);
                },
                onToolProgress: (event) => {
                  if (sawTextDelta) return;
                  void context.stream.updateInformative(
                    event.phase === 'start'
                      ? formatMSTeamsActivityVerb(event.toolName)
                      : 'Thinking…',
                  );
                },
                abortSignal: context.abortSignal,
              }),
            ),
          );
          const memoryFooterOptions = {
            showMemoryFooter: getConfigSnapshot().msteams.showMemoryFooter,
          };
          const memoryAccess = memoryFooterOptions.showMemoryFooter
            ? result.memoryAccess
            : undefined;
          if (result.status === 'error') {
            await context.stream.fail(
              buildMSTeamsResponseText(
                formatAgentErrorReply(result.error),
                undefined,
                memoryAccess,
                memoryFooterOptions,
              ),
            );
            return;
          }

          const bufferedDelta = streamFilter.flush();
          if (bufferedDelta) {
            await appendStreamText(bufferedDelta);
          }
          if (streamFilter.isSilent() || isSilentReply(result.result)) {
            await context.stream.discard();
            return;
          }

          const renderedText = stripSilentToken(String(result.result || ''));
          const artifacts = result.artifacts || [];
          const effectiveSessionId = result.sessionId || sessionId;
          if (!renderedText.trim() && artifacts.length === 0 && !memoryAccess) {
            await context.stream.discard();
            return;
          }
          const showMode = normalizeSessionShowMode(
            memoryService.getSessionById(effectiveSessionId)?.show_mode,
          );
          let responseText =
            renderedText.trim() || memoryAccess
              ? buildMSTeamsResponseText(
                  stripUnusableMSTeamsArtifactLinks(renderedText),
                  sessionShowModeShowsTools(showMode)
                    ? result.toolsUsed
                    : undefined,
                  memoryAccess,
                  memoryFooterOptions,
                )
              : '';
          const pendingApproval = extractGatewayChatApprovalEvent(result);
          if (pendingApproval) {
            await handlePendingApprovalRouting({
              pendingApproval,
              responseText,
              sessionId: effectiveSessionId,
              userId,
              channelId,
              buttonPresentation: TEAMS_APPROVAL_PRESENTATION,
              sendText: (text) => context.stream.finalize(text),
              formatTextPrompt: ({ approval, responseText }) => {
                const visiblePrompt = getApprovalVisibleText(
                  approval,
                  TEAMS_APPROVAL_PRESENTATION,
                  responseText,
                );
                return `${visiblePrompt}\n\nApproval required. Reply \`1\` to allow once, \`2\` to allow for this session, \`3\` to allow for this agent, \`4\` to allow for all, or \`5\` to deny. You can also use \`/approve view\` or \`/approve [1|2|3|4|5]\`.`;
              },
            });
            return;
          }

          let attachments: Attachment[] | undefined;
          try {
            const { buildTeamsArtifactAttachments } =
              await msteamsAttachmentsLoader.load();
            attachments = await buildTeamsArtifactAttachments({
              turnContext: context.turnContext,
              artifacts,
            });
          } catch (error) {
            logger.warn(
              {
                error,
                sessionId,
                channelId,
                artifactCount: artifacts.length,
              },
              'Failed to build Teams artifact attachments',
            );
            const deliveryNotice =
              'The artifact was created, but Teams could not deliver the file. Try the bot’s direct chat; if this already is a direct chat, enable file support (`supportsFiles`) in the Teams app manifest.';
            responseText = responseText
              ? `${responseText}\n\n${deliveryNotice}`
              : deliveryNotice;
          }

          if (attachments?.length && sawTextDelta) {
            await context.stream.finalize(responseText);
            await reply('', attachments);
            recordMSTeamsReactionTargetsForStream(
              effectiveSessionId,
              context.stream,
            );
            return;
          }
          await context.stream.finalize(responseText, attachments);
          recordMSTeamsReactionTargetsForStream(
            effectiveSessionId,
            context.stream,
          );
        } catch (error) {
          logger.error(
            { error, sessionId, channelId },
            'Teams message handling failed',
          );
          await context.stream.fail(formatGatewayErrorReply(error));
        }
      },
    ),
    async (
      sessionId,
      guildId,
      channelId,
      userId,
      username,
      args,
      reply,
      context,
    ) => {
      try {
        memoryService.getOrCreateSession(
          sessionId,
          guildId,
          channelId,
          context.agentId,
        );
        const bridgedReply: ReplyFn = async (content) => {
          await reply(content);
        };
        await handleTextChannelCommand({
          msteamsTenantId: context.tenantId,
          sessionId,
          guildId,
          channelId,
          userId,
          username,
          args,
          reply: bridgedReply,
          onCommandResult: async (result, renderedText) => {
            if (!result.sessionSwitcher?.length) return false;
            await reply(renderedText, [
              buildMSTeamsSessionSwitcherCard(result.sessionSwitcher),
            ]);
            return true;
          },
        });
      } catch (error) {
        logger.error(
          { error, sessionId, channelId, args },
          'Teams command handling failed',
        );
        await reply(formatGatewayErrorReply(error));
      }
    },
    async (event) => {
      const addedRatings = event.added
        .map(mapMSTeamsReactionToRating)
        .filter((rating): rating is NonNullable<typeof rating> =>
          Boolean(rating),
        );
      const removedRatings = event.removed
        .map(mapMSTeamsReactionToRating)
        .filter((rating): rating is NonNullable<typeof rating> =>
          Boolean(rating),
        );
      const unmapped = [...event.added, ...event.removed].filter(
        (type) => !mapMSTeamsReactionToRating(type),
      );
      if (unmapped.length > 0) {
        logger.debug(
          { sessionId: event.sessionId, reactionTypes: unmapped },
          'Ignored Teams reaction types without a rating mapping',
        );
      }
      if (addedRatings.length === 0 && removedRatings.length === 0) return;

      const messageId = resolveMSTeamsRatingTarget(
        event.sessionId,
        event.activityId,
      );
      if (!messageId) {
        logger.debug(
          { sessionId: event.sessionId, activityId: event.activityId },
          'Teams reaction targets an activity without a known rating target',
        );
        return;
      }
      const { applyReactionRatingChanges, ResponseRatingNotFoundError } =
        await import('../../gateway/response-ratings.js');
      try {
        const result = applyReactionRatingChanges({
          sessionId: event.sessionId,
          messageId,
          operatorUserId: event.userId,
          addedRatings,
          removedRatings,
          sourceSurface: 'msteams',
        });
        if (result) {
          logger.info(
            {
              sessionId: event.sessionId,
              messageId,
              rating: result.rating,
              userId: event.userId,
            },
            'Recorded Teams reaction as response rating',
          );
        }
      } catch (error) {
        if (error instanceof ResponseRatingNotFoundError) {
          logger.debug(
            { sessionId: event.sessionId, messageId },
            'Teams reaction rating target no longer exists',
          );
          return;
        }
        logger.warn(
          { error, sessionId: event.sessionId, messageId },
          'Failed to record Teams reaction as response rating',
        );
      }
    },
  );
  if (!hasCredentials) {
    logger.info(
      'Microsoft Teams integration disabled: msteams.appId config or MSTEAMS_APP_PASSWORD runtime secret is missing',
    );
    return false;
  }
  logger.info(
    {
      webhookPath: teamsConfig.webhook.path,
      autoStartedFromEnv: false,
    },
    'Microsoft Teams integration started inside gateway',
  );
  return true;
}
