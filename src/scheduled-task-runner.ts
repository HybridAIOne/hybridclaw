import { runAgent } from './agent.js';
import { emitToolExecutionAuditEvents, makeAuditRunId, recordAuditEvent } from './audit-events.js';
import type { ChatMessage } from './types.js';

export async function runIsolatedScheduledTask(params: {
  taskId: number;
  prompt: string;
  channelId: string;
  chatbotId: string;
  model: string;
  agentId: string;
  onResult: (result: string) => void | Promise<void>;
  onError: (error: unknown) => void;
}): Promise<void> {
  const { taskId, prompt, channelId, chatbotId, model, agentId, onResult, onError } = params;
  const cronSessionId = `cron:${taskId}`;
  const runId = makeAuditRunId('cron');
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  const startedAt = Date.now();

  recordAuditEvent({
    sessionId: cronSessionId,
    runId,
    event: {
      type: 'session.start',
      userId: 'scheduler',
      channel: channelId,
      cwd: process.cwd(),
      model,
      source: 'scheduler',
      taskId,
    },
  });
  recordAuditEvent({
    sessionId: cronSessionId,
    runId,
    event: {
      type: 'turn.start',
      turnIndex: 1,
      userInput: prompt,
      source: 'scheduler',
      taskId,
    },
  });

  try {
    const output = await runAgent(cronSessionId, messages, chatbotId, false, model, agentId, channelId, undefined, ['cron']);
    emitToolExecutionAuditEvents({
      sessionId: cronSessionId,
      runId,
      toolExecutions: output.toolExecutions || [],
    });
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'model.usage',
        provider: 'hybridai',
        model,
        durationMs: Date.now() - startedAt,
        toolCallCount: (output.toolExecutions || []).length,
      },
    });

    if (output.status === 'success' && output.result) {
      await onResult(output.result);
      recordAuditEvent({
        sessionId: cronSessionId,
        runId,
        event: {
          type: 'turn.end',
          turnIndex: 1,
          finishReason: 'completed',
        },
      });
      recordAuditEvent({
        sessionId: cronSessionId,
        runId,
        event: {
          type: 'session.end',
          reason: 'normal',
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            toolCalls: (output.toolExecutions || []).length,
            durationMs: Date.now() - startedAt,
          },
        },
      });
      return;
    }
    const message = output.error || 'Scheduled task returned no result.';
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'error',
        errorType: 'scheduler',
        message,
        recoverable: true,
      },
    });
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex: 1,
        finishReason: 'error',
      },
    });
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'session.end',
        reason: 'error',
        stats: {
          userMessages: 1,
          assistantMessages: 0,
          toolCalls: (output.toolExecutions || []).length,
          durationMs: Date.now() - startedAt,
        },
      },
    });
    onError(message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'error',
        errorType: 'scheduler',
        message,
        recoverable: true,
      },
    });
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'turn.end',
        turnIndex: 1,
        finishReason: 'error',
      },
    });
    recordAuditEvent({
      sessionId: cronSessionId,
      runId,
      event: {
        type: 'session.end',
        reason: 'error',
        stats: {
          userMessages: 1,
          assistantMessages: 0,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        },
      },
    });
    onError(error);
  }
}
