import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

const makeTempHome = useTempDir('hybridclaw-cron-e2e-');

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

useCleanMocks({
  restoreAllMocks: true,
  cleanup: () => {
    vi.useRealTimers();
    restoreEnvVar('HOME', ORIGINAL_HOME);
    restoreEnvVar(
      'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
      ORIGINAL_DISABLE_CONFIG_WATCHER,
    );
  },
  resetModules: true,
});

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

test('cron tool call persists a job the scheduler later dispatches to the delivery channel', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getOrCreateSession } = await import('../src/memory/sessions.ts');
  const { getAllJobs } = await import('../src/memory/jobs.ts');
  const { startScheduler, stopScheduler } = await import(
    '../src/scheduler/scheduler.ts'
  );
  const { runScheduledTaskToolAction } = await import(
    '../src/gateway/scheduled-task-tool-service.ts'
  );
  const tools = await import('../container/src/tools.ts');

  initDatabase({ quiet: true });
  getOrCreateSession('session-e2e', null, 'discord-channel-1');

  const token = 'gateway-token';
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.url !== '/api/scheduler/task' || req.method !== 'POST') {
        res.writeHead(404).end(JSON.stringify({ error: 'Not Found' }));
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      try {
        const result = runScheduledTaskToolAction(await readBody(req));
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(result));
      } catch (error) {
        const statusCode =
          (error as { statusCode?: number }).statusCode ?? 500;
        res
          .writeHead(statusCode, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: (error as Error).message }));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const runner = vi.fn(async () => {});
    startScheduler(runner);

    tools.setSessionContext('session-e2e');
    tools.setGatewayContext(
      `http://127.0.0.1:${port}`,
      token,
      'discord-channel-1',
    );

    const result = await tools.executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        at_seconds: 60,
        channel: 'ops@example.com',
        prompt: 'Write the operational update.',
      }),
    );

    const tasks = getAllJobs({ kind: 'scheduled_task', sessionId: 'session-e2e' });
    expect(tasks).toHaveLength(1);
    expect(result).toContain(`Scheduled one-shot task #${tasks[0].id}`);
    expect(tasks[0]).toMatchObject({
      channel_id: 'ops@example.com',
      prompt: 'Write the operational update.',
    });
    expect(runner).not.toHaveBeenCalled();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    const { rearmScheduler } = await import('../src/scheduler/scheduler.ts');
    rearmScheduler();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0]).toMatchObject({
      source: 'scheduled-task',
      taskId: tasks[0].id,
      sessionId: 'session-e2e',
      channelId: 'ops@example.com',
      delivery: { kind: 'channel', channelId: 'ops@example.com' },
    });
    expect(runner.mock.calls[0][0].prompt).toContain(
      'Write the operational update.',
    );
    expect(
      getAllJobs({ kind: 'scheduled_task', sessionId: 'session-e2e' }),
    ).toHaveLength(0);

    vi.useRealTimers();
    const denied = await tools.executeTool(
      'cron',
      JSON.stringify({ action: 'remove', taskId: 999 }),
    );
    expect(denied).toContain('Error: scheduled task removal failed (HTTP 404)');
  } finally {
    stopScheduler();
    tools.setGatewayContext(undefined, undefined, '');
    tools.setSessionContext('');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
