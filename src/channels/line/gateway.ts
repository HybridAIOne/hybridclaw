/**
 * line gateway integration preserves transport-specific replies and proactive delivery.
 * The descriptor selects targets and lifecycle; this module connects the runtime
 * to execution without starting it on import or owning queue policy.
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
import { buildResponseText } from '../discord/delivery.js';
import { getLineAuthStatus, LineAuthLockError } from './auth.js';
import {
  initLine,
  isLineTransportInstalled,
  LINE_PLUGIN_INSTALL_HINT,
} from './runtime.js';

export async function startLineIntegration(): Promise<boolean> {
  const lineConfig = getConfigSnapshot().line;
  if (!lineConfig.enabled) {
    logger.info('LINE integration disabled: line.enabled=false');
    return false;
  }

  try {
    await ensurePluginManagerInitialized();
  } catch (error) {
    logger.warn(
      { error },
      'LINE integration disabled: plugin manager failed to initialize',
    );
    return false;
  }
  if (!isLineTransportInstalled()) {
    logger.warn(
      `LINE integration disabled: transport plugin is not installed. ${LINE_PLUGIN_INSTALL_HINT}`,
    );
    return false;
  }

  const auth = await getLineAuthStatus();
  if (!auth.linked) {
    logger.warn(
      'LINE integration is awaiting unofficial personal-account QR login; using it may cause LINE account restrictions.',
    );
  }

  try {
    await initLine(
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
                source: 'line',
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
            if ((result.artifacts || []).length > 0) {
              logger.warn(
                { channelId, artifactCount: result.artifacts?.length || 0 },
                'LINE self-chat does not support artifact delivery',
              );
            }
          } catch (error) {
            logger.error(
              { error, sessionId, channelId },
              'LINE message handling failed',
            );
            await reply(formatChannelGatewayErrorReply(error));
          }
        },
      ),
    );
  } catch (error) {
    if (error instanceof LineAuthLockError) {
      logger.warn(
        { lockPath: error.lockPath, ownerPid: error.ownerPid },
        'LINE integration disabled: auth state is locked by another HybridClaw process',
      );
      return false;
    }
    logger.error({ error }, 'LINE integration failed to start');
    return false;
  }

  logger.info(
    auth.linked
      ? 'LINE self-chat integration started inside gateway'
      : 'LINE self-chat integration started in pairing mode inside gateway',
  );
  return true;
}
