import { runAgent } from '../agent/agent.js';
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import {
  emitToolExecutionAuditEvents,
  makeAuditRunId,
  recordAuditEvent,
} from '../audit/audit-events.js';
import {
  deliverProactiveMessage,
  deliverWebhookMessage,
} from '../gateway/proactive-delivery.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import {
  getWorkflow,
  recordUsageEvent,
  updateWorkflowRunStatus,
} from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import {
  modelRequiresChatbotId,
  resolveModelProvider,
} from '../providers/factory.js';
import {
  estimateTokenCountFromMessages,
  estimateTokenCountFromText,
} from '../session/token-efficiency.js';
import type { ChatMessage } from '../types.js';
import type { WorkflowEvent } from './event-bus.js';
import {
  buildWorkflowInterpolationContext,
  interpolateWorkflowTemplate,
} from './interpolation.js';
import type {
  StoredWorkflow,
  WorkflowBootstrapContextMode,
  WorkflowDefaults,
  WorkflowDelivery,
  WorkflowRetryOn,
  WorkflowRetryPolicy,
  WorkflowStep,
} from './types.js';

type WorkflowArtifact = {
  path: string;
  filename: string;
  mimeType: string;
};

interface WorkflowStepResult {
  id: string;
  index: number;
  result: string;
}

interface ExecutedAgentStep {
  messages: ChatMessage[];
  interpolatedPrompt: string;
  output: Awaited<ReturnType<typeof runAgent>>;
  resultText: string;
  artifacts?: WorkflowArtifact[];
}

const DEFAULT_WORKFLOW_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_WORKFLOW_RETRY_DELAY_MS = 2_000;

class WorkflowExecutionError extends Error {
  reason: WorkflowRetryOn | 'configuration' | 'unsupported' | 'validation';

  constructor(
    message: string,
    reason: WorkflowRetryOn | 'configuration' | 'unsupported' | 'validation',
    options?: {
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = 'WorkflowExecutionError';
    this.reason = reason;
  }
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function sortWorkflowSteps(steps: WorkflowStep[]): WorkflowStep[] {
  const byId = new Map(steps.map((step) => [step.id, step] as const));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of steps) {
    inDegree.set(step.id, step.dependsOn?.length || 0);
    for (const dependency of step.dependsOn || []) {
      const list = dependents.get(dependency) || [];
      list.push(step.id);
      dependents.set(dependency, list);
    }
  }

  const queue = steps.filter((step) => (inDegree.get(step.id) || 0) === 0);
  const ordered: WorkflowStep[] = [];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) continue;
    ordered.push(next);
    for (const dependentId of dependents.get(next.id) || []) {
      const nextDegree = Math.max(0, (inDegree.get(dependentId) || 0) - 1);
      inDegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        const dependent = byId.get(dependentId);
        if (dependent) queue.push(dependent);
      }
    }
  }

  if (ordered.length !== steps.length) {
    throw new WorkflowExecutionError(
      'Workflow steps contain a dependency cycle.',
      'validation',
    );
  }
  return ordered;
}

function buildWorkflowStepPrompt(params: {
  workflow: StoredWorkflow;
  step: WorkflowStep;
  interpolatedPrompt: string;
  event?: WorkflowEvent;
}): string {
  const { workflow, interpolatedPrompt, event } = params;
  const lines = [
    `Workflow: ${workflow.name}`,
    workflow.description ? `Description: ${workflow.description}` : null,
    `Trigger: ${workflow.spec.trigger.kind}`,
    event?.sourceChannel ? `Source channel: ${event.sourceChannel}` : null,
    event?.senderAddress
      ? `Sender: ${event.senderAddress}`
      : event?.senderId
        ? `Sender: ${event.senderId}`
        : null,
    event?.subject ? `Subject: ${event.subject}` : null,
    event?.content ? `Content:\n${event.content}` : null,
    `Current time: ${new Date().toISOString()}`,
    '',
    'Execute the workflow step directly. Return only the content that should be delivered automatically.',
    '',
    interpolatedPrompt,
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}

function resolveDeliveryKey(delivery: WorkflowDelivery): string {
  return [
    delivery.kind,
    delivery.channelType || '',
    delivery.target || '',
    delivery.channelName || '',
  ].join('|');
}

function buildUsageMetrics(
  messages: ChatMessage[],
  resultText: string,
  tokenUsage: Awaited<ReturnType<typeof runAgent>>['tokenUsage'],
): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  estimatedTotalTokens: number;
  apiUsageAvailable: boolean;
  apiPromptTokens: number;
  apiCompletionTokens: number;
  apiTotalTokens: number;
} {
  const estimatedPromptTokens =
    tokenUsage?.estimatedPromptTokens ||
    estimateTokenCountFromMessages(messages);
  const estimatedCompletionTokens =
    tokenUsage?.estimatedCompletionTokens ||
    estimateTokenCountFromText(resultText);
  const estimatedTotalTokens =
    tokenUsage?.estimatedTotalTokens ||
    estimatedPromptTokens + estimatedCompletionTokens;
  const apiUsageAvailable = tokenUsage?.apiUsageAvailable === true;
  const apiPromptTokens = tokenUsage?.apiPromptTokens || 0;
  const apiCompletionTokens = tokenUsage?.apiCompletionTokens || 0;
  const apiTotalTokens =
    tokenUsage?.apiTotalTokens || apiPromptTokens + apiCompletionTokens;

  return {
    promptTokens: apiUsageAvailable ? apiPromptTokens : estimatedPromptTokens,
    completionTokens: apiUsageAvailable
      ? apiCompletionTokens
      : estimatedCompletionTokens,
    totalTokens: apiUsageAvailable ? apiTotalTokens : estimatedTotalTokens,
    estimatedPromptTokens,
    estimatedCompletionTokens,
    estimatedTotalTokens,
    apiUsageAvailable,
    apiPromptTokens,
    apiCompletionTokens,
    apiTotalTokens,
  };
}

function mergeRetryPolicy(
  defaults?: WorkflowRetryPolicy,
  override?: WorkflowRetryPolicy,
): WorkflowRetryPolicy | undefined {
  if (!defaults && !override) return undefined;
  return {
    maxAttempts: override?.maxAttempts ?? defaults?.maxAttempts ?? 1,
    backoffMs: override?.backoffMs ?? defaults?.backoffMs,
    strategy: override?.strategy ?? defaults?.strategy,
    retryOn: override?.retryOn ?? defaults?.retryOn,
  };
}

function resolveStepTimeoutMs(
  defaults: WorkflowDefaults | undefined,
  step: WorkflowStep,
): number {
  return (
    step.timeoutMs || defaults?.timeoutMs || DEFAULT_WORKFLOW_STEP_TIMEOUT_MS
  );
}

function resolveStepRetryPolicy(
  defaults: WorkflowDefaults | undefined,
  step: WorkflowStep,
): WorkflowRetryPolicy {
  return (
    mergeRetryPolicy(defaults?.retryPolicy, step.retryPolicy) || {
      maxAttempts: 1,
    }
  );
}

function resolveStepBootstrapContextMode(
  defaults: WorkflowDefaults | undefined,
  step: WorkflowStep,
): WorkflowBootstrapContextMode {
  return (step.lightContext ?? defaults?.lightContext) ? 'light' : 'full';
}

function classifyWorkflowError(
  error: unknown,
): WorkflowRetryOn | 'configuration' | 'unsupported' | 'validation' {
  if (error instanceof WorkflowExecutionError) {
    return error.reason;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/rate limit|429|too many requests/i.test(message)) return 'rate_limit';
  if (
    /delivery|webhook|discord|whatsapp|email|channel.*failed|send.*failed/i.test(
      message,
    )
  ) {
    return 'delivery_error';
  }
  return 'transient';
}

async function withTimeout<T>(params: {
  label: string;
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const timeoutMs = Math.max(1, Math.trunc(params.timeoutMs));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new WorkflowExecutionError(
            `${params.label} timed out after ${timeoutMs}ms.`,
            'timeout',
          ),
        );
      }, timeoutMs);
    });
    return await Promise.race([params.run(controller.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withRetry<T>(params: {
  label: string;
  retryPolicy: WorkflowRetryPolicy;
  run: () => Promise<T>;
}): Promise<T> {
  const maxAttempts = Math.max(
    1,
    Math.trunc(params.retryPolicy.maxAttempts || 1),
  );
  const retryOn = new Set<WorkflowRetryOn>(
    params.retryPolicy.retryOn || [
      'timeout',
      'delivery_error',
      'rate_limit',
      'transient',
    ],
  );
  const strategy = params.retryPolicy.strategy || 'fixed';
  const baseDelayMs =
    params.retryPolicy.backoffMs || DEFAULT_WORKFLOW_RETRY_DELAY_MS;

  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await params.run();
    } catch (error) {
      const reason = classifyWorkflowError(error);
      const shouldRetry =
        attempt < maxAttempts &&
        (reason === 'timeout' ||
          reason === 'delivery_error' ||
          reason === 'rate_limit' ||
          reason === 'transient')
          ? retryOn.has(reason)
          : false;
      if (!shouldRetry) throw error;

      const multiplier = strategy === 'exponential' ? 2 ** (attempt - 1) : 1;
      const delayMs = Math.max(1, Math.trunc(baseDelayMs * multiplier));
      logger.warn(
        {
          attempt,
          maxAttempts,
          delayMs,
          label: params.label,
          reason,
          error,
        },
        'Retrying workflow step after failure',
      );
      await waitForDelay(delayMs);
    }
  }

  throw new WorkflowExecutionError(
    `${params.label} exhausted retry attempts.`,
    'transient',
  );
}

async function deliverWorkflowResult(params: {
  workflow: StoredWorkflow;
  delivery: WorkflowDelivery;
  event?: WorkflowEvent;
  source: string;
  text: string;
  artifacts?: WorkflowArtifact[];
  timeoutMs: number;
}): Promise<void> {
  const { workflow, delivery, event, source, text, artifacts, timeoutMs } =
    params;
  try {
    if (delivery.kind === 'webhook') {
      const webhookUrl = String(delivery.target || '').trim();
      if (!webhookUrl) {
        throw new WorkflowExecutionError(
          'Workflow webhook delivery requires a target URL.',
          'configuration',
        );
      }
      await deliverWebhookMessage(webhookUrl, text, source, artifacts, {
        timeoutMs,
      });
      return;
    }

    let channelTarget = '';
    if (delivery.kind === 'originating') {
      channelTarget = String(event?.channelId || workflow.channel_id).trim();
    } else if (delivery.kind === 'email') {
      channelTarget = String(delivery.target || '').trim();
      if (!channelTarget) {
        throw new WorkflowExecutionError(
          'Workflow email delivery requires a target address.',
          'configuration',
        );
      }
    } else {
      channelTarget = String(delivery.target || workflow.channel_id).trim();
    }
    if (!channelTarget) {
      throw new WorkflowExecutionError(
        'Workflow delivery target could not be resolved.',
        'configuration',
      );
    }
    await deliverProactiveMessage(channelTarget, text, source, artifacts, {
      strict: true,
      timeoutMs,
    });
  } catch (error) {
    const reason = classifyWorkflowError(error);
    if (
      reason === 'configuration' ||
      reason === 'unsupported' ||
      reason === 'validation'
    ) {
      throw error;
    }
    throw new WorkflowExecutionError(
      error instanceof Error
        ? error.message
        : 'Workflow delivery failed unexpectedly.',
      reason === 'timeout' || reason === 'rate_limit'
        ? reason
        : 'delivery_error',
      { cause: error },
    );
  }
}

function resolveDeliveryArtifacts(params: {
  step: WorkflowStep;
  stepArtifacts: Map<string, WorkflowArtifact[] | undefined>;
  fallbackArtifacts?: WorkflowArtifact[];
}): WorkflowArtifact[] | undefined {
  const { step, stepArtifacts, fallbackArtifacts } = params;
  const dependencyIds = step.dependsOn || [];
  for (let index = dependencyIds.length - 1; index >= 0; index -= 1) {
    const dependencyArtifacts = stepArtifacts.get(dependencyIds[index]);
    if (dependencyArtifacts && dependencyArtifacts.length > 0) {
      return dependencyArtifacts;
    }
  }
  return fallbackArtifacts;
}

async function executeAgentStep(params: {
  workflow: StoredWorkflow;
  workflowSessionId: string;
  agentId: string;
  chatbotId: string;
  model: string;
  step: WorkflowStep;
  event?: WorkflowEvent;
  stepResults: WorkflowStepResult[];
  extractedValues: Record<string, string>;
  bootstrapContextMode: WorkflowBootstrapContextMode;
  abortSignal: AbortSignal;
}): Promise<ExecutedAgentStep> {
  const interpolationContext = buildWorkflowInterpolationContext({
    event: params.event,
    workflowContext: params.workflow.spec.context,
    stepResults: params.stepResults,
    extractedValues: params.extractedValues,
    fallbackTimestamp: new Date().toISOString(),
  });
  const interpolatedPrompt = interpolateWorkflowTemplate(
    params.step.prompt || '',
    interpolationContext,
  );
  const userPrompt = buildWorkflowStepPrompt({
    workflow: params.workflow,
    step: params.step,
    interpolatedPrompt,
    event: params.event,
  });
  const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }];
  const output = await runAgent({
    sessionId: params.workflowSessionId,
    messages,
    chatbotId: params.chatbotId,
    enableRag: false,
    model: params.model,
    agentId: params.agentId,
    channelId: params.workflow.channel_id,
    blockedTools: ['cron', 'workflow'],
    abortSignal: params.abortSignal,
    bootstrapContextMode: params.bootstrapContextMode,
  });

  const resultText = output.result || '';
  if (output.status !== 'success' || !resultText.trim()) {
    throw new WorkflowExecutionError(
      output.error ||
        `Workflow step ${params.step.id} returned no deliverable result.`,
      classifyWorkflowError(
        output.error || resultText || 'workflow step failed',
      ),
    );
  }

  return {
    messages,
    interpolatedPrompt,
    output,
    resultText,
    artifacts: output.artifacts,
  };
}

export async function executeWorkflow(params: {
  workflowId: number;
  event?: WorkflowEvent;
  agentId: string;
  sessionId: string;
}): Promise<void> {
  const workflow = getWorkflow(params.workflowId);
  if (!workflow || !workflow.enabled) {
    return;
  }

  const runId = makeAuditRunId('workflow');
  const workflowSessionId = `workflow:${workflow.id}`;
  const startedAt = Date.now();
  const session = memoryService.getOrCreateSession(
    params.sessionId,
    null,
    workflow.channel_id,
    params.agentId,
  );
  const { agentId, chatbotId, model } = resolveAgentForRequest({
    agentId: params.agentId,
    session,
  });
  if (modelRequiresChatbotId(model) && !chatbotId) {
    throw new WorkflowExecutionError(
      'No chatbot configured for workflow execution. Configure a chatbot before running this workflow.',
      'configuration',
    );
  }

  const orderedSteps = sortWorkflowSteps(workflow.spec.steps);
  const provider = resolveModelProvider(model);
  const workspacePath = agentWorkspaceDir(agentId);
  const stepResults: WorkflowStepResult[] = [];
  const stepArtifacts = new Map<string, WorkflowArtifact[] | undefined>();
  const extractedValues: Record<string, string> = {};
  let totalToolCalls = 0;
  let completedSteps = 0;
  let activeStep: WorkflowStep | null = null;
  let activeStepIndex = 0;
  let activeStepStartedAt = 0;
  let finalResultText = '';
  let finalArtifacts: WorkflowArtifact[] | undefined;

  recordAuditEvent({
    sessionId: params.sessionId,
    runId,
    event: {
      type: 'workflow.execution.start',
      workflowId: workflow.id,
      workflowName: workflow.name,
      triggerKind: workflow.spec.trigger.kind,
      stepCount: orderedSteps.length,
      sourceChannel: params.event?.sourceChannel || null,
    },
  });
  recordAuditEvent({
    sessionId: workflowSessionId,
    runId,
    event: {
      type: 'session.start',
      userId: 'workflow',
      channel: workflow.channel_id,
      cwd: workspacePath,
      model,
      source: 'workflow',
      workflowId: workflow.id,
    },
  });

  try {
    for (const [index, step] of orderedSteps.entries()) {
      activeStep = step;
      activeStepIndex = index + 1;
      activeStepStartedAt = Date.now();
      const timeoutMs = resolveStepTimeoutMs(workflow.spec.defaults, step);
      const retryPolicy = resolveStepRetryPolicy(workflow.spec.defaults, step);
      const bootstrapContextMode = resolveStepBootstrapContextMode(
        workflow.spec.defaults,
        step,
      );

      recordAuditEvent({
        sessionId: params.sessionId,
        runId,
        event: {
          type: 'workflow.step.start',
          workflowId: workflow.id,
          stepId: step.id,
          stepIndex: activeStepIndex,
          stepKind: step.kind,
        },
      });
      if (step.kind === 'agent') {
        recordAuditEvent({
          sessionId: workflowSessionId,
          runId,
          event: {
            type: 'turn.start',
            turnIndex: activeStepIndex,
            userInput: step.prompt || '',
            source: 'workflow',
            workflowId: workflow.id,
            stepId: step.id,
          },
        });
      }

      if (step.kind === 'agent') {
        const executed = await withRetry({
          label: `workflow ${workflow.id} step ${step.id}`,
          retryPolicy,
          run: () =>
            withTimeout({
              label: `workflow ${workflow.id} step ${step.id}`,
              timeoutMs,
              run: (signal) =>
                executeAgentStep({
                  workflow,
                  workflowSessionId,
                  agentId,
                  chatbotId,
                  model,
                  step,
                  event: params.event,
                  stepResults,
                  extractedValues,
                  bootstrapContextMode,
                  abortSignal: signal,
                }),
            }),
        });
        const toolExecutions = executed.output.toolExecutions || [];
        totalToolCalls += toolExecutions.length;
        emitToolExecutionAuditEvents({
          sessionId: workflowSessionId,
          runId,
          toolExecutions,
        });
        const usage = buildUsageMetrics(
          executed.messages,
          executed.resultText,
          executed.output.tokenUsage,
        );
        recordAuditEvent({
          sessionId: workflowSessionId,
          runId,
          event: {
            type: 'model.usage',
            provider,
            model,
            durationMs: Date.now() - activeStepStartedAt,
            toolCallCount: toolExecutions.length,
            modelCalls: executed.output.tokenUsage
              ? Math.max(1, executed.output.tokenUsage.modelCalls)
              : 0,
            ...usage,
          },
        });
        recordUsageEvent({
          sessionId: workflowSessionId,
          agentId,
          model,
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          toolCalls: toolExecutions.length,
        });

        if (step.deliverTo) {
          await withRetry({
            label: `workflow ${workflow.id} step ${step.id} delivery`,
            retryPolicy,
            run: () =>
              withTimeout({
                label: `workflow ${workflow.id} step ${step.id} delivery`,
                timeoutMs,
                run: async () =>
                  deliverWorkflowResult({
                    workflow,
                    delivery: step.deliverTo as WorkflowDelivery,
                    event: params.event,
                    source: `workflow:${workflow.id}:${step.id}`,
                    text: executed.resultText,
                    artifacts: executed.artifacts,
                    timeoutMs,
                  }),
              }),
          });
        }

        finalResultText = executed.resultText;
        finalArtifacts = executed.artifacts;
        stepResults.push({
          id: step.id,
          index: activeStepIndex,
          result: executed.resultText,
        });
        stepArtifacts.set(step.id, executed.artifacts);
        if (step.extractAs) {
          extractedValues[step.extractAs] = executed.resultText;
        }
      } else if (step.kind === 'deliver') {
        const interpolationContext = buildWorkflowInterpolationContext({
          event: params.event,
          workflowContext: workflow.spec.context,
          stepResults,
          extractedValues,
          fallbackTimestamp: new Date().toISOString(),
        });
        const text = interpolateWorkflowTemplate(
          step.input || '',
          interpolationContext,
        );
        const artifacts = resolveDeliveryArtifacts({
          step,
          stepArtifacts,
          fallbackArtifacts: finalArtifacts,
        });
        await withRetry({
          label: `workflow ${workflow.id} step ${step.id}`,
          retryPolicy,
          run: () =>
            withTimeout({
              label: `workflow ${workflow.id} step ${step.id}`,
              timeoutMs,
              run: async () =>
                deliverWorkflowResult({
                  workflow,
                  delivery: step.delivery as WorkflowDelivery,
                  event: params.event,
                  source: `workflow:${workflow.id}:${step.id}`,
                  text,
                  artifacts,
                  timeoutMs,
                }),
            }),
        });
        finalResultText = text;
        stepResults.push({
          id: step.id,
          index: activeStepIndex,
          result: text,
        });
        stepArtifacts.set(step.id, artifacts);
        if (step.extractAs) {
          extractedValues[step.extractAs] = text;
        }
      } else {
        throw new WorkflowExecutionError(
          'Workflow approval steps are not supported yet.',
          'unsupported',
        );
      }

      completedSteps += 1;
      recordAuditEvent({
        sessionId: params.sessionId,
        runId,
        event: {
          type: 'workflow.step.end',
          workflowId: workflow.id,
          stepId: step.id,
          stepIndex: activeStepIndex,
          status: 'success',
          durationMs: Date.now() - activeStepStartedAt,
        },
      });
      if (step.kind === 'agent') {
        recordAuditEvent({
          sessionId: workflowSessionId,
          runId,
          event: {
            type: 'turn.end',
            turnIndex: activeStepIndex,
            finishReason: 'completed',
          },
        });
      }
      activeStep = null;
    }

    const lastStep = orderedSteps[orderedSteps.length - 1];
    const lastStepDelivery =
      lastStep?.kind === 'deliver' ? lastStep.delivery : lastStep?.deliverTo;
    const lastStepDeliveredSameAsFinal =
      Boolean(lastStepDelivery) &&
      resolveDeliveryKey(lastStepDelivery as WorkflowDelivery) ===
        resolveDeliveryKey(workflow.spec.delivery);

    if (finalResultText && !lastStepDeliveredSameAsFinal) {
      const timeoutMs =
        workflow.spec.defaults?.timeoutMs || DEFAULT_WORKFLOW_STEP_TIMEOUT_MS;
      const retryPolicy =
        workflow.spec.defaults?.retryPolicy ||
        ({ maxAttempts: 1 } satisfies WorkflowRetryPolicy);
      await withRetry({
        label: `workflow ${workflow.id} final delivery`,
        retryPolicy,
        run: () =>
          withTimeout({
            label: `workflow ${workflow.id} final delivery`,
            timeoutMs,
            run: async () =>
              deliverWorkflowResult({
                workflow,
                delivery: workflow.spec.delivery,
                event: params.event,
                source: `workflow:${workflow.id}`,
                text: finalResultText,
                artifacts: finalArtifacts,
                timeoutMs,
              }),
          }),
      });
    }

    updateWorkflowRunStatus(workflow.id, 'success');
    recordAuditEvent({
      sessionId: params.sessionId,
      runId,
      event: {
        type: 'workflow.execution.end',
        workflowId: workflow.id,
        status: 'success',
        completedSteps,
        durationMs: Date.now() - startedAt,
      },
    });
    recordAuditEvent({
      sessionId: workflowSessionId,
      runId,
      event: {
        type: 'session.end',
        reason: 'normal',
        stats: {
          userMessages: orderedSteps.filter((step) => step.kind === 'agent')
            .length,
          assistantMessages: completedSteps,
          toolCalls: totalToolCalls,
          durationMs: Date.now() - startedAt,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = completedSteps > 0 ? 'partial' : 'error';
    updateWorkflowRunStatus(workflow.id, status);

    if (activeStep) {
      recordAuditEvent({
        sessionId: params.sessionId,
        runId,
        event: {
          type: 'workflow.step.end',
          workflowId: workflow.id,
          stepId: activeStep.id,
          stepIndex: activeStepIndex,
          status: status === 'partial' ? 'partial' : 'error',
          durationMs: Math.max(0, Date.now() - activeStepStartedAt),
          error: message,
        },
      });
      if (activeStep.kind === 'agent') {
        recordAuditEvent({
          sessionId: workflowSessionId,
          runId,
          event: {
            type: 'turn.end',
            turnIndex: activeStepIndex,
            finishReason: 'error',
          },
        });
      }
    }

    recordAuditEvent({
      sessionId: params.sessionId,
      runId,
      event: {
        type: 'workflow.execution.end',
        workflowId: workflow.id,
        status,
        completedSteps,
        durationMs: Date.now() - startedAt,
        error: message,
      },
    });
    recordAuditEvent({
      sessionId: workflowSessionId,
      runId,
      event: {
        type: 'error',
        errorType: 'workflow',
        message,
        recoverable: true,
      },
    });
    recordAuditEvent({
      sessionId: workflowSessionId,
      runId,
      event: {
        type: 'session.end',
        reason: 'error',
        stats: {
          userMessages: orderedSteps.filter((step) => step.kind === 'agent')
            .length,
          assistantMessages: completedSteps,
          toolCalls: totalToolCalls,
          durationMs: Date.now() - startedAt,
        },
      },
    });
    logger.warn(
      { error, workflowId: workflow.id, runId },
      'Workflow execution failed',
    );
    throw error;
  }
}
