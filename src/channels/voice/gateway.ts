/**
 * Voice gateway handlers preserve transport-specific replies and approvals.
 * The descriptor owns lifecycle selection; this module only connects the
 * channel runtime to gateway execution and does not classify targets.
 */
import { isSilentReply, stripSilentToken } from '../../agent/silent-reply.js';
import { createSilentReplyStreamFilter } from '../../agent/silent-reply-stream.js';
import { getConfigSnapshot, TWILIO_AUTH_TOKEN } from '../../config/config.js';
import {
  getRuntimeConfig,
  resolveDefaultAgentId,
} from '../../config/runtime-config.js';
import { executeTextChannelGatewayTurn } from '../../gateway/channel-message.js';
import { normalizePendingApprovalReply } from '../../gateway/chat-result.js';
import {
  formatChannelGatewayErrorReply,
  isVoiceGatewayAbort,
} from '../../gateway/gateway-error-service.js';
import { withInFlightTurn } from '../../gateway/in-flight-turns.js';
import { persistVoiceTranscript } from '../../gateway/voice-transcript-store.js';
import { logger } from '../../logger.js';
import type { ReplyFn } from '../discord/runtime.js';
import { findNationalFormatAllowEntries } from './caller-policy.js';
import { resolveRealtimeConnection } from './realtime-credentials.js';
import { initVoice } from './runtime.js';
import { createVoiceTextStreamFormatter } from './text.js';
export async function startVoiceIntegration(): Promise<boolean> {
  const voiceConfig = getConfigSnapshot().voice;
  const twilioAuthToken = String(TWILIO_AUTH_TOKEN || '').trim();
  if (!voiceConfig.enabled) {
    logger.info('Voice integration disabled in config');
    return false;
  }
  if (
    !voiceConfig.twilio.accountSid.trim() ||
    !twilioAuthToken ||
    !voiceConfig.twilio.fromNumber.trim()
  ) {
    logger.warn(
      {
        accountSidConfigured: Boolean(voiceConfig.twilio.accountSid.trim()),
        authTokenConfigured: Boolean(twilioAuthToken),
        fromNumberConfigured: Boolean(voiceConfig.twilio.fromNumber.trim()),
      },
      'Voice integration disabled: Twilio credentials are incomplete',
    );
    return false;
  }
  if (voiceConfig.mode === 'realtime') {
    const realtimeProvider = getConfigSnapshot().speech.realtime.provider;
    const resolved = resolveRealtimeConnection(realtimeProvider);
    if (!resolved.connection) {
      logger.warn(
        { provider: realtimeProvider },
        `Voice integration disabled: ${resolved.error}`,
      );
      return false;
    }
  }

  try {
    await initVoice(
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
            const streamFilter = createSilentReplyStreamFilter();
            const voiceTextStream = createVoiceTextStreamFormatter();
            const result = await executeTextChannelGatewayTurn({
              sessionId,
              guildId,
              channelId,
              userId,
              username,
              content,
              media,
              source: 'voice',
              reply: textReply,
              abortSignal: context.abortSignal,
              onToolProgress: context.onToolProgress
                ? (event) => context.onToolProgress?.(event)
                : undefined,
              onTextDelta: (delta) => {
                const filteredDelta = streamFilter.push(delta);
                if (!filteredDelta) return;
                for (const voiceDelta of voiceTextStream.push(filteredDelta)) {
                  sawTextDelta = true;
                  void context.responseStream
                    .push(voiceDelta)
                    .catch((error) => {
                      if (isVoiceGatewayAbort(error, context.abortSignal)) {
                        return;
                      }
                      logger.debug(
                        { error, callSid: context.callSid, channelId },
                        'Voice text delta streaming failed',
                      );
                    });
                }
              },
              onProactiveMessage: async (message) => {
                logger.debug(
                  {
                    callSid: context.callSid,
                    artifactCount: message.artifacts?.length || 0,
                  },
                  'Skipping proactive voice follow-up',
                );
              },
              resultTransform: (result) =>
                normalizePendingApprovalReply(result),
            });
            if (!result) {
              return;
            }
            if (result.status === 'error') {
              await reply(formatChannelGatewayErrorReply(result.error));
              return;
            }

            const trailingDelta = streamFilter.flush();
            if (trailingDelta) {
              for (const voiceDelta of voiceTextStream.push(trailingDelta)) {
                sawTextDelta = true;
                await context.responseStream.push(voiceDelta).catch((error) => {
                  if (isVoiceGatewayAbort(error, context.abortSignal)) {
                    return;
                  }
                  throw error;
                });
              }
            }

            for (const voiceDelta of voiceTextStream.flush()) {
              sawTextDelta = true;
              await context.responseStream.push(voiceDelta).catch((error) => {
                if (isVoiceGatewayAbort(error, context.abortSignal)) {
                  return;
                }
                throw error;
              });
            }

            if (isSilentReply(result.result)) {
              return;
            }

            const cleanedResultText = stripSilentToken(
              String(result.result || ''),
            );
            if (!sawTextDelta && cleanedResultText.trim()) {
              await reply(cleanedResultText);
            }
          } catch (error) {
            if (isVoiceGatewayAbort(error, context.abortSignal)) {
              logger.debug(
                { sessionId, channelId, callSid: context.callSid },
                'Voice message handling aborted after relay disconnect',
              );
              return;
            }
            logger.error(
              { error, sessionId, channelId, callSid: context.callSid },
              'Voice message handling failed',
            );
            try {
              await reply(
                formatChannelGatewayErrorReply('Response interrupted.'),
              );
            } catch (replyError) {
              if (!isVoiceGatewayAbort(replyError, context.abortSignal)) {
                throw replyError;
              }
            }
          }
        },
      ),
      {
        transcriptPersister: (params) => {
          persistVoiceTranscript({
            ...params,
            agentId: resolveDefaultAgentId(getRuntimeConfig()),
          });
        },
      },
    );
    if (voiceConfig.callerPolicy === 'allowlist') {
      const nationalFormat = findNationalFormatAllowEntries(
        voiceConfig.allowFrom,
      );
      if (nationalFormat.length > 0) {
        logger.warn(
          { entries: nationalFormat },
          'Voice allowlist entries are missing a country code and will never match; use E.164 (+4915123456789, not 015123456789)',
        );
      }
    }
    logger.info(
      {
        provider: voiceConfig.provider,
        mode: voiceConfig.mode,
        callerPolicy: voiceConfig.callerPolicy,
        webhookPath: voiceConfig.webhookPath,
        maxConcurrentCalls: voiceConfig.maxConcurrentCalls,
      },
      'Voice integration started inside gateway',
    );
    return true;
  } catch (error) {
    logger.warn({ error }, 'Voice integration failed to start');
    return false;
  }
}
