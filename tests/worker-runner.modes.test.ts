import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';
import {
  baseRequest,
  firstInput,
  makeFakeWorker,
  okOutput,
  RUNNER_MODES,
  testCredentials,
  useRunnerModes,
} from './helpers/worker-runner-modes.js';

const startRunner = useRunnerModes('hybridclaw-worker-runner-modes-');

type ReadOutputOptions = {
  activity?: { lastActivityMs: number; notify: () => void };
  terminalError?: () => string | null;
};

function pendingOutputs() {
  const finish: Array<() => void> = [];
  const readOutput = () =>
    new Promise((resolve) => {
      finish.push(() => resolve(okOutput()));
    });
  return { finish, readOutput };
}

describe.each(RUNNER_MODES)('$mode runner', (mode) => {
  test('redacts credentials in the result and error but keeps user-visible text', async () => {
    const { runner } = await startRunner(mode, {
      readOutput: async () => ({
        status: 'error' as const,
        result:
          'Invited pat@example.com and used OPENAI_API_KEY=sk-1234567890abcdefghijklmnop.',
        toolsUsed: [],
        artifacts: [],
        error:
          'Could not notify sam@example.com with Authorization: Bearer 1234567890abcdefghijklmnopqrstuv',
      }),
    });

    const output = await runner.exec({
      ...baseRequest,
      sessionId: 'session-redaction',
    });

    expect(output.result).toBe(
      'Invited pat@example.com and used OPENAI_API_KEY=sk-123...mnop.',
    );
    expect(output.error).toBe(
      'Could not notify sam@example.com with Authorization: Bearer 123456...stuv',
    );
  });

  test('redacts credentials in streamed text and tool progress', async () => {
    const run = await startRunner(mode, {
      readOutput: async () => {
        const proc = run.workers[0];
        const delta = Buffer.from(
          'Invited pat@example.com with token sk-1234567890abcdefghijklmnop.',
          'utf-8',
        ).toString('base64');
        proc.stderr.emit('data', Buffer.from(`[stream] ${delta}\n`));
        proc.stderr.emit(
          'data',
          Buffer.from(
            '[tool] bash result (12ms): emailed user@example.com with OPENAI_API_KEY=sk-1234567890abcdefghijklmnop\n',
          ),
        );
        // A pipe chunk can end inside a multi-byte character.
        const splitLine = Buffer.from(
          '[tool] read result (3ms): Größenübersicht für café\n',
        );
        const cut = splitLine.indexOf(Buffer.from('ö')) + 1;
        proc.stderr.emit('data', splitLine.subarray(0, cut));
        proc.stderr.emit('data', splitLine.subarray(cut));
        return okOutput();
      },
    });
    const deltas: string[] = [];
    const toolEvents: Array<{ preview?: string }> = [];

    await run.runner.exec({
      ...baseRequest,
      sessionId: 'session-stream-visible',
      onTextDelta: (delta) => deltas.push(delta),
      onToolProgress: (event) => toolEvents.push(event),
    });

    expect(deltas).toEqual([
      'Invited pat@example.com with token sk-123...mnop.',
    ]);
    expect(toolEvents[0]?.preview).toBe(
      'emailed user@example.com with OPENAI_API_KEY=sk-123...mnop',
    );
    expect(toolEvents[1]?.preview).toBe('Größenübersicht für café');
  });

  test('redacts credentials in approval details but keeps contact details', async () => {
    const { runner } = await startRunner(mode, {
      readOutput: async () => ({
        status: 'success' as const,
        result: 'Approval needed.',
        toolsUsed: ['web_search'],
        artifacts: [],
        pendingApproval: {
          approvalId: '089 4233232',
          prompt:
            'I need your approval before I call +49 170 3330160, contact user@example.com, and use OPENAI_API_KEY=sk-1234567890abcdefghijklmnop.',
          intent: 'contact +49 170 3330160',
          reason: 'notify user@example.com',
          allowSession: true,
          allowAgent: true,
          allowAll: true,
          expiresAt: 1_710_000_000_000,
        },
      }),
    });

    const output = await runner.exec({
      ...baseRequest,
      sessionId: 'session-approval-redaction',
    });

    expect(output.pendingApproval?.approvalId).toBe('089 4233232');
    expect(output.pendingApproval?.prompt).toContain('+49 170 3330160');
    expect(output.pendingApproval?.prompt).toContain('user@example.com');
    expect(output.pendingApproval?.prompt).toContain(
      'OPENAI_API_KEY=sk-123...mnop',
    );
    expect(output.pendingApproval?.intent).toContain('+49 170 3330160');
    expect(output.pendingApproval?.reason).toContain('user@example.com');
  });

  test('turns off text streaming without a text callback and passes run limits', async () => {
    const { runner, workers } = await startRunner(mode);

    await runner.exec({
      ...baseRequest,
      sessionId: 'session-no-stream-ipc',
      fileWriteGuardSessionId: 'parent-worker',
      fileWriteGuardUserPrompt: 'Preserve the existing notes.',
      runId: 'bounded-run',
      toolCallLimits: { example__write: 12 },
      channelId: 'web',
    });

    expect(workers[0]?.stdin.write).toHaveBeenCalledTimes(1);
    expect(firstInput(workers[0])).toMatchObject({
      runId: 'bounded-run',
      toolCallLimits: { example__write: 12 },
      approvalUserText: null,
      fileWriteGuardSessionId: 'parent-worker',
      fileWriteGuardUserPrompt: 'Preserve the existing notes.',
      streamTextDeltas: false,
    });
  });

  test('does not apply the HybridAI token cap to remote OpenAI-compatible providers', async () => {
    const { runner, workers } = await startRunner(mode, {
      credentials: async () =>
        testCredentials({
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          chatbotId: '',
        }),
    });

    await runner.exec({
      ...baseRequest,
      sessionId: 'session-openrouter-max-tokens',
      chatbotId: '',
      model: 'openrouter/qwen/qwen3.5-27b',
      channelId: 'web',
    });

    expect(firstInput(workers[0])).not.toHaveProperty('maxTokens');
  });

  test.each([
    { provider: 'openrouter', model: 'openrouter/anthropic/claude-sonnet-4', expected: 64_000 },
    { provider: 'nebius', model: 'nebius/zai-org/GLM-5.3-Flash', expected: 64_000 },
  ] as const)('sends the provider output budget for $model', async ({ provider, model, expected }) => {
    const { runner, workers } = await startRunner(mode, {
      credentials: async () =>
        testCredentials({
          provider,
          baseUrl: 'https://openrouter.ai/api/v1',
          chatbotId: '',
          contextWindow: 200_000,
          maxTokens: 64_000,
        }),
    });

    await runner.exec({
      ...baseRequest,
      sessionId: 'session-openrouter-anthropic-max-tokens',
      chatbotId: '',
      model,
      channelId: 'web',
    });

    expect(firstInput(workers[0]).maxTokens).toBe(expected);
  });

  test('surfaces a missing packaged runtime dependency as an immediate error with the mode repair hint', async () => {
    const run = await startRunner(mode, {
      readOutput: async (
        _sessionId: string,
        _requestId: string,
        _timeoutMs: number,
        opts?: ReadOutputOptions,
      ) => {
        const proc = run.workers[0];
        proc.stderr.emit(
          'data',
          Buffer.from(
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@modelcontextprotocol/sdk' imported from /pkg/container/dist/mcp/client-manager.js\n",
          ),
        );
        proc.exitCode = 1;
        proc.emit('close', 1, null);
        return {
          status: 'error' as const,
          result: null,
          toolsUsed: [],
          artifacts: [],
          error: opts?.terminalError?.() || 'missing terminal error',
        };
      },
    });

    const output = await run.runner.exec({
      ...baseRequest,
      sessionId: 'session-missing-runtime-dep',
    });

    expect(output.status).toBe('error');
    expect(output.error).toContain(
      `${mode.runtimeLabel} exited before producing output (exit code 1).`,
    );
    expect(output.error).toContain(
      'Missing runtime dependency: @modelcontextprotocol/sdk.',
    );
    // Docker images bake their own node_modules, so the container hint points
    // at an image rebuild; the host hint at the host bootstrap script.
    expect(output.error).toContain(mode.repairHint);
  });

  test('forwards maxWallClockMs to the IPC output reader', async () => {
    const { runner, readOutput } = await startRunner(mode);

    await runner.exec({
      ...baseRequest,
      sessionId: 'session-max-wall-clock',
      maxWallClockMs: 3_600_000,
    });

    expect(readOutput).toHaveBeenCalledWith(
      'session-max-wall-clock',
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({ maxWallClockMs: 3_600_000 }),
    );
  });

  test('forwards a disabled inactivity timeout to the IPC output reader', async () => {
    const { runner, readOutput } = await startRunner(mode);

    await runner.exec({
      ...baseRequest,
      sessionId: 'session-no-inactivity-timeout',
      inactivityTimeoutMs: null,
    });

    expect(readOutput).toHaveBeenCalledWith(
      'session-no-inactivity-timeout',
      expect.any(String),
      null,
      expect.any(Object),
    );
  });

  test('treats heartbeat lines as activity without evicting stderr context', async () => {
    const notifiedAfterHeartbeat: number[] = [];
    const run = await startRunner(mode, {
      readOutput: async (
        _sessionId: string,
        _requestId: string,
        _timeoutMs: number,
        opts?: ReadOutputOptions,
      ) => {
        const proc = run.workers[0];
        proc.stderr.emit(
          'data',
          Buffer.from('Error: tool crashed while uploading report.pdf\n'),
        );
        const activity = opts?.activity;
        if (activity) activity.lastActivityMs = 0;
        for (let i = 0; i < 25; i += 1) {
          proc.stderr.emit('data', Buffer.from('[stream-activity]\n'));
        }
        if (activity) notifiedAfterHeartbeat.push(activity.lastActivityMs);
        proc.exitCode = 1;
        proc.emit('close', 1, null);
        return {
          status: 'error' as const,
          result: null,
          toolsUsed: [],
          artifacts: [],
          error: opts?.terminalError?.() || 'missing terminal error',
        };
      },
    });

    const output = await run.runner.exec({
      ...baseRequest,
      sessionId: 'session-heartbeat-history',
    });

    expect(notifiedAfterHeartbeat).toHaveLength(1);
    expect(notifiedAfterHeartbeat[0]).toBeGreaterThan(0);
    expect(output.status).toBe('error');
    expect(output.error).toContain('tool crashed while uploading report.pdf');
    expect(output.error).not.toContain('[stream-activity]');
  });

  test('reports an in-flight session while the output read is pending', async () => {
    const { finish, readOutput } = pendingOutputs();
    const { runner, readOutput: readOutputMock } = await startRunner(mode, {
      readOutput,
    });
    expect(runner.getInFlightSessionCount()).toBe(0);
    expect(runner.getInFlightSessionIds()).toEqual([]);

    const pending = runner.exec({ ...baseRequest, sessionId: 'session-in-flight' });
    await vi.waitFor(() => expect(readOutputMock).toHaveBeenCalledTimes(1));

    expect(runner.getInFlightSessionCount()).toBe(1);
    expect(runner.getInFlightSessionIds()).toEqual(['session-in-flight']);

    finish[0]?.();
    await pending;

    expect(runner.getInFlightSessionCount()).toBe(0);
    expect(runner.getInFlightSessionIds()).toEqual([]);
    // The worker stays attached after the turn; it is just no longer running.
    expect(runner.getActiveSessionIds()).toEqual(['session-in-flight']);
  });

  test('stops and respawns a timed out pooled worker', async () => {
    const run = await startRunner(mode, {
      readOutput: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'error' as const,
          result: null,
          toolsUsed: [],
          artifacts: [],
          error:
            'Timeout waiting for agent output after 1200000ms total (300000ms inactivity window)',
        })
        .mockResolvedValueOnce(okOutput()),
    });
    const request = {
      ...baseRequest,
      sessionId: 'heartbeat:main',
      agentId: 'main',
      channelId: 'heartbeat',
    };

    const firstOutput = await run.runner.exec(request);

    expect(firstOutput.status).toBe('error');
    expect(mode.stopCount(run)).toBe(1);
    expect(mode.wasStopped(run.workers[0], run)).toBe(true);

    const secondOutput = await run.runner.exec(request);

    expect(secondOutput.status).toBe('success');
    expect(run.workers).toHaveLength(2);
    expect(mode.stopCount(run)).toBe(1);
  });

  test('respawns the pooled worker when the provider changes for a session', async () => {
    const run = await startRunner(mode, {
      credentials: async ({ model }: { model?: string }) =>
        String(model).startsWith('lmstudio/')
          ? testCredentials({
              provider: 'lmstudio',
              baseUrl: 'http://127.0.0.1:1234/v1',
              chatbotId: '',
              agentId: 'lmstudio',
              isLocal: true,
              contextWindow: 32_768,
            })
          : testCredentials({
              provider: 'vllm',
              baseUrl: 'http://gpu.example:8000/v1',
              chatbotId: '',
              agentId: 'vllm',
              isLocal: true,
              contextWindow: 32_768,
            }),
    });
    const request = { ...baseRequest, sessionId: 'tui:local', chatbotId: '' };

    await run.runner.exec({ ...request, model: 'lmstudio/qwen', agentId: 'lmstudio' });
    await run.runner.exec({ ...request, model: 'vllm/mistral', agentId: 'vllm' });

    expect(run.workers).toHaveLength(2);
    expect(mode.wasStopped(run.workers[0], run)).toBe(true);
    expect(mode.workerWorkspace(run.workerCalls[0])).toContain(
      path.join('.hybridclaw', 'data', 'agents', 'lmstudio', 'workspace'),
    );
    expect(mode.workerWorkspace(run.workerCalls[1])).toContain(
      path.join('.hybridclaw', 'data', 'agents', 'vllm', 'workspace'),
    );
  });

  test('respawns the pooled worker when the agentId changes without auth changes', async () => {
    const run = await startRunner(mode, {
      credentials: async () =>
        testCredentials({ apiKey: 'shared-token', enableRag: true }),
    });
    const request = { ...baseRequest, sessionId: 'tui:local', enableRag: true };

    await run.runner.exec(request);
    await run.runner.exec({ ...request, agentId: 'workspace-b' });

    expect(run.workers).toHaveLength(2);
    expect(mode.wasStopped(run.workers[0], run)).toBe(true);
    expect(mode.workerWorkspace(run.workerCalls[0])).toContain(
      path.join('.hybridclaw', 'data', 'agents', 'default', 'workspace'),
    );
    expect(mode.workerWorkspace(run.workerCalls[1])).toContain(
      path.join('.hybridclaw', 'data', 'agents', 'workspace-b', 'workspace'),
    );
  });

  test('runs as many concurrent sessions as the pool holds', async () => {
    const { runner, workers } = await startRunner(mode, {
      readOutput: () =>
        new Promise((resolve) => setTimeout(() => resolve(okOutput()), 200)),
    });

    const sessions = ['sess-1', 'sess-2', 'sess-3', 'sess-4', 'heartbeat:main'];
    const promises = sessions.map((sessionId) =>
      runner.exec({ ...baseRequest, sessionId }),
    );
    await vi.waitFor(() => expect(workers).toHaveLength(5));

    const results = await Promise.all(promises);
    expect(results.every((result) => result.status === 'success')).toBe(true);
  });

  test('a full pool fails as busy, after its capacity wait where the mode has one', async () => {
    const { finish, readOutput } = pendingOutputs();
    const { runner, workers } = await startRunner(mode, { readOutput });
    const running = ['sess-1', 'sess-2', 'sess-3', 'sess-4', 'sess-5'].map(
      (sessionId) => runner.exec({ ...baseRequest, sessionId }),
    );
    await vi.waitFor(() => expect(workers).toHaveLength(5));

    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      let settled = false;
      const overflow = runner.exec({ ...baseRequest, sessionId: 'sess-6' });
      void overflow.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(!mode.expected.fullPoolWaits);

      vi.setSystemTime(Date.now() + 16_000);
      await expect(overflow).resolves.toMatchObject({
        status: 'error',
        errorCode: 'busy',
        error: expect.stringMatching(mode.expected.busyError),
      });
      expect(workers).toHaveLength(5);
    } finally {
      vi.useRealTimers();
      for (const done of finish) done();
      await Promise.all(running);
      runner.stopAll();
    }
  });

  test('keeps the last worker for a user turn while background runs fill the rest', async () => {
    const { finish, readOutput } = pendingOutputs();
    const { runner, workers } = await startRunner(mode, { readOutput });
    const run = (sessionId: string, background: boolean, signal?: AbortSignal) =>
      runner.exec({
        ...baseRequest,
        sessionId,
        channelId: 'web',
        background,
        abortSignal: signal,
      });

    try {
      const scheduled = ['cron:1', 'cron:2', 'cron:3', 'cron:4'].map((id) =>
        run(id, true),
      );
      await vi.waitFor(() => expect(workers).toHaveLength(4));

      const lateCron = new AbortController();
      const late = run('cron:5', true, lateCron.signal);
      const userTurn = run('web:phone', false);
      await vi.waitFor(() => expect(workers).toHaveLength(5));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(workers).toHaveLength(5);

      lateCron.abort();
      await expect(late).resolves.toMatchObject({ status: 'error' });
      for (const done of finish) done();
      const results = await Promise.all([...scheduled, userTurn]);
      expect(results.every((result) => result.status === 'success')).toBe(true);
    } finally {
      runner.stopAll();
    }
  });

  test('an abort stops the worker once and the next turn gets a new one', async () => {
    const interruptible = (
      _sessionId: string,
      _requestId: string,
      _timeoutMs: number,
      opts?: { signal?: AbortSignal },
    ) =>
      new Promise((resolve) => {
        opts?.signal?.addEventListener('abort', () =>
          resolve({
            status: 'error' as const,
            result: null,
            toolsUsed: [],
            error: 'Interrupted by user.',
          }),
        );
      });
    const run = await startRunner(mode, {
      readOutput: vi
        .fn()
        .mockImplementationOnce(interruptible)
        .mockResolvedValue(okOutput()),
    });
    const controller = new AbortController();
    const pending = run.runner.exec({
      ...baseRequest,
      sessionId: 'session-abort',
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(run.readOutput).toHaveBeenCalledTimes(1));

    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: 'error' });
    // The stopped worker has not exited yet; it already left the pool.
    expect(run.runner.getActiveSessionCount()).toBe(0);

    await expect(
      run.runner.exec({ ...baseRequest, sessionId: 'session-abort' }),
    ).resolves.toMatchObject({ status: 'success' });
    expect(run.workers).toHaveLength(2);
    expect(run.workers[0].stdin.write).toHaveBeenCalledTimes(1);
    expect(run.workers[1].stdin.write).toHaveBeenCalledTimes(1);
    expect(run.writeInput).not.toHaveBeenCalled();
    run.workers[0].exitCode = 0;
    run.workers[0].emit('close', 0, 'SIGTERM');
    expect(mode.stopCount(run)).toBe(1);
    expect(run.runner.getActiveSessionIds()).toEqual(['session-abort']);
  });

  test('gives the worker the browser a run asks for, else the configured one', async () => {
    const { runner, workers } = await startRunner(mode, {
      config: { BROWSER_PROVIDER: 'mac-cua' },
    });
    const request = {
      ...baseRequest,
      messages: [{ role: 'user' as const, content: 'open example.com' }],
      channelId: 'web',
    };

    await runner.exec({
      ...request,
      sessionId: 'web:phone',
      fileWriteGuardSessionId: 'parent-worker',
      fileWriteGuardUserPrompt: 'Preserve the existing notes.',
      browserProvider: 'local',
    });
    await runner.exec({ ...request, sessionId: 'web:desk' });

    expect(firstInput(workers[0])).toMatchObject({
      browserProvider: 'local',
      fileWriteGuardSessionId: 'parent-worker',
      fileWriteGuardUserPrompt: 'Preserve the existing notes.',
    });
    expect(firstInput(workers[1])).toMatchObject({ browserProvider: 'mac-cua' });
    expect(firstInput(workers[1]).fileWriteGuardUserPrompt).toBeUndefined();
  });

  test('claims a warm worker for a later session', async () => {
    const { runner, workers, logger } = await startRunner(mode, {
      warmPool: true,
    });

    await runner.exec({ ...baseRequest, sessionId: 'session-before-warm' });
    runner.stopSession('session-before-warm');
    const warmWorker = workers[1];
    expect(warmWorker).toBeDefined();
    expect(warmWorker?.stdin.write).not.toHaveBeenCalled();

    await runner.exec({ ...baseRequest, sessionId: 'session-claims-warm' });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-claims-warm',
        agentId: 'default',
        ...mode.claimedWarm.fields,
      }),
      mode.claimedWarm.message,
    );
    expect(warmWorker?.stdin.write).toHaveBeenCalledTimes(1);
  });

  test('turns an exception after dispatch into terminal journal evidence', async () => {
    const params = {
      sessionId: 'session-a',
      runId: 'run-a',
      agentId: 'default',
      messages: [{ role: 'user' as const, content: 'Save the sample.' }],
      chatbotId: 'test-bot',
      enableRag: false,
      model: 'test-model',
      channelId: 'web',
    };
    const { TurnCheckpoint } = await import('@hybridclaw/shared/turn-checkpoint');
    const { isRetrySafeRun } = await import('@hybridclaw/shared/retry-safety');
    let stateRoot = '';
    const { runner, workers } = await startRunner(mode, {
      credentials: async () =>
        testCredentials({
          apiKey: 'test-key',
          baseUrl: 'https://example.com',
          chatbotId: 'test-bot',
        }),
      readOutput: async () => {
        // Both modes keep the default agent's evidence in its workspace.
        const journal = new TurnCheckpoint(
          stateRoot,
          params.sessionId,
          params.runId,
        );
        journal.assistant({
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'write', arguments: '{}' } },
          ],
        });
        journal.start('a');
        journal.result({ role: 'tool', tool_call_id: 'a', content: 'Saved.' });
        throw new Error('IPC failed.');
      },
    });

    const { hostWorkspaceStateRoot } = await import(
      '../src/infra/host-workspace.js'
    );
    stateRoot = hostWorkspaceStateRoot(params);

    try {
      const output = await runner.exec(params);
      expect(output.toolHistory?.[1].content).toBe('Saved.');
      expect(output.recovery?.kind).toBe('recovered');
      expect(isRetrySafeRun(output, false)).toBe(false);
      expect(workers).toHaveLength(1);
    } finally {
      runner.stopAll();
    }
  });
});

describe.each(RUNNER_MODES.filter((mode) => mode.mode === 'host'))('$mode runner stdin guard', (mode) => {
  test('treats an interrupted stdin EPIPE as a user interrupt', async () => {
    const controller = new AbortController();
    const { runner, readOutput } = await startRunner(mode, {
      makeWorker: () => {
        const proc = makeFakeWorker();
        proc.stdin.write.mockImplementation(() => {
          controller.abort(new Error('Interrupted by user.'));
          proc.killed = true;
          proc.exitCode = 0;
          throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        });
        return proc;
      },
    });

    const output = await runner.exec({
      ...baseRequest,
      sessionId: 'session-interrupted-epipe',
      channelId: 'web',
      abortSignal: controller.signal,
    });

    expect(output).toEqual({
      status: 'error',
      result: null,
      toolsUsed: [],
      error: 'Interrupted by user.',
    });
    expect(readOutput).not.toHaveBeenCalled();
  });
});
