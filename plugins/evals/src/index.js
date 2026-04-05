import { formatEvalUsage, parseEvalArgs } from './args.js';
import { resolveEvalPluginConfig } from './config.js';
import { loadJsonlEvalSamples, scoreJsonlResponse } from './jsonl.js';
import { buildMmluSamples, extractAnswerLetter } from './mmlu.js';
import { ensureEvalDirs, listRunRecords, writeRunRecord } from './storage.js';

function buildPromptAblation(omitWorkspaceFiles) {
  return omitWorkspaceFiles.length > 0 ? { omitWorkspaceFiles } : undefined;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatAccuracy(value) {
  return typeof value === 'number' ? formatPercent(value) : 'n/a';
}

function buildProgressBar(completed, total) {
  const safeTotal = Math.max(1, total);
  const width = 20;
  const filled = Math.round((completed / safeTotal) * width);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

function buildEvalCaseSessionId(parentSessionId, runId, caseIndex) {
  return `${parentSessionId}:eval:${runId}:${String(caseIndex).padStart(3, '0')}`;
}

const EVALUATORS = {
  jsonl: {
    description: 'Run prompt/answer eval cases from a local JSONL file.',
    async prepareSamples(_api, _config, command, context) {
      return loadJsonlEvalSamples(command, context);
    },
    scoreResponse(sample, rawResponse, command) {
      return scoreJsonlResponse(sample, rawResponse, command);
    },
    buildRecordFields(command, prepResult) {
      return {
        filePath: prepResult.filePath,
        answerMode: command.answerMode || null,
      };
    },
  },
  mmlu: {
    description: 'Run multiple-choice MMLU benchmark samples.',
    async prepareSamples(_api, config, command) {
      return {
        samples: await buildMmluSamples(config, command),
      };
    },
    scoreResponse(sample, rawResponse) {
      const predictedAnswer = extractAnswerLetter(rawResponse);
      return {
        predicted: predictedAnswer,
        correct: predictedAnswer === sample.answer,
      };
    },
    buildRecordFields(command) {
      return {
        subject: command.subject,
      };
    },
  },
};

function formatCatalog() {
  return [
    'Available evals:',
    ...Object.entries(EVALUATORS).map(
      ([name, evaluator]) => `- ${name}: ${evaluator.description}`,
    ),
  ].join('\n');
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
      const answeredCount =
        typeof record.answeredCount === 'number'
          ? record.answeredCount
          : record.sampleCount;
      const errorCount =
        typeof record.errorCount === 'number' ? record.errorCount : 0;
      return [
        `- ${record.runId} ${record.benchmark} acc=${formatAccuracy(record.accuracy)} answered=${answeredCount}/${record.sampleCount} errors=${errorCount} model=${record.model}`,
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
  return [
    `Eval complete: ${record.benchmark}`,
    `Run ID: ${record.runId}`,
    `Model: ${record.model}`,
    `Samples: ${record.sampleCount}`,
    `Answered: ${record.answeredCount}/${record.sampleCount}`,
    `Errors: ${record.errorCount}`,
    `Accuracy: ${record.correctCount}/${record.answeredCount} (${formatAccuracy(record.accuracy)})`,
    `Prompt mode: ${record.promptMode}`,
    `Prompt ablations: ${ablations}`,
    record.subject ? `Subject: ${record.subject}` : '',
    record.filePath ? `Eval file: ${record.filePath}` : '',
    `Saved: ${filePath}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function runBenchmarkEval(api, config, command, context) {
  const evaluator = EVALUATORS[command.benchmark];
  if (!evaluator) {
    throw new Error(`Unsupported eval benchmark: ${command.benchmark}`);
  }

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
      benchmark: command.benchmark,
      sampleCount: command.n,
      model: targetModel,
      agentId: context.agentId || null,
      promptMode: command.promptMode,
      promptAblation: promptAblation || null,
    },
  });

  const prepResult = await evaluator.prepareSamples(
    api,
    config,
    command,
    context,
  );
  const samples = prepResult.samples;
  const cases = [];

  for (const sample of samples) {
    const caseSessionId = buildEvalCaseSessionId(
      context.sessionId,
      runId,
      sample.caseIndex,
    );
    try {
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
      const scored =
        response.status === 'success'
          ? evaluator.scoreResponse(sample, rawResponse, command)
          : { predicted: null, correct: false };
      const caseRecord = {
        caseIndex: sample.caseIndex,
        sessionId: caseSessionId,
        id: sample.id || null,
        subject: sample.subject || null,
        metadata: sample.metadata || null,
        prompt: sample.prompt,
        expectedAnswer: sample.answer || null,
        expectedAnswers: sample.answers || null,
        predictedAnswer: scored.predicted,
        correct: scored.correct,
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
          benchmark: command.benchmark,
          caseIndex: sample.caseIndex,
          caseSessionId,
          subject: sample.subject || null,
          caseId: sample.id || null,
          predictedAnswer: scored.predicted,
          correct: scored.correct,
          status: response.status,
        },
      });
      if (context.emitProgress) {
        const completed = cases.length;
        await context.emitProgress(
          `${command.benchmark} ${buildProgressBar(completed, samples.length)} ${completed}/${samples.length} (${formatPercent(completed / Math.max(1, samples.length))})`,
        );
      }
    } finally {
      api.stopSessionExecution(caseSessionId);
    }
  }

  const answeredCount = cases.filter(
    (item) => item.status === 'success',
  ).length;
  const errorCount = cases.length - answeredCount;
  const correctCount = cases.filter(
    (item) => item.status === 'success' && item.correct,
  ).length;
  const accuracy = answeredCount > 0 ? correctCount / answeredCount : null;
  const completedAt = new Date().toISOString();
  const runRecord = {
    runId,
    benchmark: command.benchmark,
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
    answeredCount,
    errorCount,
    correctCount,
    accuracy,
    ...evaluator.buildRecordFields(command, prepResult),
    cases,
  };
  const filePath = writeRunRecord(config, runRecord);

  api.recordAuditEvent({
    sessionId: context.sessionId,
    runId,
    event: {
      type: 'eval.run.completed',
      benchmark: command.benchmark,
      sampleCount: cases.length,
      answeredCount,
      errorCount,
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
          command = parseEvalArgs(args, config, Object.keys(EVALUATORS));
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
        if (command.kind === 'catalog') {
          return formatCatalog();
        }
        if (command.kind === 'runs') {
          return formatRunList(
            listRunRecords(config, {
              benchmark: command.benchmark,
              limit: command.limit,
            }),
          );
        }
        return await runBenchmarkEval(api, config, command, context);
      },
    });

    api.logger.info(
      {
        dataDir: config.dataDir,
        mmluDataUrl: config.mmluDataUrl,
        benchmarks: Object.keys(EVALUATORS),
      },
      'Eval plugin registered',
    );
  },
};
