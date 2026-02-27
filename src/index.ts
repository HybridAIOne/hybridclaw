import {
  buildResponseText,
  formatError,
  formatInfo,
  initDiscord,
  type ReplyFn,
} from './discord.js';
import { gatewayChat, gatewayCommand, gatewayStatus, renderGatewayCommand } from './gateway-client.js';
import { logger } from './logger.js';

async function handleMessage(
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  reply: ReplyFn,
): Promise<void> {
  try {
    const result = await gatewayChat({
      sessionId,
      guildId,
      channelId,
      userId,
      username,
      content,
    });

    if (result.status === 'error') {
      await reply(formatError('Agent Error', result.error || 'Unknown error'));
      return;
    }
    await reply(buildResponseText(result.result || 'No response from agent.', result.toolsUsed));
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId, channelId }, 'Gateway message request failed');
    await reply(formatError('Gateway Error', text));
  }
}

async function handleCommand(
  sessionId: string,
  guildId: string | null,
  channelId: string,
  args: string[],
  reply: ReplyFn,
): Promise<void> {
  try {
    const result = await gatewayCommand({
      sessionId,
      guildId,
      channelId,
      args,
    });

    if (result.kind === 'error') {
      await reply(formatError(result.title || 'Error', result.text));
      return;
    }
    if (result.kind === 'info') {
      await reply(formatInfo(result.title || 'Info', result.text));
      return;
    }
    await reply(renderGatewayCommand(result));
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId, channelId, args }, 'Gateway command request failed');
    await reply(formatError('Gateway Error', text));
  }
}

async function main(): Promise<void> {
  logger.info('Starting HybridClaw Discord adapter');
  await gatewayStatus();
  initDiscord(handleMessage, handleCommand);
  logger.info('HybridClaw Discord adapter started');
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start Discord adapter');
  process.exit(1);
});
