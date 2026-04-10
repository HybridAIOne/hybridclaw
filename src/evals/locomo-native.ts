import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { initDatabase, storeSemanticMemory } from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { buildSessionKey } from '../session/session-key.js';
import type { SemanticMemoryEntry } from '../types/memory.js';
import type { Session } from '../types/session.js';
import {
  buildDefaultEvalProfile,
  type EvalProfile,
  encodeEvalProfileModel,
  parseEvalProfileModel,
} from './eval-profile.js';
import { scoreOfficialLocomoAnswer } from './locomo-official-scoring.js';

const LOCOMO_DATASET_COMMIT = '3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376';
const LOCOMO_DATASET_URL = `https://raw.githubusercontent.com/snap-research/locomo/${LOCOMO_DATASET_COMMIT}/data/locomo10.json`;
const LOCOMO_DATASET_SHA256 =
  '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4';
const LOCOMO_DATASET_FILENAME = 'locomo10.json';
const LOCOMO_SETUP_MARKER = '.hybridclaw-setup-ok';
const DEFAULT_TOKEN_BUDGET = 4000;
const ANSWER_BUFFER_TOKENS = 64;
const DEFAULT_OPENAI_BASE_URL = 'http://127.0.0.1:9090/v1';
const DEFAULT_EVAL_MODEL = 'hybridai/gpt-4.1-mini';

const CONVERSATION_START_PROMPT =
  'Below is a conversation between two people: {speakerA} and {speakerB}. The conversation takes place over multiple days and the date of each conversation is written at the beginning of the conversation.\n\n';

const QA_PROMPT = `
Based on the above context, write an answer in the form of a short phrase for the following question. Answer with exact words from the context whenever possible.

Question: {question}
Short answer:
`.trim();

const QA_PROMPT_CATEGORY_5 = `
Based on the above context, answer the following question.

Question: {question}
Short answer:
`.trim();

type LocomoOperation = 'setup' | 'run';
type LocomoEvaluationMode = 'qa' | 'retrieval';
type LocomoAgentMode = 'conversation-fresh' | 'current-agent' | 'fresh-request';

interface LocomoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  blip_caption?: string;
}

interface LocomoQA {
  question: string;
  answer?: unknown;
  adversarial_answer?: string;
  evidence?: string[];
  category: number;
}

interface LocomoSample {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: LocomoQA[];
}

interface LocomoRunnerOptions {
  operation: LocomoOperation;
  installDir: string;
  budgetTokens: number;
  numSamples: number | null;
  maxQuestions: number | null;
  mode: LocomoEvaluationMode;
  agentMode: LocomoAgentMode;
}

interface LocomoGatewayRuntime {
  baseUrl: string;
  apiKey: string;
  model: string;
  baseModel: string;
  profile: EvalProfile;
}

interface LocomoUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  responsesWithUsage: number;
}

interface LocomoCategoryAggregate {
  meanScore: number;
  questionCount: number;
  contextF1: number | null;
}

interface LocomoQuestionPrediction {
  category: number;
  question: string;
  answer: string;
  prediction: string;
  score: number;
  evidence: string[];
  contextF1?: number | null;
  retrievedSourceMessageIds?: number[];
}

interface LocomoSamplePrediction {
  sampleId: string;
  questionCount: number;
  meanScore: number;
  meanContextF1: number | null;
  qa: LocomoQuestionPrediction[];
}

interface LocomoRunSummary {
  suite: 'locomo';
  mode: LocomoEvaluationMode;
  dataset: string;
  generatedAt: string;
  model: string | null;
  budgetTokens: number;
  sampleCount: number;
  questionCount: number;
  overallScore: number;
  contextF1: number | null;
  resultPath: string;
  predictionsPath: string;
  categories: Record<string, LocomoCategoryAggregate>;
  tokenUsage: LocomoUsageSummary | null;
  samples: Array<{
    sampleId: string;
    questionCount: number;
    meanScore: number;
  }>;
}

interface LocomoProgressSummary {
  suite: 'locomo';
  mode: LocomoEvaluationMode;
  dataset: string;
  updatedAt: string;
  model: string | null;
  budgetTokens: number;
  sampleCount: number;
  completedSampleCount: number;
  questionCount: number;
  completedQuestionCount: number;
  overallScore: number;
  contextF1: number | null;
  currentSampleId: string | null;
  currentSampleQuestionCount: number | null;
  currentSampleQuestionTotal: number | null;
  progressPath: string;
  resultPath: string;
  predictionsPath: string;
  categories: Record<string, LocomoCategoryAggregate>;
  tokenUsage: LocomoUsageSummary | null;
}

interface LocomoChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface LocomoCategoryRunningAggregate {
  scoreTotal: number;
  contextF1Total: number;
  questionCount: number;
}

interface LocomoRetrievalSession {
  session: Session;
  messageIdByDiaId: Map<string, number>;
}

interface LocomoPreparedQuestion {
  prompt: string;
  scoreCategory: number;
  categoryFiveAnswerKey: Record<'a' | 'b', string> | null;
}

export async function runLocomoNativeCli(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  if (options.operation === 'setup') {
    await runSetup(options);
    return;
  }
  await runEvaluation(options);
}

function parseArgs(argv: string[]): LocomoRunnerOptions {
  let operation: LocomoOperation | null = null;
  let installDir = '';
  let budgetTokens = DEFAULT_TOKEN_BUDGET;
  let numSamples: number | null = null;
  let maxQuestions: number | null = null;
  let mode: LocomoEvaluationMode = 'qa';
  let agentMode: LocomoAgentMode = 'conversation-fresh';

  for (let index = 0; index < argv.length; index += 1) {
    const current = String(argv[index] || '').trim();
    if (!current) continue;
    if (current === 'setup' || current === 'run') {
      operation = current;
      continue;
    }

    const [flag, inlineValue] = splitInlineFlag(current);
    const nextValue = () => inlineValue || String(argv[index + 1] || '').trim();

    if (flag === '--install-dir') {
      installDir = nextValue();
      if (!inlineValue) index += 1;
      continue;
    }
    if (flag === '--budget') {
      budgetTokens = clampPositiveInt(nextValue(), DEFAULT_TOKEN_BUDGET);
      if (!inlineValue) index += 1;
      continue;
    }
    if (flag === '--num-samples') {
      const parsed = clampPositiveInt(nextValue(), 0);
      numSamples = parsed > 0 ? parsed : null;
      if (!inlineValue) index += 1;
      continue;
    }
    if (flag === '--max-questions') {
      const parsed = clampPositiveInt(nextValue(), 0);
      maxQuestions = parsed > 0 ? parsed : null;
      if (!inlineValue) index += 1;
      continue;
    }
    if (flag === '--mode') {
      const value = nextValue().toLowerCase();
      if (value === 'qa' || value === 'retrieval') {
        mode = value;
      } else {
        throw new Error(`Unsupported LOCOMO mode \`${value || '(empty)'}\`.`);
      }
      if (!inlineValue) index += 1;
      continue;
    }
    if (flag === '--agent-mode') {
      const value = nextValue().toLowerCase();
      if (
        value === 'conversation-fresh' ||
        value === 'current-agent' ||
        value === 'fresh-request'
      ) {
        agentMode = value;
      } else {
        throw new Error(
          `Unsupported LOCOMO agent mode \`${value || '(empty)'}\`.`,
        );
      }
      if (!inlineValue) index += 1;
      continue;
    }

    throw new Error(`Unknown LOCOMO option: \`${current}\`.`);
  }

  if (!operation) {
    throw new Error('Missing LOCOMO operation. Use `setup` or `run`.');
  }
  if (!installDir) {
    throw new Error('Missing required `--install-dir`.');
  }

  return {
    operation,
    installDir: path.resolve(installDir),
    budgetTokens,
    numSamples,
    maxQuestions,
    mode,
    agentMode,
  };
}

function splitInlineFlag(value: string): [string, string] {
  const separator = value.indexOf('=');
  if (separator < 0) return [value, ''];
  return [value.slice(0, separator), value.slice(separator + 1).trim()];
}

function clampPositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getMarkerPath(installDir: string): string {
  return path.join(installDir, LOCOMO_SETUP_MARKER);
}

function getDatasetPath(installDir: string): string {
  return path.join(installDir, 'data', LOCOMO_DATASET_FILENAME);
}

function getProgressPath(jobDir: string): string {
  return path.join(jobDir, 'progress.json');
}

async function runSetup(options: LocomoRunnerOptions): Promise<void> {
  fs.mkdirSync(options.installDir, { recursive: true });
  fs.mkdirSync(path.dirname(getDatasetPath(options.installDir)), {
    recursive: true,
  });

  const datasetPath = getDatasetPath(options.installDir);
  if (!fs.existsSync(datasetPath)) {
    console.log(`Downloading dataset from ${LOCOMO_DATASET_URL}`);
    const response = await fetch(LOCOMO_DATASET_URL);
    if (!response.ok) {
      throw new Error(
        `Failed to download LOCOMO dataset: HTTP ${response.status}`,
      );
    }
    const rawBuffer = Buffer.from(await response.arrayBuffer());
    verifyDownloadedDataset(rawBuffer, response.url);
    const raw = rawBuffer.toString('utf-8');
    if (!raw.trim().startsWith('[')) {
      throw new Error('Downloaded LOCOMO dataset is not valid JSON.');
    }
    fs.writeFileSync(datasetPath, rawBuffer);
  } else {
    console.log(`Dataset already present at ${datasetPath}`);
  }

  const sampleCount = loadSamples(datasetPath).length;
  fs.writeFileSync(getMarkerPath(options.installDir), 'ok\n', 'utf-8');

  console.log(`Install dir: ${options.installDir}`);
  console.log(`Dataset path: ${datasetPath}`);
  console.log(`Samples: ${sampleCount}`);
  console.log('LOCOMO setup complete.');
}

async function runEvaluation(options: LocomoRunnerOptions): Promise<void> {
  const datasetPath = getDatasetPath(options.installDir);
  if (
    !fs.existsSync(getMarkerPath(options.installDir)) ||
    !fs.existsSync(datasetPath)
  ) {
    throw new Error(
      'LOCOMO is not set up. Run `setup` first, or use `/eval locomo setup`.',
    );
  }

  const runtime = readGatewayRuntime();
  const allSamples = loadSamples(datasetPath);
  const selectedSamples =
    options.numSamples && options.numSamples > 0
      ? allSamples.slice(0, options.numSamples)
      : allSamples;
  const plannedSamples = applyQuestionLimit(
    selectedSamples,
    options.maxQuestions,
  );
  const totalQuestionCount = plannedSamples.reduce(
    (total, sample) => total + sample.qa.length,
    0,
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jobDir = path.join(options.installDir, 'jobs', timestamp);
  fs.mkdirSync(jobDir, { recursive: true });
  const progressPath = getProgressPath(jobDir);
  const resultPath = path.join(jobDir, 'result.json');
  const predictionsPath = path.join(jobDir, 'predictions.json');
  const retrievalDbPath = path.join(jobDir, 'retrieval-memory.db');

  console.log(`Job dir: ${jobDir}`);
  console.log(`Dataset: ${datasetPath}`);
  console.log(`Mode: ${options.mode}`);
  if (options.mode === 'qa') {
    console.log(`Model: ${runtime.model}`);
  } else {
    console.log(`Memory DB: ${retrievalDbPath}`);
  }
  console.log(`Samples: ${plannedSamples.length}`);
  console.log(`Budget: ${options.budgetTokens}`);
  if (options.mode === 'qa') {
    console.log(`Agent mode: ${options.agentMode}`);
  }
  if (options.maxQuestions) {
    console.log(`Max questions: ${options.maxQuestions}`);
  }
  console.log(`Questions planned: ${totalQuestionCount}`);

  if (options.mode === 'retrieval') {
    initDatabase({ quiet: true, dbPath: retrievalDbPath });
  }

  const predictions: LocomoSamplePrediction[] = [];
  const categories = new Map<number, LocomoCategoryRunningAggregate>();
  const usageTotals: LocomoUsageSummary = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    responsesWithUsage: 0,
  };
  let questionCount = 0;
  let scoreTotal = 0;
  let contextF1Total = 0;
  let completedSampleCount = 0;
  const runTag = path.basename(jobDir);

  writeProgressFile({
    progressPath,
    resultPath,
    predictionsPath,
    mode: options.mode,
    datasetPath,
    model: options.mode === 'qa' ? runtime.model : null,
    budgetTokens: options.budgetTokens,
    sampleCount: plannedSamples.length,
    completedSampleCount,
    questionCount: totalQuestionCount,
    completedQuestionCount: questionCount,
    scoreTotal,
    contextF1Total,
    categories,
    usageTotals,
    currentSampleId: null,
    currentSampleQuestionCount: null,
    currentSampleQuestionTotal: null,
  });

  for (const sample of plannedSamples) {
    const samplePrediction =
      options.mode === 'retrieval'
        ? await evaluateRetrievalSample({
            sample,
            budgetTokens: options.budgetTokens,
            categories,
            session: ingestSampleIntoNativeMemory({
              sample,
              runTag,
              agentMode: options.agentMode,
              runtime,
            }),
            onQuestionProgress: ({ samplePrediction }) => {
              const completedQuestionCount =
                questionCount + samplePrediction.qa.length;
              const partialScoreTotal =
                scoreTotal +
                samplePrediction.qa.reduce((total, qa) => total + qa.score, 0);
              const partialContextF1Total =
                contextF1Total +
                samplePrediction.qa.reduce(
                  (total, qa) => total + (qa.contextF1 || 0),
                  0,
                );
              writeProgressFile({
                progressPath,
                resultPath,
                predictionsPath,
                mode: options.mode,
                datasetPath,
                model: null,
                budgetTokens: options.budgetTokens,
                sampleCount: plannedSamples.length,
                completedSampleCount,
                questionCount: totalQuestionCount,
                completedQuestionCount,
                scoreTotal: partialScoreTotal,
                contextF1Total: partialContextF1Total,
                categories,
                usageTotals,
                currentSampleId: samplePrediction.sampleId,
                currentSampleQuestionCount: samplePrediction.qa.length,
                currentSampleQuestionTotal: samplePrediction.questionCount,
              });
            },
          })
        : await evaluateSample({
            runtime,
            requestModel: resolveSampleRequestModel({
              runtime,
              agentMode: options.agentMode,
              sampleId: sample.sample_id,
              runTag,
            }),
            sample,
            budgetTokens: options.budgetTokens,
            usageTotals,
            categories,
            onQuestionProgress: ({ samplePrediction }) => {
              const completedQuestionCount =
                questionCount + samplePrediction.qa.length;
              const partialScoreTotal =
                scoreTotal +
                samplePrediction.qa.reduce((total, qa) => total + qa.score, 0);
              writeProgressFile({
                progressPath,
                resultPath,
                predictionsPath,
                mode: options.mode,
                datasetPath,
                model: runtime.model,
                budgetTokens: options.budgetTokens,
                sampleCount: plannedSamples.length,
                completedSampleCount,
                questionCount: totalQuestionCount,
                completedQuestionCount,
                scoreTotal: partialScoreTotal,
                contextF1Total,
                categories,
                usageTotals,
                currentSampleId: samplePrediction.sampleId,
                currentSampleQuestionCount: samplePrediction.qa.length,
                currentSampleQuestionTotal: samplePrediction.questionCount,
              });
            },
          });
    predictions.push(samplePrediction);
    questionCount += samplePrediction.questionCount;
    scoreTotal += samplePrediction.meanScore * samplePrediction.questionCount;
    contextF1Total +=
      (samplePrediction.meanContextF1 || 0) * samplePrediction.questionCount;
    completedSampleCount += 1;
    writeProgressFile({
      progressPath,
      resultPath,
      predictionsPath,
      mode: options.mode,
      datasetPath,
      model: options.mode === 'qa' ? runtime.model : null,
      budgetTokens: options.budgetTokens,
      sampleCount: plannedSamples.length,
      completedSampleCount,
      questionCount: totalQuestionCount,
      completedQuestionCount: questionCount,
      scoreTotal,
      contextF1Total,
      categories,
      usageTotals,
      currentSampleId:
        completedSampleCount < plannedSamples.length
          ? plannedSamples[completedSampleCount]?.sample_id || null
          : null,
      currentSampleQuestionCount: null,
      currentSampleQuestionTotal:
        completedSampleCount < plannedSamples.length
          ? plannedSamples[completedSampleCount]?.qa.length || null
          : null,
    });
  }

  fs.writeFileSync(
    predictionsPath,
    JSON.stringify(predictions, null, 2),
    'utf-8',
  );

  const categorySummaries: Record<string, LocomoCategoryAggregate> = {};
  for (const [category, aggregate] of categories.entries()) {
    categorySummaries[String(category)] = {
      meanScore: roundMetric(
        aggregate.scoreTotal / Math.max(aggregate.questionCount, 1),
      ),
      questionCount: aggregate.questionCount,
      contextF1:
        options.mode === 'retrieval'
          ? roundMetric(
              aggregate.contextF1Total / Math.max(aggregate.questionCount, 1),
            )
          : null,
    };
  }

  const summary: LocomoRunSummary = {
    suite: 'locomo',
    mode: options.mode,
    dataset: path.basename(datasetPath),
    generatedAt: new Date().toISOString(),
    model: options.mode === 'qa' ? runtime.model : null,
    budgetTokens: options.budgetTokens,
    sampleCount: plannedSamples.length,
    questionCount,
    overallScore: roundMetric(scoreTotal / Math.max(questionCount, 1)),
    contextF1:
      options.mode === 'retrieval'
        ? roundMetric(contextF1Total / Math.max(questionCount, 1))
        : null,
    resultPath,
    predictionsPath,
    categories: categorySummaries,
    tokenUsage:
      options.mode === 'qa' && usageTotals.responsesWithUsage > 0
        ? usageTotals
        : null,
    samples: predictions.map((samplePrediction) => ({
      sampleId: samplePrediction.sampleId,
      questionCount: samplePrediction.questionCount,
      meanScore: samplePrediction.meanScore,
    })),
  };

  fs.writeFileSync(resultPath, JSON.stringify(summary, null, 2), 'utf-8');
  printSummaryTable(summary);
}

function applyQuestionLimit(
  samples: LocomoSample[],
  maxQuestions: number | null,
): LocomoSample[] {
  if (!maxQuestions || maxQuestions <= 0) {
    return samples.map((sample) => ({
      ...sample,
      qa: Array.isArray(sample.qa) ? [...sample.qa] : [],
    }));
  }

  const selected: LocomoSample[] = [];
  let remaining = maxQuestions;
  for (const sample of samples) {
    if (remaining <= 0) break;
    const qa = Array.isArray(sample.qa) ? sample.qa.slice(0, remaining) : [];
    if (qa.length === 0) continue;
    selected.push({
      ...sample,
      qa,
    });
    remaining -= qa.length;
  }
  return selected;
}

function writeProgressFile(params: {
  progressPath: string;
  resultPath: string;
  predictionsPath: string;
  mode: LocomoEvaluationMode;
  datasetPath: string;
  model: string | null;
  budgetTokens: number;
  sampleCount: number;
  completedSampleCount: number;
  questionCount: number;
  completedQuestionCount: number;
  scoreTotal: number;
  contextF1Total: number;
  categories: Map<number, LocomoCategoryRunningAggregate>;
  usageTotals: LocomoUsageSummary;
  currentSampleId: string | null;
  currentSampleQuestionCount: number | null;
  currentSampleQuestionTotal: number | null;
}): void {
  const categorySummaries: Record<string, LocomoCategoryAggregate> = {};
  for (const [category, aggregate] of params.categories.entries()) {
    categorySummaries[String(category)] = {
      meanScore: roundMetric(
        aggregate.scoreTotal / Math.max(aggregate.questionCount, 1),
      ),
      questionCount: aggregate.questionCount,
      contextF1:
        params.mode === 'retrieval'
          ? roundMetric(
              aggregate.contextF1Total / Math.max(aggregate.questionCount, 1),
            )
          : null,
    };
  }
  const progress: LocomoProgressSummary = {
    suite: 'locomo',
    mode: params.mode,
    dataset: path.basename(params.datasetPath),
    updatedAt: new Date().toISOString(),
    model: params.model,
    budgetTokens: params.budgetTokens,
    sampleCount: params.sampleCount,
    completedSampleCount: params.completedSampleCount,
    questionCount: params.questionCount,
    completedQuestionCount: params.completedQuestionCount,
    overallScore: roundMetric(
      params.scoreTotal / Math.max(params.completedQuestionCount, 1),
    ),
    contextF1:
      params.mode === 'retrieval'
        ? roundMetric(
            params.contextF1Total / Math.max(params.completedQuestionCount, 1),
          )
        : null,
    currentSampleId: params.currentSampleId,
    currentSampleQuestionCount: params.currentSampleQuestionCount,
    currentSampleQuestionTotal: params.currentSampleQuestionTotal,
    progressPath: params.progressPath,
    resultPath: params.resultPath,
    predictionsPath: params.predictionsPath,
    categories: categorySummaries,
    tokenUsage:
      params.mode === 'qa' && params.usageTotals.responsesWithUsage > 0
        ? params.usageTotals
        : null,
  };
  fs.writeFileSync(
    params.progressPath,
    JSON.stringify(progress, null, 2),
    'utf-8',
  );
}

function readGatewayRuntime(): LocomoGatewayRuntime {
  const baseUrl = String(process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL)
    .trim()
    .replace(/\/+$/, '');
  const apiKey = String(
    process.env.OPENAI_API_KEY || 'hybridclaw-local',
  ).trim();
  const model = String(
    process.env.HYBRIDCLAW_EVAL_MODEL || DEFAULT_EVAL_MODEL,
  ).trim();
  const parsed = parseEvalProfileModel(model || DEFAULT_EVAL_MODEL);

  return {
    baseUrl: baseUrl || DEFAULT_OPENAI_BASE_URL,
    apiKey: apiKey || 'hybridclaw-local',
    model: model || DEFAULT_EVAL_MODEL,
    baseModel: parsed.model || DEFAULT_EVAL_MODEL,
    profile: parsed.profile || buildDefaultEvalProfile(),
  };
}

function resolveSampleRequestModel(params: {
  runtime: LocomoGatewayRuntime;
  agentMode: LocomoAgentMode;
  sampleId: string;
  runTag: string;
}): string {
  if (params.agentMode === 'current-agent') {
    return params.runtime.model;
  }
  if (params.agentMode === 'fresh-request') {
    return encodeEvalProfileModel(params.runtime.baseModel, {
      workspaceMode: 'fresh-agent',
      ablateSystemPrompt: params.runtime.profile.ablateSystemPrompt,
      includePromptParts: [...params.runtime.profile.includePromptParts],
      omitPromptParts: [...params.runtime.profile.omitPromptParts],
    });
  }

  return encodeEvalProfileModel(params.runtime.baseModel, {
    workspaceMode: 'current-agent',
    ablateSystemPrompt: params.runtime.profile.ablateSystemPrompt,
    includePromptParts: [...params.runtime.profile.includePromptParts],
    omitPromptParts: [...params.runtime.profile.omitPromptParts],
    agentId: buildConversationAgentId(params.sampleId, params.runTag),
  });
}

function buildConversationAgentId(sampleId: string, runTag: string): string {
  const sanitizedSampleId = String(sampleId || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const digest = createHash('sha1')
    .update(`${runTag}:${sampleId}`)
    .digest('hex')
    .slice(0, 12);
  return `locomo-${sanitizedSampleId || 'sample'}-${digest}`;
}

function loadSamples(datasetPath: string): LocomoSample[] {
  const raw = fs.readFileSync(datasetPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected LOCOMO dataset array in ${datasetPath}.`);
  }
  return parsed as LocomoSample[];
}

function verifyDownloadedDataset(
  rawBuffer: Uint8Array,
  responseUrl: string | null | undefined,
): void {
  if (!responseUrl || responseUrl.trim() !== LOCOMO_DATASET_URL) {
    return;
  }
  const actualSha256 = createHash('sha256').update(rawBuffer).digest('hex');
  if (actualSha256 !== LOCOMO_DATASET_SHA256) {
    throw new Error(
      `Downloaded LOCOMO dataset failed SHA-256 verification (expected ${LOCOMO_DATASET_SHA256}, got ${actualSha256}).`,
    );
  }
}

async function evaluateSample(params: {
  runtime: LocomoGatewayRuntime;
  requestModel: string;
  sample: LocomoSample;
  budgetTokens: number;
  usageTotals: LocomoUsageSummary;
  categories: Map<number, LocomoCategoryRunningAggregate>;
  onQuestionProgress?: (params: {
    samplePrediction: LocomoSamplePrediction;
  }) => void;
}): Promise<LocomoSamplePrediction> {
  const qaPredictions: LocomoQuestionPrediction[] = [];
  const sampleQuestionCount = (params.sample.qa || []).length;

  for (const qa of params.sample.qa || []) {
    const prepared = buildQuestionPrompt(
      params.sample,
      qa,
      params.budgetTokens,
    );
    const completion = await requestModelAnswer({
      runtime: params.runtime,
      model: params.requestModel,
      prompt: prepared.prompt,
      user: `locomo-${params.sample.sample_id}`,
    });
    mergeUsage(params.usageTotals, completion.usage);

    const answer = answerToString(qa);
    const prediction =
      prepared.scoreCategory === 5
        ? normalizeCategoryFivePrediction(
            completion.content,
            prepared.categoryFiveAnswerKey,
          )
        : normalizeModelPrediction(completion.content);
    const score = scoreLocomoAnswer(qa, prediction);

    qaPredictions.push({
      category: prepared.scoreCategory,
      question: qa.question,
      answer,
      prediction,
      score,
      evidence: Array.isArray(qa.evidence) ? qa.evidence : [],
    });

    const existing = params.categories.get(prepared.scoreCategory) || {
      scoreTotal: 0,
      contextF1Total: 0,
      questionCount: 0,
    };
    existing.scoreTotal += score;
    existing.questionCount += 1;
    params.categories.set(prepared.scoreCategory, existing);
    params.onQuestionProgress?.({
      samplePrediction: {
        sampleId: params.sample.sample_id,
        questionCount: sampleQuestionCount,
        meanScore: roundMetric(
          qaPredictions.reduce((total, entry) => total + entry.score, 0) /
            Math.max(qaPredictions.length, 1),
        ),
        meanContextF1: null,
        qa: [...qaPredictions],
      },
    });
  }

  const questionCount = qaPredictions.length;
  const meanScore = roundMetric(
    qaPredictions.reduce((total, qa) => total + qa.score, 0) /
      Math.max(questionCount, 1),
  );
  return {
    sampleId: params.sample.sample_id,
    questionCount,
    meanScore,
    meanContextF1: null,
    qa: qaPredictions,
  };
}

async function evaluateRetrievalSample(params: {
  sample: LocomoSample;
  budgetTokens: number;
  categories: Map<number, LocomoCategoryRunningAggregate>;
  session: LocomoRetrievalSession;
  onQuestionProgress?: (params: {
    samplePrediction: LocomoSamplePrediction;
  }) => void;
}): Promise<LocomoSamplePrediction> {
  const qaPredictions: LocomoQuestionPrediction[] = [];
  const sampleQuestionCount = (params.sample.qa || []).length;

  for (const qa of params.sample.qa || []) {
    const memoryContext = memoryService.buildPromptMemoryContext({
      session: params.session.session,
      query: String(qa.question || '').trim(),
      semanticLimit: 12,
    });
    const recalledMemories = budgetTruncateSemanticMemories(
      memoryContext.semanticMemories,
      params.budgetTokens,
    );
    const recalledContext = recalledMemories
      .map((entry) => entry.content)
      .join('\n\n')
      .trim();
    const retrievedSourceMessageIds = recalledMemories
      .map((entry) => entry.source_message_id)
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value) && value > 0,
      );
    const hitRate = computeRetrievalHitRate({
      evidence: Array.isArray(qa.evidence) ? qa.evidence : [],
      messageIdByDiaId: params.session.messageIdByDiaId,
      retrievedSourceMessageIds,
    });
    const contextF1 = computeContextTokenF1(
      recalledContext,
      answerToString(qa),
    );

    qaPredictions.push({
      category: qa.category,
      question: qa.question,
      answer: answerToString(qa),
      prediction: recalledContext,
      score: hitRate,
      evidence: Array.isArray(qa.evidence) ? qa.evidence : [],
      contextF1,
      retrievedSourceMessageIds,
    });

    const existing = params.categories.get(qa.category) || {
      scoreTotal: 0,
      contextF1Total: 0,
      questionCount: 0,
    };
    existing.scoreTotal += hitRate;
    existing.contextF1Total += contextF1;
    existing.questionCount += 1;
    params.categories.set(qa.category, existing);
    params.onQuestionProgress?.({
      samplePrediction: {
        sampleId: params.sample.sample_id,
        questionCount: sampleQuestionCount,
        meanScore: roundMetric(
          qaPredictions.reduce((total, entry) => total + entry.score, 0) /
            Math.max(qaPredictions.length, 1),
        ),
        meanContextF1: roundMetric(
          qaPredictions.reduce(
            (total, entry) => total + (entry.contextF1 || 0),
            0,
          ) / Math.max(qaPredictions.length, 1),
        ),
        qa: [...qaPredictions],
      },
    });
  }

  const questionCount = qaPredictions.length;
  return {
    sampleId: params.sample.sample_id,
    questionCount,
    meanScore: roundMetric(
      qaPredictions.reduce((total, entry) => total + entry.score, 0) /
        Math.max(questionCount, 1),
    ),
    meanContextF1: roundMetric(
      qaPredictions.reduce(
        (total, entry) => total + (entry.contextF1 || 0),
        0,
      ) / Math.max(questionCount, 1),
    ),
    qa: qaPredictions,
  };
}

function buildQuestionPrompt(
  sample: LocomoSample,
  qa: LocomoQA,
  budgetTokens: number,
): LocomoPreparedQuestion {
  let question = String(qa.question || '').trim();
  if (qa.category === 2) {
    question += ' Use DATE of CONVERSATION to answer with an approximate date.';
  }
  if (qa.category === 5) {
    question = buildCategoryFiveQuestion(sample, qa);
  }

  const speakers = getSpeakerNames(sample);
  const conversationStart = CONVERSATION_START_PROMPT.replace(
    '{speakerA}',
    speakers[0],
  ).replace('{speakerB}', speakers[1]);
  const qaPromptTemplate = qa.category === 5 ? QA_PROMPT_CATEGORY_5 : QA_PROMPT;
  const questionPrompt = qaPromptTemplate.replace('{question}', question);
  const availableConversationTokens = Math.max(
    1,
    budgetTokens -
      estimateTokenCount(conversationStart) -
      estimateTokenCount(questionPrompt) -
      ANSWER_BUFFER_TOKENS,
  );
  const conversation = selectConversationContext(
    sample.conversation,
    availableConversationTokens,
  );

  return {
    prompt: `${conversationStart}${conversation}\n\n${questionPrompt}`.trim(),
    scoreCategory: qa.category,
    categoryFiveAnswerKey:
      qa.category === 5 ? buildCategoryFiveAnswerKey(sample, qa) : null,
  };
}

function buildCategoryFiveQuestion(sample: LocomoSample, qa: LocomoQA): string {
  const answerKey = buildCategoryFiveAnswerKey(sample, qa);
  return `${qa.question} Select the correct answer: (a) ${answerKey.a} (b) ${answerKey.b}.`;
}

function buildCategoryFiveAnswerKey(
  sample: LocomoSample,
  qa: LocomoQA,
): Record<'a' | 'b', string> {
  const answer = answerToString(qa) || 'No information available';
  const notMentioned = 'Not mentioned in the conversation';
  const answerFirst = hashText(`${sample.sample_id}:${qa.question}`) % 2 === 0;
  return answerFirst
    ? { a: answer, b: notMentioned }
    : { a: notMentioned, b: answer };
}

function getSpeakerNames(sample: LocomoSample): [string, string] {
  const explicitA = String(sample.conversation.speaker_a || '').trim();
  const explicitB = String(sample.conversation.speaker_b || '').trim();
  if (explicitA && explicitB) {
    return [explicitA, explicitB];
  }

  const discovered: string[] = [];
  for (const turn of flattenConversationTurns(sample.conversation)) {
    const speaker = turn.speaker.trim();
    if (!speaker || discovered.includes(speaker)) continue;
    discovered.push(speaker);
    if (discovered.length === 2) break;
  }

  return [
    discovered[0] || explicitA || 'Speaker A',
    discovered[1] || explicitB || 'Speaker B',
  ];
}

function flattenConversationTurns(
  conversation: Record<string, unknown>,
): Array<LocomoTurn & { sessionNum: number; dateTime: string }> {
  const sessionNames = Object.keys(conversation || {})
    .filter((key) => /^session_\d+$/.test(key))
    .sort((left, right) => {
      const leftNum = Number.parseInt(left.slice('session_'.length), 10) || 0;
      const rightNum = Number.parseInt(right.slice('session_'.length), 10) || 0;
      return leftNum - rightNum;
    });
  const turns: Array<LocomoTurn & { sessionNum: number; dateTime: string }> =
    [];

  for (const sessionName of sessionNames) {
    const sessionNum =
      Number.parseInt(sessionName.slice('session_'.length), 10) || 0;
    const dateTime = String(
      conversation[`session_${sessionNum}_date_time`] || '',
    ).trim();
    const rawTurns = conversation[sessionName];
    if (!Array.isArray(rawTurns)) continue;

    for (const entry of rawTurns) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const speaker = String(record.speaker || '').trim();
      const diaId = String(record.dia_id || '').trim();
      const text = String(record.text || '').trim();
      if (!speaker || !diaId || !text) continue;
      turns.push({
        sessionNum,
        dateTime,
        speaker,
        dia_id: diaId,
        text,
        ...(typeof record.blip_caption === 'string' &&
        record.blip_caption.trim().length > 0
          ? { blip_caption: record.blip_caption.trim() }
          : {}),
      });
    }
  }

  return turns;
}

function selectConversationContext(
  conversation: Record<string, unknown>,
  maxTokens: number,
): string {
  const chronologicalTurns = flattenConversationTurns(conversation);
  const selected: Array<LocomoTurn & { sessionNum: number; dateTime: string }> =
    [];
  let totalTokens = 0;

  for (let index = chronologicalTurns.length - 1; index >= 0; index -= 1) {
    const turn = chronologicalTurns[index];
    const headerTokens =
      selected.length === 0 || selected[0].sessionNum !== turn.sessionNum
        ? estimateTokenCount(`DATE: ${turn.dateTime}\nCONVERSATION:\n`)
        : 0;
    const turnTokens = estimateTokenCount(formatConversationTurn(turn));
    if (
      totalTokens + headerTokens + turnTokens > maxTokens &&
      selected.length
    ) {
      break;
    }
    selected.unshift(turn);
    totalTokens += headerTokens + turnTokens;
  }

  if (selected.length === 0) {
    const lastTurn = chronologicalTurns.at(-1);
    return lastTurn
      ? `DATE: ${lastTurn.dateTime || 'unknown'}\nCONVERSATION:\n${formatConversationTurn(lastTurn)}`.trim()
      : '';
  }

  const sections: string[] = [];
  let currentSessionNum: number | null = null;
  let currentDateTime = '';
  let currentTurns: string[] = [];

  for (const turn of selected) {
    if (currentSessionNum !== turn.sessionNum) {
      if (currentTurns.length > 0) {
        sections.push(
          `DATE: ${currentDateTime}\nCONVERSATION:\n${currentTurns.join('')}`.trim(),
        );
      }
      currentSessionNum = turn.sessionNum;
      currentDateTime = turn.dateTime || 'unknown';
      currentTurns = [];
    }
    currentTurns.push(formatConversationTurn(turn));
  }

  if (currentTurns.length > 0) {
    sections.push(
      `DATE: ${currentDateTime}\nCONVERSATION:\n${currentTurns.join('')}`.trim(),
    );
  }

  return sections.join('\n\n').trim();
}

function formatConversationTurn(turn: LocomoTurn): string {
  const base = `${turn.speaker} said, "${turn.text}"`;
  if (turn.blip_caption) {
    return `${base} and shared ${turn.blip_caption}.\n`;
  }
  return `${base}\n`;
}

function ingestSampleIntoNativeMemory(params: {
  sample: LocomoSample;
  runTag: string;
  agentMode: LocomoAgentMode;
  runtime: LocomoGatewayRuntime;
}): LocomoRetrievalSession {
  const agentId = resolveRetrievalAgentId(params);
  const sessionId = buildSessionKey(
    agentId,
    'locomo',
    'dm',
    `${params.runTag}-${params.sample.sample_id}`,
  );
  const session = memoryService.getOrCreateSession(
    sessionId,
    null,
    'locomo',
    agentId,
  );
  const messageIdByDiaId = new Map<string, number>();
  const [speakerA, speakerB] = getSpeakerNames(params.sample);

  for (const turn of flattenConversationTurns(params.sample.conversation)) {
    const role = turn.speaker === speakerB ? 'assistant' : 'user';
    const content = formatRetrievalMemoryTurn(turn);
    const messageId = memoryService.storeMessage({
      sessionId,
      userId: `locomo:${turn.speaker.toLowerCase().replace(/\s+/g, '-')}`,
      username: turn.speaker,
      role,
      content,
    });
    messageIdByDiaId.set(normalizeDiaId(turn.dia_id), messageId);
    storeSemanticMemory({
      sessionId,
      role,
      source: 'locomo-retrieval',
      scope: 'episodic',
      metadata: {
        sampleId: params.sample.sample_id,
        diaId: turn.dia_id,
        speaker: turn.speaker,
        speakerA,
        speakerB,
      },
      content,
      confidence: 1,
      embedding: buildHashedTokenEmbedding(content),
      sourceMessageId: messageId,
    });
  }

  return {
    session,
    messageIdByDiaId,
  };
}

function resolveRetrievalAgentId(params: {
  sample: LocomoSample;
  runTag: string;
  agentMode: LocomoAgentMode;
  runtime: LocomoGatewayRuntime;
}): string {
  if (params.agentMode === 'current-agent') {
    return params.runtime.profile.agentId || 'main';
  }
  return buildConversationAgentId(params.sample.sample_id, params.runTag);
}

function formatRetrievalMemoryTurn(
  turn: LocomoTurn & { dateTime?: string },
): string {
  const datePrefix = turn.dateTime ? `DATE: ${turn.dateTime}\n` : '';
  return `${datePrefix}${formatConversationTurn(turn).trim()}`.trim();
}

function budgetTruncateSemanticMemories(
  memories: SemanticMemoryEntry[],
  budgetTokens: number,
): SemanticMemoryEntry[] {
  const selected: SemanticMemoryEntry[] = [];
  let totalTokens = 0;

  for (const memory of memories) {
    const content = String(memory.content || '').trim();
    if (!content) continue;
    const contentTokens = estimateTokenCount(content);
    if (totalTokens + contentTokens > budgetTokens && selected.length > 0) {
      break;
    }
    selected.push(memory);
    totalTokens += contentTokens;
  }

  return selected;
}

function computeRetrievalHitRate(params: {
  evidence: string[];
  messageIdByDiaId: Map<string, number>;
  retrievedSourceMessageIds: number[];
}): number {
  const expandedEvidenceIds = expandEvidenceIds(params.evidence);
  if (expandedEvidenceIds.length === 0) return 1;

  const retrievedIds = new Set(params.retrievedSourceMessageIds);
  let found = 0;
  let resolvable = 0;
  for (const evidenceId of expandedEvidenceIds) {
    const messageId = params.messageIdByDiaId.get(evidenceId);
    if (!messageId) continue;
    resolvable += 1;
    if (retrievedIds.has(messageId)) {
      found += 1;
    }
  }
  if (resolvable === 0) return 0;
  return found / resolvable;
}

function expandEvidenceIds(evidence: string[]): string[] {
  const expanded: string[] = [];
  for (const entry of evidence || []) {
    const segments = String(entry || '')
      .split(';')
      .flatMap((part) => part.split(/\s+/g))
      .map((part) => normalizeDiaId(part))
      .filter((part) => /^D\d+:\d+$/i.test(part));
    expanded.push(...segments);
  }
  return expanded;
}

function normalizeDiaId(value: string): string {
  const match = /^D(\d+):(\d+)$/i.exec(String(value || '').trim());
  if (!match) return String(value || '').trim();
  return `D${Number.parseInt(match[1], 10)}:${Number.parseInt(match[2], 10)}`;
}

function computeContextTokenF1(prediction: string, answer: string): number {
  const predictionTokens = tokenizeContextText(prediction);
  const answerTokens = tokenizeContextText(answer);
  if (predictionTokens.length === 0 && answerTokens.length === 0) return 1;
  if (predictionTokens.length === 0 || answerTokens.length === 0) return 0;

  const predictionCounts = new Map<string, number>();
  const answerCounts = new Map<string, number>();
  for (const token of predictionTokens) {
    predictionCounts.set(token, (predictionCounts.get(token) || 0) + 1);
  }
  for (const token of answerTokens) {
    answerCounts.set(token, (answerCounts.get(token) || 0) + 1);
  }

  let matches = 0;
  for (const [token, count] of predictionCounts.entries()) {
    const answerCount = answerCounts.get(token) || 0;
    matches += Math.min(count, answerCount);
  }
  if (matches === 0) return 0;
  const precision = matches / predictionTokens.length;
  const recall = matches / answerTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

function tokenizeContextText(value: string): string[] {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function buildHashedTokenEmbedding(text: string): number[] | null {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;

  const tokens = normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .slice(0, 256);
  if (tokens.length === 0) return null;

  const vector = new Float32Array(128);
  for (const token of tokens) {
    const hash = hashEmbeddingToken(token);
    const index = hash % vector.length;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[index] += sign * Math.min(4, token.length);
  }

  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) {
    norm += vector[index] * vector[index];
  }
  if (norm <= Number.EPSILON) return null;
  const scale = 1 / Math.sqrt(norm);
  return Array.from(vector, (value) => value * scale);
}

function hashEmbeddingToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function requestModelAnswer(params: {
  runtime: LocomoGatewayRuntime;
  model: string;
  prompt: string;
  user: string;
}): Promise<{ content: string; usage: LocomoChatCompletionUsage | null }> {
  const url = `${params.runtime.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.runtime.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      user: params.user,
      messages: [{ role: 'user', content: params.prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `LOCOMO model call failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
    usage?: LocomoChatCompletionUsage;
  };
  return {
    content: String(payload.choices?.[0]?.message?.content || '').trim(),
    usage:
      payload.usage && typeof payload.usage === 'object' ? payload.usage : null,
  };
}

function mergeUsage(
  target: LocomoUsageSummary,
  usage: LocomoChatCompletionUsage | null,
): void {
  if (!usage) return;
  const promptTokens =
    typeof usage.prompt_tokens === 'number' &&
    Number.isFinite(usage.prompt_tokens)
      ? usage.prompt_tokens
      : 0;
  const completionTokens =
    typeof usage.completion_tokens === 'number' &&
    Number.isFinite(usage.completion_tokens)
      ? usage.completion_tokens
      : 0;
  const totalTokens =
    typeof usage.total_tokens === 'number' &&
    Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : promptTokens + completionTokens;
  target.promptTokens += promptTokens;
  target.completionTokens += completionTokens;
  target.totalTokens += totalTokens;
  target.responsesWithUsage += 1;
}

function normalizeModelPrediction(value: string): string {
  return String(value || '')
    .replace(/^short answer:\s*/i, '')
    .split('\n')[0]
    .trim()
    .replace(/^["']+|["']+$/g, '');
}

function normalizeCategoryFivePrediction(
  value: string,
  answerKey: Record<'a' | 'b', string> | null,
): string {
  const normalized = normalizeModelPrediction(value).toLowerCase();
  if (
    normalized.includes('no information available') ||
    normalized.includes('not mentioned')
  ) {
    return 'Not mentioned in the conversation';
  }
  if (answerKey && /^\(?a\)?$/.test(normalized)) {
    return answerKey.a;
  }
  if (answerKey && /^\(?b\)?$/.test(normalized)) {
    return answerKey.b;
  }
  return normalized;
}

function scoreLocomoAnswer(qa: LocomoQA, prediction: string): number {
  return scoreOfficialLocomoAnswer({
    category: qa.category,
    prediction,
    answer: answerToString(qa),
  });
}

function answerToString(qa: LocomoQA): string {
  if (typeof qa.answer === 'string') return qa.answer;
  if (typeof qa.answer === 'number' && Number.isFinite(qa.answer)) {
    return String(qa.answer);
  }
  if (qa.answer && typeof qa.answer === 'object') {
    return JSON.stringify(qa.answer);
  }
  return String(qa.adversarial_answer || '').trim();
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

function hashText(value: string): number {
  const digest = createHash('sha1').update(value).digest();
  return digest.readUInt32BE(0);
}

function formatLocomoCategoryLine(
  category: string,
  aggregate: LocomoCategoryAggregate,
  mode: LocomoEvaluationMode,
): string {
  if (mode === 'retrieval') {
    return `cat${category.padEnd(4)} Hit ${aggregate.meanScore.toFixed(3).padEnd(6)} F1 ${String(
      (aggregate.contextF1 ?? 0).toFixed(3),
    ).padEnd(6)} Q ${String(aggregate.questionCount)}`;
  }
  return `cat${category.padEnd(4)} Score ${aggregate.meanScore.toFixed(3).padEnd(6)} Q ${String(aggregate.questionCount)}`;
}

function printSummaryTable(summary: LocomoRunSummary): void {
  console.log('');
  console.log(
    summary.mode === 'retrieval'
      ? 'Category  Hit     F1      Questions'
      : 'Category  Score   Questions',
  );
  for (const [category, aggregate] of Object.entries(summary.categories).sort(
    ([left], [right]) => Number(left) - Number(right),
  )) {
    console.log(formatLocomoCategoryLine(category, aggregate, summary.mode));
  }
  console.log('');
  console.log(
    summary.mode === 'retrieval'
      ? `Hit rate: ${summary.overallScore.toFixed(3)}`
      : `Overall score: ${summary.overallScore.toFixed(3)}`,
  );
  if (summary.mode === 'retrieval' && summary.contextF1 != null) {
    console.log(`Context F1: ${summary.contextF1.toFixed(3)}`);
  }
  console.log(`Questions: ${summary.questionCount}`);
  if (summary.tokenUsage) {
    console.log(`Prompt tokens: ${summary.tokenUsage.promptTokens}`);
    console.log(`Completion tokens: ${summary.tokenUsage.completionTokens}`);
    console.log(`Total tokens: ${summary.tokenUsage.totalTokens}`);
  }
  console.log(`Predictions JSON: ${summary.predictionsPath}`);
  console.log(`Result JSON: ${summary.resultPath}`);
}
