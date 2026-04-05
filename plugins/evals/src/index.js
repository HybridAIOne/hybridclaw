import { formatEvalUsage, parseEvalArgs } from './args.js';
import { resolveEvalPluginConfig } from './config.js';
import { buildMmluSamples, extractAnswerLetter } from './mmlu.js';
import { ensureEvalDirs, listRunRecords, writeRunRecord } from './storage.js';

function buildPromptAblation(omitWorkspaceFiles) {
  return omitWorkspaceFiles.length > 0 ? { omitWorkspaceFiles } : undefined;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function buildEvalCaseSessionId(parentSessionId, runId, caseIndex) {
  return `${parentSessionId}:eval:${runId}:${String(caseIndex).padStart(3, '0')}`;
}

function formatRunList(records) {
  if (records.length === 0) {
    return 'No saved eval runs found.';
  }
  return [
    'Recent eval runs:',
    ...records.map((record) => {
      const ablations = record.promptAblation?.omitWorkspaceFiles?.length
        ? ` ablations=${record.promptAblation.omitWorkspaceFiles.join(',')}`
        : '';
      return [
        `- ${record.runId} ${record.benchmark} acc=${formatPercent(record.accuracy || 0)} n=${record.sampleCount} model=${record.model}`,
        `  prompt=${record.promptMode || 'full'}${ablations}`,
        `  started=${record.startedAt}`,
        `  file=${record.filePath}`,
      ].join('\n');
    }),
  ].join('\n');
}

function formatCompletedRun(record, filePath) {
  const ablations = record.promptAblation?.omitWorkspaceFiles?.length
    ? record.promptAblation.omitWorkspaceFiles.join(', ')
    : '(none)';
  const subjectLine = record.subject ? `Subject: ${record.subject}\n` : '';
  return [
    `Eval complete: ${record.benchmark}`,
    `Run ID: ${record.runId}`,
    `Model: ${record.model}`,
    `Samples: ${record.sampleCount}`,
    `Accuracy: ${record.correctCount}/${record.sampleCount} (${formatPercent(record.accuracy)})`,
    `Prompt mode: ${record.promptMode}`,
    `Prompt ablations: ${ablations}`,
    subjectLine.trim(),
    `Saved: ${filePath}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function runMmluEval(api, config, command, context) {
  const targetModel = command.model || context.model;
  if (!targetModel) {
    throw new Error(
      'No target model resolved for this session. Set a model first or pass --model.',
    );
  }

  ensureEvalDirs(config);
  const promptAblation = buildPromptAblation(command.omitWorkspaceFiles);
  const runId = api.createAuditRunId('eval');
  const startedAt = new Date().toISOString();

  api.recordAuditEvent({
    sessionId: context.sessionId,
    runId,
    event: {
      type: 'eval.run.started',
      benchmark: 'mmlu',
      subject: command.subject,
      sampleCount: command.n,
      model: targetModel,
      agentId: context.agentId || null,
      promptMode: command.promptMode,
      promptAblation: promptAblation || null,
    },
  });

  const samples = await buildMmluSamples(config, command);
  const cases = [];

  for (const sample of samples) {
    const caseSessionId = buildEvalCaseSessionId(
      context.sessionId,
      runId,
      sample.caseIndex,
    );
    const response = await api.dispatchInboundMessage({
      sessionId: caseSessionId,
      sessionMode: 'new',
      guildId: context.guildId ?? null,
      channelId: context.channelId,
      userId: context.userId || context.sessionId,
      username: context.username ?? 'eval',
      content: sample.prompt,
      agentId: context.agentId ?? null,
      chatbotId: context.chatbotId ?? null,
      model: targetModel,
      enableRag: context.enableRag ?? false,
      promptMode: command.promptMode,
      promptAblation,
    });
    const rawResponse =
      typeof response.result === 'string'
        ? response.result
        : response.error
          ? String(response.error)
          : '';
    const predictedAnswer = extractAnswerLetter(rawResponse);
    const correct = predictedAnswer === sample.answer;
    const caseRecord = {
      caseIndex: sample.caseIndex,
      sessionId: caseSessionId,
      subject: sample.subject,
      question: sample.question,
      choices: sample.choices,
      expectedAnswer: sample.answer,
      predictedAnswer,
      correct,
      status: response.status,
      rawResponse,
      toolsUsed: response.toolsUsed || [],
    };
    cases.push(caseRecord);

    api.recordAuditEvent({
      sessionId: context.sessionId,
      runId,
      event: {
        type: 'eval.case.completed',
        benchmark: 'mmlu',
        caseIndex: sample.caseIndex,
        caseSessionId,
        subject: sample.subject,
        expectedAnswer: sample.answer,
        predictedAnswer,
        correct,
        status: response.status,
      },
    });
  }

  const correctCount = cases.filter((item) => item.correct).length;
  const accuracy = cases.length > 0 ? correctCount / cases.length : 0;
  const completedAt = new Date().toISOString();
  const runRecord = {
    runId,
    benchmark: 'mmlu',
    subject: command.subject,
    seed: command.seed,
    startedAt,
    completedAt,
    sessionId: context.sessionId,
    agentId: context.agentId || null,
    chatbotId: context.chatbotId || null,
    channelId: context.channelId,
    model: targetModel,
    promptMode: command.promptMode,
    promptAblation: promptAblation || null,
    sampleCount: cases.length,
    correctCount,
    accuracy,
    cases,
  };
  const filePath = writeRunRecord(config, runRecord);

  api.recordAuditEvent({
    sessionId: context.sessionId,
    runId,
    event: {
      type: 'eval.run.completed',
      benchmark: 'mmlu',
      sampleCount: cases.length,
      correctCount,
      accuracy,
      resultsPath: filePath,
    },
  });

  return formatCompletedRun(runRecord, filePath);
}

export default {
  id: 'evals',
  kind: 'tool',
  register(api) {
    const config = resolveEvalPluginConfig(api.pluginConfig, api.runtime);

    api.registerCommand({
      name: 'eval',
      description:
        'Run benchmark evals with prompt ablations and saved comparable run records',
      async handler(args, context) {
        let command;
        try {
          command = parseEvalArgs(args, config);
        } catch (error) {
          return [
            error instanceof Error ? error.message : String(error),
            '',
            formatEvalUsage(),
          ].join('\n');
        }

        if (command.kind === 'help') {
          return formatEvalUsage();
        }
        if (command.kind === 'runs') {
          return formatRunList(
            listRunRecords(config, {
              benchmark: command.benchmark,
              limit: command.limit,
            }),
          );
        }
        return await runMmluEval(api, config, command, context);
      },
    });

    api.logger.info(
      {
        dataDir: config.dataDir,
        mmluBaseUrl: config.mmluBaseUrl,
      },
      'Eval plugin registered',
    );
  },
};
