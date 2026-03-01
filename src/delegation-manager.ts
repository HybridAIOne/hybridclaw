import { PROACTIVE_DELEGATION_ENABLED, PROACTIVE_DELEGATION_MAX_CONCURRENT } from './config.js';
import { logger } from './logger.js';

interface DelegationJob {
  id: string;
  run: () => Promise<void>;
}

const queue: DelegationJob[] = [];
let activeCount = 0;

function dequeue(): DelegationJob | undefined {
  return queue.shift();
}

function pump(): void {
  if (!PROACTIVE_DELEGATION_ENABLED) return;

  while (activeCount < PROACTIVE_DELEGATION_MAX_CONCURRENT) {
    const job = dequeue();
    if (!job) return;
    activeCount += 1;
    void job.run()
      .catch((err) => {
        logger.error({ err, jobId: job.id }, 'Delegation job failed');
      })
      .finally(() => {
        activeCount = Math.max(0, activeCount - 1);
        pump();
      });
  }
}

export function enqueueDelegation(job: DelegationJob): void {
  if (!PROACTIVE_DELEGATION_ENABLED) {
    logger.info({ jobId: job.id }, 'Delegation skipped — disabled');
    return;
  }
  queue.push(job);
  pump();
}

export function delegationQueueStatus(): { queued: number; active: number } {
  return { queued: queue.length, active: activeCount };
}
