import http from 'http';

import { HEALTH_PORT } from './config.js';
import { getActiveContainerCount } from './container-runner.js';
import { getSessionCount } from './db.js';
import { logger } from './logger.js';

const startTime = Date.now();

export function startHealthServer(): void {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const status = {
        status: 'ok',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        sessions: getSessionCount(),
        activeContainers: getActiveContainerCount(),
        timestamp: new Date().toISOString(),
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(HEALTH_PORT, () => {
    logger.info({ port: HEALTH_PORT }, 'Health endpoint started');
  });
}

export function getUptime(): number {
  return Math.floor((Date.now() - startTime) / 1000);
}
