import { HEARTBEAT_INTERVAL, HYBRIDAI_CHATBOT_ID } from './config.js';
import { stopAllContainers } from './container-runner.js';
import { initDatabase } from './db.js';
import { runGatewayScheduledTask } from './gateway-service.js';
import { startHealthServer } from './health.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { logger } from './logger.js';
import { startScheduler, stopScheduler } from './scheduler.js';

function setupShutdown(): void {
  const shutdown = () => {
    logger.info('Shutting down gateway...');
    stopHeartbeat();
    stopAllContainers();
    stopScheduler();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runScheduledTask(
  sessionId: string,
  channelId: string,
  prompt: string,
  taskId: number,
): Promise<void> {
  await runGatewayScheduledTask(
    sessionId,
    channelId,
    prompt,
    taskId,
    async (result) => {
      logger.info({ taskId, channelId, result }, 'Scheduled task completed');
    },
    (error) => {
      logger.error({ taskId, channelId, error }, 'Scheduled task failed');
    },
  );
}

async function main(): Promise<void> {
  logger.info('Starting HybridClaw gateway');
  initDatabase();
  startHealthServer();
  setupShutdown();

  const agentId = HYBRIDAI_CHATBOT_ID || 'default';
  startHeartbeat(agentId, HEARTBEAT_INTERVAL, (text) => {
    logger.info({ text }, 'Heartbeat message');
  });
  startScheduler(runScheduledTask);

  logger.info('HybridClaw gateway started');
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start gateway');
  process.exit(1);
});
