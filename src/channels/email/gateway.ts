/**
 * email gateway integration preserves transport-specific replies and proactive delivery.
 * The descriptor selects targets and lifecycle; this module connects the runtime
 * to execution without starting it on import or owning queue policy.
 */
import { isSilentReply, stripSilentToken } from '../../agent/silent-reply.js';
import { EMAIL_PASSWORD, getConfigSnapshot } from '../../config/config.js';
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
import { emailRuntimeLoader } from '../channel-runtime-loaders.js';
import { buildResponseText } from '../discord/delivery.js';
import type { ReplyFn } from '../discord/runtime.js';
import { buildEmailDeliveryMetadata } from './metadata.js';

export async function startEmailIntegration(): Promise<boolean> {
  const emailConfig = getConfigSnapshot().email;
  if (!emailConfig.enabled) {
    logger.info('Email integration disabled: email.enabled=false');
    return false;
  }
  const emailAccounts = Array.isArray(emailConfig.accounts)
    ? emailConfig.accounts
    : [];
  const hasAccountList = emailAccounts.length > 0;
  if (
    hasAccountList &&
    emailAccounts.some((account) => !account.address.trim())
  ) {
    logger.info(
      'Email integration disabled: one or more email account addresses are not configured',
    );
    return false;
  }
  const hasConfiguredAccount = hasAccountList
    ? true
    : Boolean(emailConfig.address.trim());
  if (!hasConfiguredAccount) {
    logger.info('Email integration disabled: no email account configured');
    return false;
  }
  if (
    !hasAccountList &&
    (!emailConfig.imapHost.trim() || !emailConfig.smtpHost.trim())
  ) {
    logger.info(
      'Email integration disabled: IMAP/SMTP host configuration incomplete',
    );
    return false;
  }
  if (!hasAccountList && !String(EMAIL_PASSWORD || '').trim()) {
    logger.info('Email integration disabled: EMAIL_PASSWORD not configured');
    return false;
  }

  try {
    const email = await emailRuntimeLoader.loadForStart();
    if (!email) return false;
    await email.initEmail(
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
                agentId: context.agentId,
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
                source: 'email',
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
            const emailMetadata = buildEmailDeliveryMetadata({
              agentId: result.agentId,
              model: result.model,
              provider: result.provider,
              tokenUsage: result.tokenUsage,
            });
            if (cleanedResultText.trim() || result.memoryAccess) {
              const responseText = buildResponseText(
                cleanedResultText,
                sessionShowModeShowsTools(showMode)
                  ? result.toolsUsed
                  : undefined,
                result.memoryAccess,
              );
              await reply(responseText, {
                ...(emailMetadata ? { metadata: emailMetadata } : {}),
              });
            }
            for (const artifact of artifacts) {
              try {
                await context.sendAttachment({
                  filePath: artifact.path,
                  mimeType: artifact.mimeType,
                  filename: artifact.filename,
                  ...(emailMetadata ? { metadata: emailMetadata } : {}),
                });
              } catch (error) {
                logger.warn(
                  { error, channelId, artifactPath: artifact.path },
                  'Failed to send email artifact',
                );
              }
            }
          } catch (error) {
            logger.error(
              { error, sessionId, channelId },
              'Email message handling failed',
            );
            await reply(formatChannelGatewayErrorReply(error));
          }
        },
      ),
    );
  } catch (error) {
    logger.warn({ error }, 'Email integration failed to start');
    return false;
  }

  logger.info('Email integration started inside gateway');
  return true;
}
