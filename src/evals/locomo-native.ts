import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { initDatabase } from '../memory/db.js';
import { normalizeMemoryEmbeddingProviderKind } from '../memory/embeddings.js';
import { memoryService } from '../memory/memory-service.js';
import { normalizeMemoryRecallBackend } from '../memory/semantic-recall.js';
import { buildSessionKey } from '../session/session-key.js';
import type { Session } from '../types/session.js';
import {
  buildDefaultEvalProfile,
  type EvalProfile,
  encodeEvalProfileModel,
  parseEvalProfileModel,
} from './eval-profile.js';
import { scoreOfficialLocomoAnswer } from './locomo-official-scoring.js';
import type {
  LocomoAgentMode,
  LocomoCategoryAggregate,
  LocomoProgressPhase,
  LocomoRetrievalBackend,
  LocomoRetrievalEmbeddingProvider,
  LocomoRetrievalPolicy,
  LocomoRetrievalQueryMode,
  LocomoRetrievalRerank,
  LocomoRetrievalSweep,
  LocomoRetrievalTokenizer,
  LocomoRetrievalVariantProgress,
  LocomoRetrievalVariantSummary,
  LocomoTokenUsage,
} from './locomo-types.js';
import {
  LOCOMO_DATASET_FILENAME,
  LOCOMO_SETUP_MARKER,
} from './locomo-types.js';

const LOCOMO_DATASET_COMMIT = '3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376';
const LOCOMO_DATASET_URL = `https://raw.githubusercontent.com/snap-research/locomo/${LOCOMO_DATASET_COMMIT}/data/locomo10.json`;
const LOCOMO_DATASET_SHA256 =
  '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4';
const DEFAULT_TOKEN_BUDGET = 4000;
const ANSWER_BUFFER_TOKENS = 64;
const DEFAULT_OPENAI_BASE_URL = 'http://127.0.0.1:9090/v1';
const DEFAULT_EVAL_MODEL = 'hybridai/gpt-4.1-mini';
const LOCOMO_DATASET_DOWNLOAD_TIMEOUT_MS = 120_000;
const LOCOMO_MODEL_CALL_TIMEOUT_MS = 30_000;
const LOCOMO_QA_CONCURRENCY = 4;
const LOCOMO_PROGRESS_WRITE_INTERVAL_QUESTIONS = 20;
const LOCOMO_PROGRESS_WRITE_INTERVAL_TURNS = 50;
const DEFAULT_LOCOMO_RETRIEVAL_QUERY_MODE: LocomoRetrievalQueryMode =
  'no-stopwords';
const DEFAULT_LOCOMO_RETRIEVAL_BACKEND: LocomoRetrievalBackend = 'cosine';
const DEFAULT_LOCOMO_RETRIEVAL_RERANK: LocomoRetrievalRerank = 'bm25';
const DEFAULT_LOCOMO_RETRIEVAL_TOKENIZER: LocomoRetrievalTokenizer =
  'unicode61';
const DEFAULT_LOCOMO_RETRIEVAL_EMBEDDING_PROVIDER: LocomoRetrievalEmbeddingProvider =
  'hashed';

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

const flattenedConversationTurnsCache = new WeakMap<
  Record<string, unknown>,
  LocomoFlattenedTurn[]
>();

type LocomoOperation = 'setup' | 'run';
type LocomoEvaluationMode = 'qa' | 'retrieval';

interface LocomoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  blip_caption?: string;
}

type LocomoFlattenedTurn = LocomoTurn & {
  sessionNum: number;
  dateTime: string;
};

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
  matrix: boolean;
  matrixSweep: LocomoRetrievalSweep;
  agentMode: LocomoAgentMode;
  retrievalQueryMode: LocomoRetrievalQueryMode;
  retrievalBackend: LocomoRetrievalBackend;
  retrievalRerank: LocomoRetrievalRerank;
  retrievalTokenizer: LocomoRetrievalTokenizer;
  retrievalEmbeddingProvider: LocomoRetrievalEmbeddingProvider;
}

interface LocomoGatewayRuntime {
  baseUrl: string;
  apiKey: string;
  model: string;
  baseModel: string;
  profile: EvalProfile;
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
  matrix: boolean;
  matrixSweep: LocomoRetrievalSweep | null;
  retrievalPolicy: LocomoRetrievalPolicy | null;
  retrievalQueryMode: LocomoRetrievalQueryMode | null;
  retrievalBackend: LocomoRetrievalBackend | null;
  retrievalRerank: LocomoRetrievalRerank | null;
  retrievalTokenizer: LocomoRetrievalTokenizer | null;
  retrievalEmbeddingProvider: LocomoRetrievalEmbeddingProvider | null;
  retrievalEmbeddingModel: string | null;
  dataset: string;
  generatedAt: string;
  model: string | null;
  budgetTokens: number;
  sampleCount: number;
  questionCount: number;
  overallScore: number | null;
  contextF1: number | null;
  resultPath: string;
  predictionsPath: string;
  categories: Record<string, LocomoCategoryAggregate>;
  tokenUsage: LocomoTokenUsage | null;
  variantCount: number | null;
  bestVariantId: string | null;
  bestVariantLabel: string | null;
  variants: LocomoRetrievalVariantSummary[];
  samples: Array<{
    sampleId: string;
    questionCount: number;
    meanScore: number;
  }>;
}

interface LocomoProgressSummary {
  suite: 'locomo';
  mode: LocomoEvaluationMode;
  matrix: boolean;
  matrixSweep: LocomoRetrievalSweep | null;
  retrievalPolicy: LocomoRetrievalPolicy | null;
  retrievalQueryMode: LocomoRetrievalQueryMode | null;
  retrievalBackend: LocomoRetrievalBackend | null;
  retrievalRerank: LocomoRetrievalRerank | null;
  retrievalTokenizer: LocomoRetrievalTokenizer | null;
  retrievalEmbeddingProvider: LocomoRetrievalEmbeddingProvider | null;
  retrievalEmbeddingModel: string | null;
  dataset: string;
  updatedAt: string;
  model: string | null;
  budgetTokens: number;
  sampleCount: number;
  completedSampleCount: number;
  questionCount: number;
  completedQuestionCount: number;
  overallScore: number | null;
  contextF1: number | null;
  currentPhase: LocomoProgressPhase | null;
  currentSampleId: string | null;
  currentSampleEmbeddedTurnCount: number | null;
  currentSampleTurnCount: number | null;
  currentSampleQuestionCount: number | null;
  currentSampleQuestionTotal: number | null;
  progressPath: string;
  resultPath: string;
  predictionsPath: string;
  categories: Record<string, LocomoCategoryAggregate>;
  tokenUsage: LocomoTokenUsage | null;
  variantCount: number | null;
  completedVariantCount: number | null;
  currentVariant: LocomoRetrievalVariantProgress | null;
  variants: LocomoRetrievalVariantSummary[];
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
  close: () => void;
}

interface LocomoIngestionProgress {
  sampleId: string;
  embeddedTurnCount: number;
  turnCount: number;
}

interface LocomoPreparedQuestion {
  prompt: string;
  scoreCategory: number;
  categoryFiveAnswerKey: Record<'a' | 'b', string> | null;
}

interface LocomoRetrievedMemory {
  content: string;
  sourceMessageId: number | null;
  confidence: number;
}

interface LocomoRetrievalVariantPlan {
  id: string;
  label: string;
  retrievalQueryMode: LocomoRetrievalQueryMode;
  retrievalBackend: LocomoRetrievalBackend;
  retrievalRerank: LocomoRetrievalRerank;
  retrievalTokenizer: LocomoRetrievalTokenizer;
  retrievalEmbeddingProvider: LocomoRetrievalEmbeddingProvider;
  retrievalEmbeddingModel: string | null;
}

interface LocomoEvaluatedRetrievalVariant
  extends LocomoRetrievalVariantSummary {
  predictions: LocomoSamplePrediction[];
}

interface LocomoRetrievalVariantPredictionManifestEntry {
  id: string;
  label: string;
  retrievalQueryMode: LocomoRetrievalQueryMode;
  retrievalBackend: LocomoRetrievalBackend;
  retrievalRerank: LocomoRetrievalRerank;
  retrievalTokenizer: LocomoRetrievalTokenizer;
  retrievalEmbeddingProvider: LocomoRetrievalEmbeddingProvider;
  predictionsPath: string;
  sampleCount: number;
  questionCount: number;
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
  let matrix = false;
  let matrixSweep: LocomoRetrievalSweep = 'all';
  let agentMode: LocomoAgentMode = 'conversation-fresh';
  let retrievalQueryMode: LocomoRetrievalQueryMode =
    DEFAULT_LOCOMO_RETRIEVAL_QUERY_MODE;
  let retrievalBackend: LocomoRetrievalBackend =
    DEFAULT_LOCOMO_RETRIEVAL_BACKEND;
  let retrievalRerank: LocomoRetrievalRerank = DEFAULT_LOCOMO_RETRIEVAL_RERANK;
  let retrievalTokenizer: LocomoRetrievalTokenizer =
    DEFAULT_LOCOMO_RETRIEVAL_TOKENIZER;
  let retrievalEmbeddingProvider: LocomoRetrievalEmbeddingProvider =
    DEFAULT_LOCOMO_RETRIEVAL_EMBEDDING_PROVIDER;

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
    if (flag === '--matrix') {
      const nextToken = String(argv[index + 1] || '').trim();
      const value = (inlineValue || nextToken).toLowerCase().trim();
      matrix = true;
      if (value && isLocomoRetrievalSweep(value)) {
        matrixSweep = value;
        if (!inlineValue) index += 1;
      } else if (!inlineValue && nextToken && !nextToken.startsWith('-')) {
        throw new Error(
          `Unsupported LOCOMO matrix sweep \`${value || '(empty)'}\`. Use \`all\`, \`backend\`, \`rerank\`, \`tokenizer\`, or \`embedding\`.`,
        );
      } else if (inlineValue) {
        throw new Error(
          `Unsupported LOCOMO matrix sweep \`${value || '(empty)'}\`. Use \`all\`, \`backend\`, \`rerank\`, \`tokenizer\`, or \`embedding\`.`,
        );
      }
      continue;
    }
    if (flag === '--agent-mode') {
      const value = nextValue().toLowerCase();
      if (value === 'conversation-fresh' || value === 'current-agent') {
        agentMode = value;
      } else {
        throw new Error(
          `Unsupported LOCOMO agent mode \`${value || '(empty)'}\`.`,
        );
      }
      if (!inlineValue) index += 1;
      continue;
    }
    if (flag === '--retrieval-query') {
      const value = nextValue().toLowerCase();
      if (value === 'raw' || value === 'no-stopwords') {
        retrievalQueryMode = value;
      } else {
        throw new Error(
          `Unsupported LOCOMO retrieval query mode \`${value || '(empty)'}\`.`,
        );
      }
      if (!inlineValue) index += 1;
      continue;
    }
    if (flag === '--retrieval-backend') {
      const value = nextValue().toLowerCase();
      if (
        value === 'cosine' ||
        value === 'semantic' ||
        value === 'full-text' ||
        value === 'fulltext' ||
        value === 'fts-bm25' ||
        value === 'hybrid'
      ) {
        retrievalBackend = normalizeMemoryRecallBackend(value, 'cosine');
      } else {
        throw new Error(
          `Unsupported LOCOMO retrieval backend \`${value || '(empty)'}\`.`,
        );
      }
      if (!inlineValue) index += 1;
      continue;
    }
    if (flag === '--retrieval-rerank') {
      const value = nextValue().toLowerCase();
      if (value === 'none' || value === 'bm25') {
        retrievalRerank = value;
      } else {
        throw new Error(
          `Unsupported LOCOMO retrieval rerank mode \`${value || '(empty)'}\`.`,
        );
      }
      if (!inlineValue) index += 1;
      continue;
    }
    if (flag === '--retrieval-tokenizer') {
      const value = nextValue().toLowerCase();
      if (
        value === 'default' ||
        value === 'unicode61' ||
        value === 'porter' ||
        value === 'trigram'
      ) {
        retrievalTokenizer = value === 'default' ? 'unicode61' : value;
      } else {
        throw new Error(
          `Unsupported LOCOMO retrieval tokenizer \`${value || '(empty)'}\`.`,
        );
      }
      if (!inlineValue) index += 1;
      continue;
    }
    if (flag === '--retrieval-embedding') {
      const value = nextValue().toLowerCase();
      retrievalEmbeddingProvider = normalizeMemoryEmbeddingProviderKind(
        value,
        'hashed',
      );
      if (
        value !== 'hashed' &&
        value !== 'hash' &&
        value !== 'transformers' &&
        value !== 'transformers.js'
      ) {
        throw new Error(
          `Unsupported LOCOMO retrieval embedding provider \`${value || '(empty)'}\`.`,
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
  if (
    mode !== 'retrieval' &&
    (matrix ||
      retrievalQueryMode !== DEFAULT_LOCOMO_RETRIEVAL_QUERY_MODE ||
      retrievalBackend !== DEFAULT_LOCOMO_RETRIEVAL_BACKEND ||
      retrievalRerank !== DEFAULT_LOCOMO_RETRIEVAL_RERANK ||
      retrievalTokenizer !== DEFAULT_LOCOMO_RETRIEVAL_TOKENIZER ||
      retrievalEmbeddingProvider !==
        DEFAULT_LOCOMO_RETRIEVAL_EMBEDDING_PROVIDER)
  ) {
    throw new Error('LOCOMO retrieval-only flags require `--mode retrieval`.');
  }
  if (
    matrix &&
    (retrievalQueryMode !== DEFAULT_LOCOMO_RETRIEVAL_QUERY_MODE ||
      retrievalBackend !== DEFAULT_LOCOMO_RETRIEVAL_BACKEND ||
      retrievalRerank !== DEFAULT_LOCOMO_RETRIEVAL_RERANK ||
      retrievalTokenizer !== DEFAULT_LOCOMO_RETRIEVAL_TOKENIZER ||
      retrievalEmbeddingProvider !==
        DEFAULT_LOCOMO_RETRIEVAL_EMBEDDING_PROVIDER)
  ) {
    throw new Error(
      'LOCOMO `--matrix` runs the full retrieval sweep and cannot be combined with explicit retrieval flags.',
    );
  }

  return {
    operation,
    installDir: path.resolve(installDir),
    budgetTokens,
    numSamples,
    maxQuestions,
    mode,
    matrix,
    matrixSweep,
    agentMode,
    retrievalQueryMode,
    retrievalBackend,
    retrievalRerank,
    retrievalTokenizer,
    retrievalEmbeddingProvider,
  };
}

function isLocomoRetrievalSweep(value: string): value is LocomoRetrievalSweep {
  return (
    value === 'all' ||
    value === 'backend' ||
    value === 'rerank' ||
    value === 'tokenizer' ||
    value === 'embedding'
  );
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
    const response = await fetchWithTimeout(
      LOCOMO_DATASET_URL,
      undefined,
      LOCOMO_DATASET_DOWNLOAD_TIMEOUT_MS,
      'LOCOMO dataset download',
    );
    if (!response.ok) {
      throw new Error(
        `Failed to download LOCOMO dataset: HTTP ${response.status}`,
      );
    }
    const rawBuffer = Buffer.from(await response.arrayBuffer());
    verifyDownloadedDataset(rawBuffer);
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
  const markerPath = getMarkerPath(options.installDir);
  const hasMarker = fs.existsSync(markerPath);
  const hasDataset = fs.existsSync(datasetPath);
  if (!hasMarker && !hasDataset) {
    throw new Error(
      'LOCOMO is not set up. Run `setup` first, or use `/eval locomo setup`.',
    );
  }
  if (!hasDataset) {
    throw new Error(
      `LOCOMO dataset is missing at ${datasetPath}. Re-run \`setup\`, or use \`/eval locomo setup\`.`,
    );
  }
  if (!hasMarker) {
    throw new Error(
      `LOCOMO setup marker is missing at ${markerPath}. Re-run \`setup\`, or use \`/eval locomo setup\`.`,
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
  const runTag = path.basename(jobDir);
  const retrievalMatrixVariants = buildLocomoRetrievalMatrixVariants(
    options.matrixSweep,
  );

  console.log(`Job dir: ${jobDir}`);
  console.log(`Dataset: ${datasetPath}`);
  console.log(`Mode: ${options.mode}`);
  if (options.mode === 'qa') {
    console.log(`Model: ${runtime.model}`);
  } else {
    console.log(`Memory DB: ${retrievalDbPath}`);
    if (options.matrix) {
      console.log(
        `Matrix: ${retrievalMatrixVariants.length} retrieval variants`,
      );
      console.log(`Matrix sweep: ${options.matrixSweep}`);
      const retrievalEmbeddingModel = resolveLocomoRunEmbeddingModel({
        matrix: true,
        matrixSweep: options.matrixSweep,
        retrievalEmbeddingProvider: options.retrievalEmbeddingProvider,
      });
      if (retrievalEmbeddingModel) {
        console.log(`Retrieval embedding model: ${retrievalEmbeddingModel}`);
      }
    } else {
      console.log(`Retrieval query: ${options.retrievalQueryMode}`);
      console.log(`Retrieval backend: ${options.retrievalBackend}`);
      console.log(`Retrieval rerank: ${options.retrievalRerank}`);
      console.log(`Retrieval tokenizer: ${options.retrievalTokenizer}`);
      console.log(`Retrieval embedding: ${options.retrievalEmbeddingProvider}`);
      const retrievalEmbeddingModel = resolveLocomoRunEmbeddingModel({
        matrix: false,
        matrixSweep: null,
        retrievalEmbeddingProvider: options.retrievalEmbeddingProvider,
      });
      if (retrievalEmbeddingModel) {
        console.log(`Retrieval embedding model: ${retrievalEmbeddingModel}`);
      }
    }
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

  if (options.mode === 'retrieval' && options.matrix) {
    await runRetrievalMatrixEvaluation({
      options,
      runtime,
      plannedSamples,
      totalQuestionCount,
      datasetPath,
      jobDir,
      progressPath,
      resultPath,
      predictionsPath,
      runTag,
      variants: retrievalMatrixVariants,
    });
    return;
  }

  const predictions: LocomoSamplePrediction[] = [];
  const categories = new Map<number, LocomoCategoryRunningAggregate>();
  const usageTotals: LocomoTokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    responsesWithUsage: 0,
  };
  let questionCount = 0;
  let scoreTotal = 0;
  let contextF1Total = 0;
  let completedSampleCount = 0;
  const retrievalSettings =
    options.mode === 'retrieval'
      ? {
          retrievalPolicy: 'budget-only' as const,
          retrievalQueryMode: options.retrievalQueryMode,
          retrievalBackend: options.retrievalBackend,
          retrievalRerank: options.retrievalRerank,
          retrievalTokenizer: options.retrievalTokenizer,
          retrievalEmbeddingProvider: options.retrievalEmbeddingProvider,
          retrievalEmbeddingModel: resolveLocomoRunEmbeddingModel({
            matrix: false,
            matrixSweep: null,
            retrievalEmbeddingProvider: options.retrievalEmbeddingProvider,
          }),
          currentPhase:
            options.retrievalEmbeddingProvider === 'transformers'
              ? ('warming-embedding' as const)
              : ('ingesting' as const),
        }
      : null;
  const initialSample: LocomoSample | null =
    options.mode === 'retrieval' ? (plannedSamples[0] ?? null) : null;
  const initialSampleTurnCount = initialSample
    ? flattenConversationTurns(initialSample.conversation).length
    : null;

  writeProgressFile({
    progressPath,
    resultPath,
    predictionsPath,
    mode: options.mode,
    matrix: false,
    matrixSweep: null,
    retrievalPolicy: retrievalSettings?.retrievalPolicy ?? null,
    retrievalQueryMode: retrievalSettings?.retrievalQueryMode ?? null,
    retrievalBackend: retrievalSettings?.retrievalBackend ?? null,
    retrievalRerank: retrievalSettings?.retrievalRerank ?? null,
    retrievalTokenizer: retrievalSettings?.retrievalTokenizer ?? null,
    retrievalEmbeddingProvider:
      retrievalSettings?.retrievalEmbeddingProvider ?? null,
    retrievalEmbeddingModel: retrievalSettings?.retrievalEmbeddingModel ?? null,
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
    currentPhase: retrievalSettings?.currentPhase ?? null,
    currentSampleId: initialSample?.sample_id || null,
    currentSampleEmbeddedTurnCount: retrievalSettings ? 0 : null,
    currentSampleTurnCount: retrievalSettings ? initialSampleTurnCount : null,
    currentSampleQuestionCount: null,
    currentSampleQuestionTotal: null,
    variantCount: null,
    completedVariantCount: null,
    currentVariant: null,
    variants: [],
  });

  if (
    options.mode === 'retrieval' &&
    options.retrievalEmbeddingProvider === 'transformers'
  ) {
    memoryService.warmupEmbeddingProvider(options.retrievalEmbeddingProvider);
    writeProgressFile({
      progressPath,
      resultPath,
      predictionsPath,
      mode: options.mode,
      matrix: false,
      matrixSweep: null,
      retrievalPolicy: 'budget-only',
      retrievalQueryMode: options.retrievalQueryMode,
      retrievalBackend: options.retrievalBackend,
      retrievalRerank: options.retrievalRerank,
      retrievalTokenizer: options.retrievalTokenizer,
      retrievalEmbeddingProvider: options.retrievalEmbeddingProvider,
      retrievalEmbeddingModel: resolveLocomoRunEmbeddingModel({
        matrix: false,
        matrixSweep: null,
        retrievalEmbeddingProvider: options.retrievalEmbeddingProvider,
      }),
      datasetPath,
      model: null,
      budgetTokens: options.budgetTokens,
      sampleCount: plannedSamples.length,
      completedSampleCount,
      questionCount: totalQuestionCount,
      completedQuestionCount: questionCount,
      scoreTotal,
      contextF1Total,
      categories,
      usageTotals,
      currentPhase: 'ingesting',
      currentSampleId: initialSample?.sample_id || null,
      currentSampleEmbeddedTurnCount: 0,
      currentSampleTurnCount: initialSampleTurnCount,
      currentSampleQuestionCount: null,
      currentSampleQuestionTotal: null,
      variantCount: null,
      completedVariantCount: null,
      currentVariant: null,
      variants: [],
    });
  }

  const writeQuestionProgress = (params: {
    samplePrediction: LocomoSamplePrediction;
    model: string | null;
    contextF1TotalForSnapshot: number;
  }): void => {
    if (
      !shouldWriteQuestionProgressSnapshot(params.samplePrediction.qa.length)
    ) {
      return;
    }
    const completedQuestionCount =
      questionCount + params.samplePrediction.qa.length;
    const partialScoreTotal =
      scoreTotal +
      params.samplePrediction.qa.reduce((total, qa) => total + qa.score, 0);
    writeProgressFile({
      progressPath,
      resultPath,
      predictionsPath,
      mode: options.mode,
      matrix: false,
      matrixSweep: null,
      retrievalPolicy: options.mode === 'retrieval' ? 'budget-only' : null,
      retrievalQueryMode:
        options.mode === 'retrieval' ? options.retrievalQueryMode : null,
      retrievalBackend:
        options.mode === 'retrieval' ? options.retrievalBackend : null,
      retrievalRerank:
        options.mode === 'retrieval' ? options.retrievalRerank : null,
      retrievalTokenizer:
        options.mode === 'retrieval' ? options.retrievalTokenizer : null,
      retrievalEmbeddingProvider:
        options.mode === 'retrieval'
          ? options.retrievalEmbeddingProvider
          : null,
      retrievalEmbeddingModel:
        options.mode === 'retrieval'
          ? resolveLocomoRunEmbeddingModel({
              matrix: false,
              matrixSweep: null,
              retrievalEmbeddingProvider: options.retrievalEmbeddingProvider,
            })
          : null,
      datasetPath,
      model: params.model,
      budgetTokens: options.budgetTokens,
      sampleCount: plannedSamples.length,
      completedSampleCount,
      questionCount: totalQuestionCount,
      completedQuestionCount,
      scoreTotal: partialScoreTotal,
      contextF1Total: params.contextF1TotalForSnapshot,
      categories,
      usageTotals,
      currentPhase: options.mode === 'retrieval' ? 'evaluating' : null,
      currentSampleId: params.samplePrediction.sampleId,
      currentSampleEmbeddedTurnCount: null,
      currentSampleTurnCount: null,
      currentSampleQuestionCount: params.samplePrediction.qa.length,
      currentSampleQuestionTotal: params.samplePrediction.questionCount,
      variantCount: null,
      completedVariantCount: null,
      currentVariant: null,
      variants: [],
    });
  };

  for (const sample of plannedSamples) {
    const samplePrediction =
      options.mode === 'retrieval'
        ? await (async () => {
            const sampleTurnCount = flattenConversationTurns(
              sample.conversation,
            ).length;
            writeProgressFile({
              progressPath,
              resultPath,
              predictionsPath,
              mode: options.mode,
              matrix: false,
              matrixSweep: null,
              retrievalPolicy: 'budget-only',
              retrievalQueryMode: options.retrievalQueryMode,
              retrievalBackend: options.retrievalBackend,
              retrievalRerank: options.retrievalRerank,
              retrievalTokenizer: options.retrievalTokenizer,
              retrievalEmbeddingProvider: options.retrievalEmbeddingProvider,
              retrievalEmbeddingModel: resolveLocomoRunEmbeddingModel({
                matrix: false,
                matrixSweep: null,
                retrievalEmbeddingProvider: options.retrievalEmbeddingProvider,
              }),
              datasetPath,
              model: null,
              budgetTokens: options.budgetTokens,
              sampleCount: plannedSamples.length,
              completedSampleCount,
              questionCount: totalQuestionCount,
              completedQuestionCount: questionCount,
              scoreTotal,
              contextF1Total,
              categories,
              usageTotals,
              currentPhase: 'ingesting',
              currentSampleId: sample.sample_id,
              currentSampleEmbeddedTurnCount: 0,
              currentSampleTurnCount: sampleTurnCount,
              currentSampleQuestionCount: null,
              currentSampleQuestionTotal: null,
              variantCount: null,
              completedVariantCount: null,
              currentVariant: null,
              variants: [],
            });
            const session = ingestSampleIntoNativeMemory({
              sample,
              runTag,
              agentMode: options.agentMode,
              runtime,
              retrievalEmbeddingProvider: options.retrievalEmbeddingProvider,
              onProgress: ({ sampleId, embeddedTurnCount, turnCount }) => {
                writeProgressFile({
                  progressPath,
                  resultPath,
                  predictionsPath,
                  mode: options.mode,
                  matrix: false,
                  matrixSweep: null,
                  retrievalPolicy: 'budget-only',
                  retrievalQueryMode: options.retrievalQueryMode,
                  retrievalBackend: options.retrievalBackend,
                  retrievalRerank: options.retrievalRerank,
                  retrievalTokenizer: options.retrievalTokenizer,
                  retrievalEmbeddingProvider:
                    options.retrievalEmbeddingProvider,
                  retrievalEmbeddingModel: resolveLocomoRunEmbeddingModel({
                    matrix: false,
                    matrixSweep: null,
                    retrievalEmbeddingProvider:
                      options.retrievalEmbeddingProvider,
                  }),
                  datasetPath,
                  model: null,
                  budgetTokens: options.budgetTokens,
                  sampleCount: plannedSamples.length,
                  completedSampleCount,
                  questionCount: totalQuestionCount,
                  completedQuestionCount: questionCount,
                  scoreTotal,
                  contextF1Total,
                  categories,
                  usageTotals,
                  currentPhase: 'ingesting',
                  currentSampleId: sampleId,
                  currentSampleEmbeddedTurnCount: embeddedTurnCount,
                  currentSampleTurnCount: turnCount,
                  currentSampleQuestionCount: null,
                  currentSampleQuestionTotal: null,
                  variantCount: null,
                  completedVariantCount: null,
                  currentVariant: null,
                  variants: [],
                });
              },
            });
            try {
              return await evaluateRetrievalSample({
                sample,
                budgetTokens: options.budgetTokens,
                categories,
                session,
                retrievalQueryMode: options.retrievalQueryMode,
                retrievalBackend: options.retrievalBackend,
                retrievalRerank: options.retrievalRerank,
                retrievalTokenizer: options.retrievalTokenizer,
                retrievalEmbeddingProvider: options.retrievalEmbeddingProvider,
                onQuestionProgress: ({ samplePrediction }) => {
                  const partialContextF1Total =
                    contextF1Total +
                    samplePrediction.qa.reduce(
                      (total, qa) => total + (qa.contextF1 || 0),
                      0,
                    );
                  writeQuestionProgress({
                    samplePrediction,
                    model: null,
                    contextF1TotalForSnapshot: partialContextF1Total,
                  });
                },
              });
            } finally {
              session.close();
            }
          })()
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
              writeQuestionProgress({
                samplePrediction,
                model: runtime.model,
                contextF1TotalForSnapshot: contextF1Total,
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
      matrix: false,
      matrixSweep: null,
      retrievalPolicy: options.mode === 'retrieval' ? 'budget-only' : null,
      retrievalQueryMode:
        options.mode === 'retrieval' ? options.retrievalQueryMode : null,
      retrievalBackend:
        options.mode === 'retrieval' ? options.retrievalBackend : null,
      retrievalRerank:
        options.mode === 'retrieval' ? options.retrievalRerank : null,
      retrievalTokenizer:
        options.mode === 'retrieval' ? options.retrievalTokenizer : null,
      retrievalEmbeddingProvider:
        options.mode === 'retrieval'
          ? options.retrievalEmbeddingProvider
          : null,
      retrievalEmbeddingModel:
        options.mode === 'retrieval'
          ? resolveLocomoRunEmbeddingModel({
              matrix: false,
              matrixSweep: null,
              retrievalEmbeddingProvider: options.retrievalEmbeddingProvider,
            })
          : null,
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
      currentPhase:
        options.mode === 'retrieval' &&
        completedSampleCount < plannedSamples.length
          ? 'ingesting'
          : null,
      currentSampleId:
        completedSampleCount < plannedSamples.length
          ? plannedSamples[completedSampleCount]?.sample_id || null
          : null,
      currentSampleEmbeddedTurnCount:
        options.mode === 'retrieval' &&
        completedSampleCount < plannedSamples.length
          ? 0
          : null,
      currentSampleTurnCount:
        options.mode === 'retrieval' &&
        completedSampleCount < plannedSamples.length
          ? flattenConversationTurns(
              plannedSamples[completedSampleCount]?.conversation || {},
            ).length
          : null,
      currentSampleQuestionCount: null,
      currentSampleQuestionTotal:
        completedSampleCount < plannedSamples.length
          ? plannedSamples[completedSampleCount]?.qa.length || null
          : null,
      variantCount: null,
      completedVariantCount: null,
      currentVariant: null,
      variants: [],
    });
  }

  fs.writeFileSync(
    predictionsPath,
    JSON.stringify(predictions, null, 2),
    'utf-8',
  );

  const summary: LocomoRunSummary = {
    suite: 'locomo',
    mode: options.mode,
    matrix: false,
    matrixSweep: null,
    retrievalPolicy: options.mode === 'retrieval' ? 'budget-only' : null,
    retrievalQueryMode:
      options.mode === 'retrieval' ? options.retrievalQueryMode : null,
    retrievalBackend:
      options.mode === 'retrieval' ? options.retrievalBackend : null,
    retrievalRerank:
      options.mode === 'retrieval' ? options.retrievalRerank : null,
    retrievalTokenizer:
      options.mode === 'retrieval' ? options.retrievalTokenizer : null,
    retrievalEmbeddingProvider:
      options.mode === 'retrieval' ? options.retrievalEmbeddingProvider : null,
    retrievalEmbeddingModel:
      options.mode === 'retrieval'
        ? resolveLocomoRunEmbeddingModel({
            matrix: false,
            matrixSweep: null,
            retrievalEmbeddingProvider: options.retrievalEmbeddingProvider,
          })
        : null,
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
    categories: buildCategorySummaries(categories, options.mode),
    tokenUsage:
      options.mode === 'qa' && usageTotals.responsesWithUsage > 0
        ? usageTotals
        : null,
    variantCount: null,
    bestVariantId: null,
    bestVariantLabel: null,
    variants: [],
    samples: predictions.map((samplePrediction) => ({
      sampleId: samplePrediction.sampleId,
      questionCount: samplePrediction.questionCount,
      meanScore: samplePrediction.meanScore,
    })),
  };

  fs.writeFileSync(resultPath, JSON.stringify(summary, null, 2), 'utf-8');
  printSummaryTable(summary);
}

function buildLocomoRetrievalMatrixVariants(
  sweep: LocomoRetrievalSweep,
): LocomoRetrievalVariantPlan[] {
  const variants: LocomoRetrievalVariantPlan[] = [];
  const queryModes: LocomoRetrievalQueryMode[] = ['no-stopwords'];
  const backends: LocomoRetrievalBackend[] =
    sweep === 'all' || sweep === 'backend'
      ? ['cosine', 'full-text', 'hybrid']
      : ['cosine'];
  const reranks: LocomoRetrievalRerank[] =
    sweep === 'all' || sweep === 'rerank' ? ['none', 'bm25'] : ['bm25'];
  const tokenizers: LocomoRetrievalTokenizer[] =
    sweep === 'all' || sweep === 'tokenizer'
      ? ['unicode61', 'porter', 'trigram']
      : ['unicode61'];
  const embeddingProviders: LocomoRetrievalEmbeddingProvider[] =
    sweep === 'embedding' ? ['hashed', 'transformers'] : ['hashed'];

  for (const backend of backends) {
    for (const queryMode of queryModes) {
      for (const tokenizer of tokenizers) {
        for (const embeddingProvider of embeddingProviders) {
          for (const rerank of reranks) {
            if (
              backend === 'cosine' &&
              rerank === 'none' &&
              tokenizer !== 'unicode61'
            ) {
              continue;
            }
            const idParts: string[] = [backend];
            if (queryMode === 'no-stopwords') {
              idParts.push('no-stopwords');
            }
            if (tokenizer !== 'unicode61') {
              idParts.push(tokenizer);
            }
            if (rerank !== 'none') {
              idParts.push(rerank);
            }
            if (embeddingProvider !== 'hashed') {
              idParts.push(embeddingProvider);
            }
            const id = idParts.join('-');
            variants.push({
              id,
              label: formatLocomoRetrievalVariantLabel({
                queryMode,
                backend,
                rerank,
                tokenizer,
                embeddingProvider,
              }),
              retrievalQueryMode: queryMode,
              retrievalBackend: backend,
              retrievalRerank: rerank,
              retrievalTokenizer: tokenizer,
              retrievalEmbeddingProvider: embeddingProvider,
              retrievalEmbeddingModel:
                resolveLocomoRetrievalEmbeddingModel(embeddingProvider),
            });
          }
        }
      }
    }
  }

  return variants;
}

function resolveLocomoRetrievalEmbeddingModel(
  embeddingProvider: LocomoRetrievalEmbeddingProvider,
): string | null {
  if (embeddingProvider !== 'transformers') {
    return null;
  }
  return String(getRuntimeConfig().memory.embedding.model || '').trim() || null;
}

function resolveLocomoRunEmbeddingModel(params: {
  matrix: boolean;
  matrixSweep: LocomoRetrievalSweep | null;
  retrievalEmbeddingProvider: LocomoRetrievalEmbeddingProvider;
}): string | null {
  if (!params.matrix) {
    return resolveLocomoRetrievalEmbeddingModel(
      params.retrievalEmbeddingProvider,
    );
  }
  if (params.matrixSweep === 'embedding') {
    return resolveLocomoRetrievalEmbeddingModel('transformers');
  }
  return null;
}

function formatLocomoRetrievalVariantLabel(params: {
  queryMode: LocomoRetrievalQueryMode;
  backend: LocomoRetrievalBackend;
  rerank: LocomoRetrievalRerank;
  tokenizer: LocomoRetrievalTokenizer;
  embeddingProvider: LocomoRetrievalEmbeddingProvider;
}): string {
  const parts: string[] = [params.backend];
  if (params.tokenizer === 'porter') {
    parts.push('porter');
  } else if (params.tokenizer === 'trigram') {
    parts.push('trigram');
  }
  if (params.rerank === 'bm25') {
    parts.push('bm25');
  }
  if (params.embeddingProvider === 'transformers') {
    parts.push('transformers');
  }
  return parts.join(' + ');
}

function buildLocomoRetrievalVariantSummary(params: {
  variant: LocomoRetrievalVariantPlan;
  sampleCount: number;
  questionCount: number;
  scoreTotal: number;
  contextF1Total: number;
  categories: Map<number, LocomoCategoryRunningAggregate>;
}): LocomoRetrievalVariantSummary {
  return {
    id: params.variant.id,
    label: params.variant.label,
    retrievalPolicy: 'budget-only',
    retrievalQueryMode: params.variant.retrievalQueryMode,
    retrievalBackend: params.variant.retrievalBackend,
    retrievalRerank: params.variant.retrievalRerank,
    retrievalTokenizer: params.variant.retrievalTokenizer,
    retrievalEmbeddingProvider: params.variant.retrievalEmbeddingProvider,
    retrievalEmbeddingModel: params.variant.retrievalEmbeddingModel,
    sampleCount: params.sampleCount,
    questionCount: params.questionCount,
    overallScore: roundMetric(
      params.scoreTotal / Math.max(params.questionCount, 1),
    ),
    contextF1: roundMetric(
      params.contextF1Total / Math.max(params.questionCount, 1),
    ),
    categories: buildCategorySummaries(params.categories, 'retrieval'),
  };
}

function buildLocomoRetrievalVariantProgress(params: {
  variant: LocomoRetrievalVariantPlan;
  sampleCount: number;
  completedSampleCount: number;
  questionCount: number;
  completedQuestionCount: number;
  scoreTotal: number;
  contextF1Total: number;
  categories: Map<number, LocomoCategoryRunningAggregate>;
  currentPhase: LocomoProgressPhase | null;
  currentSampleId: string | null;
  currentSampleEmbeddedTurnCount: number | null;
  currentSampleTurnCount: number | null;
  currentSampleQuestionCount: number | null;
  currentSampleQuestionTotal: number | null;
}): LocomoRetrievalVariantProgress {
  return {
    id: params.variant.id,
    label: params.variant.label,
    retrievalPolicy: 'budget-only',
    retrievalQueryMode: params.variant.retrievalQueryMode,
    retrievalBackend: params.variant.retrievalBackend,
    retrievalRerank: params.variant.retrievalRerank,
    retrievalTokenizer: params.variant.retrievalTokenizer,
    retrievalEmbeddingProvider: params.variant.retrievalEmbeddingProvider,
    retrievalEmbeddingModel: params.variant.retrievalEmbeddingModel,
    sampleCount: params.sampleCount,
    questionCount: params.questionCount,
    overallScore: roundMetric(
      params.scoreTotal / Math.max(params.completedQuestionCount, 1),
    ),
    contextF1: roundMetric(
      params.contextF1Total / Math.max(params.completedQuestionCount, 1),
    ),
    categories: buildCategorySummaries(params.categories, 'retrieval'),
    currentPhase: params.currentPhase,
    completedSampleCount: params.completedSampleCount,
    completedQuestionCount: params.completedQuestionCount,
    currentSampleId: params.currentSampleId,
    currentSampleEmbeddedTurnCount: params.currentSampleEmbeddedTurnCount,
    currentSampleTurnCount: params.currentSampleTurnCount,
    currentSampleQuestionCount: params.currentSampleQuestionCount,
    currentSampleQuestionTotal: params.currentSampleQuestionTotal,
  };
}

function pickBestLocomoRetrievalVariant(
  variants: LocomoRetrievalVariantSummary[],
): LocomoRetrievalVariantSummary | null {
  if (variants.length === 0) {
    return null;
  }
  return [...variants].sort((left, right) => {
    if (right.overallScore !== left.overallScore) {
      return right.overallScore - left.overallScore;
    }
    if ((right.contextF1 ?? 0) !== (left.contextF1 ?? 0)) {
      return (right.contextF1 ?? 0) - (left.contextF1 ?? 0);
    }
    return left.label.localeCompare(right.label);
  })[0];
}

async function runRetrievalMatrixEvaluation(params: {
  options: LocomoRunnerOptions;
  runtime: LocomoGatewayRuntime;
  plannedSamples: LocomoSample[];
  totalQuestionCount: number;
  datasetPath: string;
  jobDir: string;
  progressPath: string;
  resultPath: string;
  predictionsPath: string;
  runTag: string;
  variants: LocomoRetrievalVariantPlan[];
}): Promise<void> {
  const completedVariants: LocomoRetrievalVariantSummary[] = [];
  const variantPredictionManifests: LocomoRetrievalVariantPredictionManifestEntry[] =
    [];
  const matrixPredictionsDir = path.join(params.jobDir, 'matrix-predictions');
  fs.mkdirSync(matrixPredictionsDir, { recursive: true });

  writeLocomoMatrixPredictionsIndex({
    predictionsPath: params.predictionsPath,
    matrixSweep: params.options.matrixSweep,
    variants: variantPredictionManifests,
  });

  writeProgressFile({
    progressPath: params.progressPath,
    resultPath: params.resultPath,
    predictionsPath: params.predictionsPath,
    mode: 'retrieval',
    matrix: true,
    matrixSweep: params.options.matrixSweep,
    retrievalPolicy: 'budget-only',
    retrievalQueryMode: null,
    retrievalBackend: null,
    retrievalRerank: null,
    retrievalTokenizer: null,
    retrievalEmbeddingProvider: null,
    retrievalEmbeddingModel: resolveLocomoRunEmbeddingModel({
      matrix: true,
      matrixSweep: params.options.matrixSweep,
      retrievalEmbeddingProvider: 'hashed',
    }),
    datasetPath: params.datasetPath,
    model: null,
    budgetTokens: params.options.budgetTokens,
    sampleCount: params.plannedSamples.length,
    completedSampleCount: 0,
    questionCount: params.totalQuestionCount,
    completedQuestionCount: 0,
    scoreTotal: 0,
    contextF1Total: 0,
    categories: new Map(),
    usageTotals: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      responsesWithUsage: 0,
    },
    currentPhase: null,
    currentSampleId: null,
    currentSampleEmbeddedTurnCount: null,
    currentSampleTurnCount: null,
    currentSampleQuestionCount: null,
    currentSampleQuestionTotal: null,
    variantCount: params.variants.length,
    completedVariantCount: 0,
    currentVariant: null,
    variants: completedVariants,
  });

  for (const variant of params.variants) {
    const evaluatedVariant = await runSingleRetrievalVariantEvaluation({
      variant,
      plannedSamples: params.plannedSamples,
      totalQuestionCount: params.totalQuestionCount,
      budgetTokens: params.options.budgetTokens,
      runtime: params.runtime,
      runTag: `${params.runTag}-${variant.id}`,
      agentMode: params.options.agentMode,
      onProgress: (currentVariant) => {
        writeProgressFile({
          progressPath: params.progressPath,
          resultPath: params.resultPath,
          predictionsPath: params.predictionsPath,
          mode: 'retrieval',
          matrix: true,
          matrixSweep: params.options.matrixSweep,
          retrievalPolicy: 'budget-only',
          retrievalQueryMode: null,
          retrievalBackend: null,
          retrievalRerank: null,
          retrievalTokenizer: null,
          retrievalEmbeddingProvider: null,
          retrievalEmbeddingModel: resolveLocomoRunEmbeddingModel({
            matrix: true,
            matrixSweep: params.options.matrixSweep,
            retrievalEmbeddingProvider: 'hashed',
          }),
          datasetPath: params.datasetPath,
          model: null,
          budgetTokens: params.options.budgetTokens,
          sampleCount: params.plannedSamples.length,
          completedSampleCount: currentVariant.completedSampleCount,
          questionCount: params.totalQuestionCount,
          completedQuestionCount: currentVariant.completedQuestionCount,
          scoreTotal: currentVariant.overallScore,
          contextF1Total: currentVariant.contextF1 ?? 0,
          categories: new Map(),
          usageTotals: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            responsesWithUsage: 0,
          },
          currentPhase: currentVariant.currentPhase,
          currentSampleId: currentVariant.currentSampleId,
          currentSampleEmbeddedTurnCount:
            currentVariant.currentSampleEmbeddedTurnCount,
          currentSampleTurnCount: currentVariant.currentSampleTurnCount,
          currentSampleQuestionCount: currentVariant.currentSampleQuestionCount,
          currentSampleQuestionTotal: currentVariant.currentSampleQuestionTotal,
          variantCount: params.variants.length,
          completedVariantCount: completedVariants.length,
          currentVariant,
          variants: completedVariants,
        });
      },
    });

    completedVariants.push({
      id: evaluatedVariant.id,
      label: evaluatedVariant.label,
      retrievalPolicy: evaluatedVariant.retrievalPolicy,
      retrievalQueryMode: evaluatedVariant.retrievalQueryMode,
      retrievalBackend: evaluatedVariant.retrievalBackend,
      retrievalRerank: evaluatedVariant.retrievalRerank,
      retrievalTokenizer: evaluatedVariant.retrievalTokenizer,
      retrievalEmbeddingProvider: evaluatedVariant.retrievalEmbeddingProvider,
      retrievalEmbeddingModel: evaluatedVariant.retrievalEmbeddingModel,
      sampleCount: evaluatedVariant.sampleCount,
      questionCount: evaluatedVariant.questionCount,
      overallScore: evaluatedVariant.overallScore,
      contextF1: evaluatedVariant.contextF1,
      categories: evaluatedVariant.categories,
    });
    const variantPredictionsPath = path.join(
      matrixPredictionsDir,
      `${evaluatedVariant.id}.json`,
    );
    fs.writeFileSync(
      variantPredictionsPath,
      JSON.stringify(
        {
          suite: 'locomo',
          mode: 'retrieval',
          matrix: true,
          matrixSweep: params.options.matrixSweep,
          variant: {
            id: evaluatedVariant.id,
            label: evaluatedVariant.label,
            retrievalQueryMode: evaluatedVariant.retrievalQueryMode,
            retrievalBackend: evaluatedVariant.retrievalBackend,
            retrievalRerank: evaluatedVariant.retrievalRerank,
            retrievalTokenizer: evaluatedVariant.retrievalTokenizer,
            retrievalEmbeddingProvider:
              evaluatedVariant.retrievalEmbeddingProvider,
            retrievalEmbeddingModel: evaluatedVariant.retrievalEmbeddingModel,
            sampleCount: evaluatedVariant.sampleCount,
            questionCount: evaluatedVariant.questionCount,
          },
          predictions: evaluatedVariant.predictions,
        },
        null,
        2,
      ),
      'utf-8',
    );
    variantPredictionManifests.push({
      id: evaluatedVariant.id,
      label: evaluatedVariant.label,
      retrievalQueryMode: evaluatedVariant.retrievalQueryMode,
      retrievalBackend: evaluatedVariant.retrievalBackend,
      retrievalRerank: evaluatedVariant.retrievalRerank,
      retrievalTokenizer: evaluatedVariant.retrievalTokenizer,
      retrievalEmbeddingProvider: evaluatedVariant.retrievalEmbeddingProvider,
      predictionsPath: variantPredictionsPath,
      sampleCount: evaluatedVariant.sampleCount,
      questionCount: evaluatedVariant.questionCount,
    });
    writeLocomoMatrixPredictionsIndex({
      predictionsPath: params.predictionsPath,
      matrixSweep: params.options.matrixSweep,
      variants: variantPredictionManifests,
    });

    writeProgressFile({
      progressPath: params.progressPath,
      resultPath: params.resultPath,
      predictionsPath: params.predictionsPath,
      mode: 'retrieval',
      matrix: true,
      matrixSweep: params.options.matrixSweep,
      retrievalPolicy: 'budget-only',
      retrievalQueryMode: null,
      retrievalBackend: null,
      retrievalRerank: null,
      retrievalTokenizer: null,
      retrievalEmbeddingProvider: null,
      retrievalEmbeddingModel: resolveLocomoRunEmbeddingModel({
        matrix: true,
        matrixSweep: params.options.matrixSweep,
        retrievalEmbeddingProvider: 'hashed',
      }),
      datasetPath: params.datasetPath,
      model: null,
      budgetTokens: params.options.budgetTokens,
      sampleCount: params.plannedSamples.length,
      completedSampleCount: params.plannedSamples.length,
      questionCount: params.totalQuestionCount,
      completedQuestionCount: params.totalQuestionCount,
      scoreTotal: 0,
      contextF1Total: 0,
      categories: new Map(),
      usageTotals: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        responsesWithUsage: 0,
      },
      currentPhase: null,
      currentSampleId: null,
      currentSampleEmbeddedTurnCount: null,
      currentSampleTurnCount: null,
      currentSampleQuestionCount: null,
      currentSampleQuestionTotal: null,
      variantCount: params.variants.length,
      completedVariantCount: completedVariants.length,
      currentVariant: null,
      variants: completedVariants,
    });
  }

  const bestVariant = pickBestLocomoRetrievalVariant(completedVariants);
  const summary: LocomoRunSummary = {
    suite: 'locomo',
    mode: 'retrieval',
    matrix: true,
    matrixSweep: params.options.matrixSweep,
    retrievalPolicy: 'budget-only',
    retrievalQueryMode: null,
    retrievalBackend: null,
    retrievalRerank: null,
    retrievalTokenizer: null,
    retrievalEmbeddingProvider: null,
    retrievalEmbeddingModel: resolveLocomoRunEmbeddingModel({
      matrix: true,
      matrixSweep: params.options.matrixSweep,
      retrievalEmbeddingProvider: 'hashed',
    }),
    dataset: path.basename(params.datasetPath),
    generatedAt: new Date().toISOString(),
    model: null,
    budgetTokens: params.options.budgetTokens,
    sampleCount: params.plannedSamples.length,
    questionCount: params.totalQuestionCount,
    overallScore: bestVariant?.overallScore ?? null,
    contextF1: bestVariant?.contextF1 ?? null,
    resultPath: params.resultPath,
    predictionsPath: params.predictionsPath,
    categories: bestVariant?.categories ?? {},
    tokenUsage: null,
    variantCount: params.variants.length,
    bestVariantId: bestVariant?.id ?? null,
    bestVariantLabel: bestVariant?.label ?? null,
    variants: completedVariants,
    samples: [],
  };

  fs.writeFileSync(
    params.resultPath,
    JSON.stringify(summary, null, 2),
    'utf-8',
  );
  printSummaryTable(summary);
}

function writeLocomoMatrixPredictionsIndex(params: {
  predictionsPath: string;
  matrixSweep: LocomoRetrievalSweep;
  variants: LocomoRetrievalVariantPredictionManifestEntry[];
}): void {
  fs.writeFileSync(
    params.predictionsPath,
    JSON.stringify(
      {
        suite: 'locomo',
        mode: 'retrieval',
        matrix: true,
        matrixSweep: params.matrixSweep,
        variants: params.variants,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

async function runSingleRetrievalVariantEvaluation(params: {
  variant: LocomoRetrievalVariantPlan;
  plannedSamples: LocomoSample[];
  totalQuestionCount: number;
  budgetTokens: number;
  runtime: LocomoGatewayRuntime;
  runTag: string;
  agentMode: LocomoAgentMode;
  onProgress?: (currentVariant: LocomoRetrievalVariantProgress) => void;
}): Promise<LocomoEvaluatedRetrievalVariant> {
  const predictions: LocomoSamplePrediction[] = [];
  const categories = new Map<number, LocomoCategoryRunningAggregate>();
  let questionCount = 0;
  let scoreTotal = 0;
  let contextF1Total = 0;
  let completedSampleCount = 0;
  const initialSample = params.plannedSamples[0] ?? null;
  const initialSampleTurnCount = initialSample
    ? flattenConversationTurns(initialSample.conversation).length
    : null;

  params.onProgress?.(
    buildLocomoRetrievalVariantProgress({
      variant: params.variant,
      sampleCount: params.plannedSamples.length,
      completedSampleCount,
      questionCount: params.totalQuestionCount,
      completedQuestionCount: questionCount,
      scoreTotal,
      contextF1Total,
      categories,
      currentPhase:
        params.variant.retrievalEmbeddingProvider === 'transformers'
          ? 'warming-embedding'
          : 'ingesting',
      currentSampleId: initialSample?.sample_id || null,
      currentSampleEmbeddedTurnCount: 0,
      currentSampleTurnCount: initialSampleTurnCount,
      currentSampleQuestionCount: null,
      currentSampleQuestionTotal: null,
    }),
  );
  if (params.variant.retrievalEmbeddingProvider === 'transformers') {
    memoryService.warmupEmbeddingProvider(
      params.variant.retrievalEmbeddingProvider,
    );
    params.onProgress?.(
      buildLocomoRetrievalVariantProgress({
        variant: params.variant,
        sampleCount: params.plannedSamples.length,
        completedSampleCount,
        questionCount: params.totalQuestionCount,
        completedQuestionCount: questionCount,
        scoreTotal,
        contextF1Total,
        categories,
        currentPhase: 'ingesting',
        currentSampleId: initialSample?.sample_id || null,
        currentSampleEmbeddedTurnCount: 0,
        currentSampleTurnCount: initialSampleTurnCount,
        currentSampleQuestionCount: null,
        currentSampleQuestionTotal: null,
      }),
    );
  }

  for (const sample of params.plannedSamples) {
    const sampleTurnCount = flattenConversationTurns(
      sample.conversation,
    ).length;
    params.onProgress?.(
      buildLocomoRetrievalVariantProgress({
        variant: params.variant,
        sampleCount: params.plannedSamples.length,
        completedSampleCount,
        questionCount: params.totalQuestionCount,
        completedQuestionCount: questionCount,
        scoreTotal,
        contextF1Total,
        categories,
        currentPhase: 'ingesting',
        currentSampleId: sample.sample_id,
        currentSampleEmbeddedTurnCount: 0,
        currentSampleTurnCount: sampleTurnCount,
        currentSampleQuestionCount: null,
        currentSampleQuestionTotal: null,
      }),
    );
    const session = ingestSampleIntoNativeMemory({
      sample,
      runTag: params.runTag,
      agentMode: params.agentMode,
      runtime: params.runtime,
      retrievalEmbeddingProvider: params.variant.retrievalEmbeddingProvider,
      onProgress: ({ sampleId, embeddedTurnCount, turnCount }) => {
        params.onProgress?.(
          buildLocomoRetrievalVariantProgress({
            variant: params.variant,
            sampleCount: params.plannedSamples.length,
            completedSampleCount,
            questionCount: params.totalQuestionCount,
            completedQuestionCount: questionCount,
            scoreTotal,
            contextF1Total,
            categories,
            currentPhase: 'ingesting',
            currentSampleId: sampleId,
            currentSampleEmbeddedTurnCount: embeddedTurnCount,
            currentSampleTurnCount: turnCount,
            currentSampleQuestionCount: null,
            currentSampleQuestionTotal: null,
          }),
        );
      },
    });
    try {
      const samplePrediction = await evaluateRetrievalSample({
        sample,
        budgetTokens: params.budgetTokens,
        categories,
        session,
        retrievalQueryMode: params.variant.retrievalQueryMode,
        retrievalBackend: params.variant.retrievalBackend,
        retrievalRerank: params.variant.retrievalRerank,
        retrievalTokenizer: params.variant.retrievalTokenizer,
        retrievalEmbeddingProvider: params.variant.retrievalEmbeddingProvider,
        onQuestionProgress: ({ samplePrediction: partialSamplePrediction }) => {
          params.onProgress?.(
            buildLocomoRetrievalVariantProgress({
              variant: params.variant,
              sampleCount: params.plannedSamples.length,
              completedSampleCount,
              questionCount: params.totalQuestionCount,
              completedQuestionCount:
                questionCount + partialSamplePrediction.qa.length,
              scoreTotal:
                scoreTotal +
                partialSamplePrediction.qa.reduce(
                  (total, entry) => total + entry.score,
                  0,
                ),
              contextF1Total:
                contextF1Total +
                partialSamplePrediction.qa.reduce(
                  (total, entry) => total + (entry.contextF1 || 0),
                  0,
                ),
              categories,
              currentPhase: 'evaluating',
              currentSampleId: partialSamplePrediction.sampleId,
              currentSampleEmbeddedTurnCount: null,
              currentSampleTurnCount: null,
              currentSampleQuestionCount: partialSamplePrediction.qa.length,
              currentSampleQuestionTotal: partialSamplePrediction.questionCount,
            }),
          );
        },
      });
      predictions.push(samplePrediction);
      questionCount += samplePrediction.questionCount;
      scoreTotal += samplePrediction.meanScore * samplePrediction.questionCount;
      contextF1Total +=
        (samplePrediction.meanContextF1 || 0) * samplePrediction.questionCount;
      completedSampleCount += 1;
      params.onProgress?.(
        buildLocomoRetrievalVariantProgress({
          variant: params.variant,
          sampleCount: params.plannedSamples.length,
          completedSampleCount,
          questionCount: params.totalQuestionCount,
          completedQuestionCount: questionCount,
          scoreTotal,
          contextF1Total,
          categories,
          currentPhase:
            completedSampleCount < params.plannedSamples.length
              ? 'ingesting'
              : null,
          currentSampleId:
            completedSampleCount < params.plannedSamples.length
              ? params.plannedSamples[completedSampleCount]?.sample_id || null
              : null,
          currentSampleEmbeddedTurnCount:
            completedSampleCount < params.plannedSamples.length ? 0 : null,
          currentSampleTurnCount:
            completedSampleCount < params.plannedSamples.length
              ? flattenConversationTurns(
                  params.plannedSamples[completedSampleCount]?.conversation ||
                    {},
                ).length
              : null,
          currentSampleQuestionCount: null,
          currentSampleQuestionTotal:
            completedSampleCount < params.plannedSamples.length
              ? params.plannedSamples[completedSampleCount]?.qa.length || null
              : null,
        }),
      );
    } finally {
      session.close();
    }
  }

  return {
    ...buildLocomoRetrievalVariantSummary({
      variant: params.variant,
      sampleCount: params.plannedSamples.length,
      questionCount,
      scoreTotal,
      contextF1Total,
      categories,
    }),
    predictions,
  };
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

function shouldWriteQuestionProgressSnapshot(
  completedSampleQuestionCount: number,
): boolean {
  return (
    completedSampleQuestionCount === 1 ||
    completedSampleQuestionCount % LOCOMO_PROGRESS_WRITE_INTERVAL_QUESTIONS ===
      0
  );
}

function shouldWriteIngestionProgressSnapshot(
  embeddedTurnCount: number,
  totalTurnCount: number,
): boolean {
  return (
    embeddedTurnCount === 1 ||
    embeddedTurnCount === totalTurnCount ||
    embeddedTurnCount % LOCOMO_PROGRESS_WRITE_INTERVAL_TURNS === 0
  );
}

function buildCategorySummaries(
  categories: Map<number, LocomoCategoryRunningAggregate>,
  mode: LocomoEvaluationMode,
): Record<string, LocomoCategoryAggregate> {
  const categorySummaries: Record<string, LocomoCategoryAggregate> = {};
  for (const [category, aggregate] of categories.entries()) {
    categorySummaries[String(category)] = {
      meanScore: roundMetric(
        aggregate.scoreTotal / Math.max(aggregate.questionCount, 1),
      ),
      questionCount: aggregate.questionCount,
      contextF1:
        mode === 'retrieval'
          ? roundMetric(
              aggregate.contextF1Total / Math.max(aggregate.questionCount, 1),
            )
          : null,
    };
  }
  return categorySummaries;
}

function writeProgressFile(params: {
  progressPath: string;
  resultPath: string;
  predictionsPath: string;
  mode: LocomoEvaluationMode;
  matrix: boolean;
  matrixSweep: LocomoRetrievalSweep | null;
  retrievalPolicy: LocomoRetrievalPolicy | null;
  retrievalQueryMode: LocomoRetrievalQueryMode | null;
  retrievalBackend: LocomoRetrievalBackend | null;
  retrievalRerank: LocomoRetrievalRerank | null;
  retrievalTokenizer: LocomoRetrievalTokenizer | null;
  retrievalEmbeddingProvider: LocomoRetrievalEmbeddingProvider | null;
  retrievalEmbeddingModel: string | null;
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
  usageTotals: LocomoTokenUsage;
  currentPhase: LocomoProgressPhase | null;
  currentSampleId: string | null;
  currentSampleEmbeddedTurnCount: number | null;
  currentSampleTurnCount: number | null;
  currentSampleQuestionCount: number | null;
  currentSampleQuestionTotal: number | null;
  variantCount: number | null;
  completedVariantCount: number | null;
  currentVariant: LocomoRetrievalVariantProgress | null;
  variants: LocomoRetrievalVariantSummary[];
}): void {
  const bestCompletedVariant = pickBestLocomoRetrievalVariant(params.variants);
  const currentAggregate =
    params.matrix && params.mode === 'retrieval' ? params.currentVariant : null;
  const visibleAggregate = currentAggregate || bestCompletedVariant;
  const progress: LocomoProgressSummary = {
    suite: 'locomo',
    mode: params.mode,
    matrix: params.matrix,
    matrixSweep: params.matrixSweep,
    retrievalPolicy: params.retrievalPolicy,
    retrievalQueryMode: params.retrievalQueryMode,
    retrievalBackend: params.retrievalBackend,
    retrievalRerank: params.retrievalRerank,
    retrievalTokenizer: params.retrievalTokenizer,
    retrievalEmbeddingProvider: params.retrievalEmbeddingProvider,
    retrievalEmbeddingModel: params.retrievalEmbeddingModel,
    dataset: path.basename(params.datasetPath),
    updatedAt: new Date().toISOString(),
    model: params.model,
    budgetTokens: params.budgetTokens,
    sampleCount: params.sampleCount,
    completedSampleCount:
      currentAggregate?.completedSampleCount ?? params.completedSampleCount,
    questionCount: params.questionCount,
    completedQuestionCount:
      currentAggregate?.completedQuestionCount ?? params.completedQuestionCount,
    overallScore:
      params.matrix && params.mode === 'retrieval'
        ? (visibleAggregate?.overallScore ?? null)
        : roundMetric(
            params.scoreTotal / Math.max(params.completedQuestionCount, 1),
          ),
    contextF1:
      params.matrix && params.mode === 'retrieval'
        ? (visibleAggregate?.contextF1 ?? null)
        : params.mode === 'retrieval'
          ? roundMetric(
              params.contextF1Total /
                Math.max(params.completedQuestionCount, 1),
            )
          : null,
    currentPhase: currentAggregate?.currentPhase ?? params.currentPhase,
    currentSampleId:
      currentAggregate?.currentSampleId ?? params.currentSampleId,
    currentSampleEmbeddedTurnCount:
      currentAggregate?.currentSampleEmbeddedTurnCount ??
      params.currentSampleEmbeddedTurnCount,
    currentSampleTurnCount:
      currentAggregate?.currentSampleTurnCount ?? params.currentSampleTurnCount,
    currentSampleQuestionCount:
      currentAggregate?.currentSampleQuestionCount ??
      params.currentSampleQuestionCount,
    currentSampleQuestionTotal:
      currentAggregate?.currentSampleQuestionTotal ??
      params.currentSampleQuestionTotal,
    progressPath: params.progressPath,
    resultPath: params.resultPath,
    predictionsPath: params.predictionsPath,
    categories:
      params.matrix && params.mode === 'retrieval'
        ? (visibleAggregate?.categories ?? {})
        : buildCategorySummaries(params.categories, params.mode),
    tokenUsage:
      params.mode === 'qa' && params.usageTotals.responsesWithUsage > 0
        ? params.usageTotals
        : null,
    variantCount: params.variantCount,
    completedVariantCount: params.completedVariantCount,
    currentVariant: params.currentVariant,
    variants: params.variants,
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
  const firstSample = parsed[0];
  if (firstSample !== undefined) {
    const sample =
      firstSample && typeof firstSample === 'object' ? firstSample : null;
    const sampleId = sample
      ? (sample as { sample_id?: unknown }).sample_id
      : null;
    const conversation = sample
      ? (sample as { conversation?: unknown }).conversation
      : null;
    const qa = sample ? (sample as { qa?: unknown }).qa : null;
    if (
      typeof sampleId !== 'string' ||
      !sampleId.trim() ||
      !conversation ||
      typeof conversation !== 'object' ||
      Array.isArray(conversation) ||
      !Array.isArray(qa)
    ) {
      throw new Error(
        `Invalid LOCOMO sample at index 0 in ${datasetPath}. Expected a non-empty string sample_id, an object conversation, and an array qa.`,
      );
    }
  }
  return parsed as LocomoSample[];
}

function verifyDownloadedDataset(rawBuffer: Uint8Array): void {
  const actualSha256 = createHash('sha256').update(rawBuffer).digest('hex');
  if (actualSha256 !== LOCOMO_DATASET_SHA256) {
    throw new Error(
      `Downloaded LOCOMO dataset failed SHA-256 verification (expected ${LOCOMO_DATASET_SHA256}, got ${actualSha256}).`,
    );
  }
}

function isFetchTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  try {
    return await fetch(input, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isFetchTimeoutError(error)) {
      throw new Error(`${label} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  }
}

async function evaluateSample(params: {
  runtime: LocomoGatewayRuntime;
  requestModel: string;
  sample: LocomoSample;
  budgetTokens: number;
  usageTotals: LocomoTokenUsage;
  categories: Map<number, LocomoCategoryRunningAggregate>;
  onQuestionProgress?: (params: {
    samplePrediction: LocomoSamplePrediction;
  }) => void;
}): Promise<LocomoSamplePrediction> {
  const sampleQa = Array.isArray(params.sample.qa) ? params.sample.qa : [];
  const sampleQuestionCount = sampleQa.length;
  const qaPredictions: Array<LocomoQuestionPrediction | null> = Array.from(
    { length: sampleQuestionCount },
    () => null,
  );
  let nextQuestionIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const questionIndex = nextQuestionIndex;
      nextQuestionIndex += 1;
      if (questionIndex >= sampleQa.length) {
        return;
      }

      const qa = sampleQa[questionIndex];
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
      qaPredictions[questionIndex] = {
        category: prepared.scoreCategory,
        question: qa.question,
        answer,
        prediction,
        score,
        evidence: Array.isArray(qa.evidence) ? qa.evidence : [],
      };

      const existing = params.categories.get(prepared.scoreCategory) || {
        scoreTotal: 0,
        contextF1Total: 0,
        questionCount: 0,
      };
      existing.scoreTotal += score;
      existing.questionCount += 1;
      params.categories.set(prepared.scoreCategory, existing);

      const completedPredictions = qaPredictions.filter(
        (entry): entry is LocomoQuestionPrediction => entry !== null,
      );
      params.onQuestionProgress?.({
        samplePrediction: {
          sampleId: params.sample.sample_id,
          questionCount: sampleQuestionCount,
          meanScore: roundMetric(
            completedPredictions.reduce(
              (total, entry) => total + entry.score,
              0,
            ) / Math.max(completedPredictions.length, 1),
          ),
          meanContextF1: null,
          qa: completedPredictions,
        },
      });
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(LOCOMO_QA_CONCURRENCY, sampleQa.length) },
      () => runWorker(),
    ),
  );

  const completedQaPredictions = qaPredictions.filter(
    (entry): entry is LocomoQuestionPrediction => entry !== null,
  );
  const questionCount = completedQaPredictions.length;
  const meanScore = roundMetric(
    completedQaPredictions.reduce((total, qa) => total + qa.score, 0) /
      Math.max(questionCount, 1),
  );
  return {
    sampleId: params.sample.sample_id,
    questionCount,
    meanScore,
    meanContextF1: null,
    qa: completedQaPredictions,
  };
}

async function evaluateRetrievalSample(params: {
  sample: LocomoSample;
  budgetTokens: number;
  categories: Map<number, LocomoCategoryRunningAggregate>;
  session: LocomoRetrievalSession;
  retrievalQueryMode: LocomoRetrievalQueryMode;
  retrievalBackend: LocomoRetrievalBackend;
  retrievalRerank: LocomoRetrievalRerank;
  retrievalTokenizer: LocomoRetrievalTokenizer;
  retrievalEmbeddingProvider: LocomoRetrievalEmbeddingProvider;
  onQuestionProgress?: (params: {
    samplePrediction: LocomoSamplePrediction;
  }) => void;
}): Promise<LocomoSamplePrediction> {
  const qaPredictions: LocomoQuestionPrediction[] = [];
  const sampleQuestionCount = (params.sample.qa || []).length;

  for (const qa of params.sample.qa || []) {
    const recalledMemories = recallLocomoRetrievalMemories({
      session: params.session,
      query: String(qa.question || '').trim(),
      retrievalQueryMode: params.retrievalQueryMode,
      retrievalBackend: params.retrievalBackend,
      retrievalRerank: params.retrievalRerank,
      retrievalTokenizer: params.retrievalTokenizer,
      retrievalEmbeddingProvider: params.retrievalEmbeddingProvider,
    });
    const budgetedMemories = budgetTruncateRetrievedMemories(
      recalledMemories,
      params.budgetTokens,
    );
    const recalledContext = budgetedMemories
      .map((entry) => entry.content)
      .join('\n\n')
      .trim();
    const retrievedSourceMessageIds = budgetedMemories
      .map((entry) => entry.sourceMessageId)
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value) && value > 0,
      );
    const hitRate = computeRetrievalHitRate({
      sample: params.sample,
      evidence: Array.isArray(qa.evidence) ? qa.evidence : [],
      retrievedContent: recalledContext,
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

function recallLocomoRetrievalMemories(params: {
  session: LocomoRetrievalSession;
  query: string;
  retrievalQueryMode: LocomoRetrievalQueryMode;
  retrievalBackend: LocomoRetrievalBackend;
  retrievalRerank: LocomoRetrievalRerank;
  retrievalTokenizer: LocomoRetrievalTokenizer;
  retrievalEmbeddingProvider: LocomoRetrievalEmbeddingProvider;
}): LocomoRetrievedMemory[] {
  const limit = Math.max(1, params.session.messageIdByDiaId.size);
  return mapRetrievedSemanticMemories(
    memoryService.recallSemanticMemories({
      sessionId: params.session.session.id,
      query: params.query,
      queryMode: params.retrievalQueryMode,
      backend: params.retrievalBackend,
      rerank: params.retrievalRerank,
      tokenizer: params.retrievalTokenizer,
      embeddingProvider: params.retrievalEmbeddingProvider,
      limit,
      limitHardCap: null,
      minConfidence: 0,
    }),
  );
}

function mapRetrievedSemanticMemories(
  memories: Array<{
    content: string;
    source_message_id: number | null;
    confidence: number;
  }>,
): LocomoRetrievedMemory[] {
  return memories.map((memory) => ({
    content: memory.content,
    sourceMessageId: memory.source_message_id ?? null,
    confidence: memory.confidence,
  }));
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
): LocomoFlattenedTurn[] {
  const cached = flattenedConversationTurnsCache.get(conversation);
  if (cached) {
    return cached;
  }

  const sessionNames = Object.keys(conversation || {})
    .filter((key) => /^session_\d+$/.test(key))
    .sort((left, right) => {
      const leftNum = Number.parseInt(left.slice('session_'.length), 10) || 0;
      const rightNum = Number.parseInt(right.slice('session_'.length), 10) || 0;
      return leftNum - rightNum;
    });
  const turns: LocomoFlattenedTurn[] = [];

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

  flattenedConversationTurnsCache.set(conversation, turns);
  return turns;
}

function selectConversationContext(
  conversation: Record<string, unknown>,
  maxTokens: number,
): string {
  const chronologicalTurns = flattenConversationTurns(conversation);
  const selected: LocomoFlattenedTurn[] = [];
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
  retrievalEmbeddingProvider: LocomoRetrievalEmbeddingProvider;
  onProgress?: (progress: LocomoIngestionProgress) => void;
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
  const turns = flattenConversationTurns(params.sample.conversation);
  params.onProgress?.({
    sampleId: params.sample.sample_id,
    embeddedTurnCount: 0,
    turnCount: turns.length,
  });

  for (const [index, turn] of turns.entries()) {
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
    memoryService.storeSemanticMemory({
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
      embeddingProvider: params.retrievalEmbeddingProvider,
      sourceMessageId: messageId,
    });
    const embeddedTurnCount = index + 1;
    if (shouldWriteIngestionProgressSnapshot(embeddedTurnCount, turns.length)) {
      params.onProgress?.({
        sampleId: params.sample.sample_id,
        embeddedTurnCount,
        turnCount: turns.length,
      });
    }
  }

  return {
    session,
    messageIdByDiaId,
    close: () => {},
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

function budgetTruncateRetrievedMemories(
  memories: LocomoRetrievedMemory[],
  budgetTokens: number,
): LocomoRetrievedMemory[] {
  const selected: LocomoRetrievedMemory[] = [];
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
  sample: LocomoSample;
  evidence: string[];
  retrievedContent: string;
}): number {
  const expandedEvidenceIds = expandEvidenceIds(params.evidence);
  if (expandedEvidenceIds.length === 0) return 1;

  const turnMap = new Map<string, LocomoTurn>();
  for (const turn of flattenConversationTurns(params.sample.conversation)) {
    turnMap.set(turn.dia_id, turn);
  }

  const lowerRetrieved = String(params.retrievedContent || '').toLowerCase();
  let found = 0;
  let resolvable = 0;
  for (const evidenceId of expandedEvidenceIds) {
    const turn = turnMap.get(evidenceId);
    if (!turn) {
      console.log(
        `WARNING: dia_id "${evidenceId}" not found in sample ${params.sample.sample_id}`,
      );
      continue;
    }
    resolvable += 1;
    if (turn.text.length < 20) {
      console.log(
        `WARNING: short turn text (${turn.text.length} chars) for dia_id ${evidenceId}: ${JSON.stringify(turn.text)}`,
      );
    }
    if (lowerRetrieved.includes(turn.text.toLowerCase())) {
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
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export const testOnlyLocomoNativeRetrieval = {
  computeContextTokenF1,
  computeRetrievalHitRate,
  expandEvidenceIds,
  normalizeDiaId,
};

async function requestModelAnswer(params: {
  runtime: LocomoGatewayRuntime;
  model: string;
  prompt: string;
  user: string;
}): Promise<{ content: string; usage: LocomoChatCompletionUsage | null }> {
  const url = `${params.runtime.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const response = await fetchWithTimeout(
    url,
    {
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
    },
    LOCOMO_MODEL_CALL_TIMEOUT_MS,
    'LOCOMO model call',
  );

  if (!response.ok) {
    throw new Error(`LOCOMO model call failed with HTTP ${response.status}.`);
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
  target: LocomoTokenUsage,
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
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
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

function buildLocomoVariantComparisonTable(
  variants: LocomoRetrievalVariantSummary[],
): string[] {
  const header = ['Variant', 'HitRate', 'F1', 'C1', 'C2', 'C3', 'C4', 'C5'];
  const rows = variants.map((variant) => [
    variant.label,
    formatLocomoMatrixMetric(variant.overallScore),
    formatLocomoMatrixMetric(variant.contextF1),
    formatLocomoMatrixMetric(variant.categories['1']?.meanScore ?? null),
    formatLocomoMatrixMetric(variant.categories['2']?.meanScore ?? null),
    formatLocomoMatrixMetric(variant.categories['3']?.meanScore ?? null),
    formatLocomoMatrixMetric(variant.categories['4']?.meanScore ?? null),
    formatLocomoMatrixMetric(variant.categories['5']?.meanScore ?? null),
  ]);
  const widths = header.map((title, index) =>
    Math.max(
      title.length,
      ...rows.map((row) => String(row[index] || '').length),
    ),
  );
  return [
    header.map((entry, index) => entry.padEnd(widths[index])).join('  '),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map((row) =>
      row.map((entry, index) => String(entry).padEnd(widths[index])).join('  '),
    ),
  ];
}

function formatLocomoMatrixMetric(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '-';
  }
  return value.toFixed(4);
}

function printSummaryTable(summary: LocomoRunSummary): void {
  console.log('');
  if (
    summary.matrix &&
    summary.mode === 'retrieval' &&
    summary.variants.length
  ) {
    for (const line of buildLocomoVariantComparisonTable(summary.variants)) {
      console.log(line);
    }
    console.log('');
    if (summary.bestVariantLabel) {
      console.log(`Best variant: ${summary.bestVariantLabel}`);
    }
    if (summary.overallScore != null) {
      console.log(`Best hit rate: ${summary.overallScore.toFixed(3)}`);
    }
    if (summary.contextF1 != null) {
      console.log(`Best context F1: ${summary.contextF1.toFixed(3)}`);
    }
    console.log(`Variants: ${summary.variantCount ?? summary.variants.length}`);
    console.log(`Questions per variant: ${summary.questionCount}`);
    console.log(`Predictions JSON: ${summary.predictionsPath}`);
    console.log(`Result JSON: ${summary.resultPath}`);
    return;
  }
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
  const headlineScore = summary.overallScore ?? 0;
  console.log(
    summary.mode === 'retrieval'
      ? `Hit rate: ${headlineScore.toFixed(3)}`
      : `Overall score: ${headlineScore.toFixed(3)}`,
  );
  if (summary.mode === 'retrieval' && summary.retrievalPolicy) {
    console.log(`Recall policy: ${summary.retrievalPolicy}`);
  }
  if (summary.mode === 'retrieval' && summary.retrievalQueryMode) {
    console.log(`Retrieval query: ${summary.retrievalQueryMode}`);
  }
  if (summary.mode === 'retrieval' && summary.retrievalBackend) {
    console.log(`Retrieval backend: ${summary.retrievalBackend}`);
  }
  if (summary.mode === 'retrieval' && summary.retrievalRerank) {
    console.log(`Retrieval rerank: ${summary.retrievalRerank}`);
  }
  if (summary.mode === 'retrieval' && summary.retrievalTokenizer) {
    console.log(`Retrieval tokenizer: ${summary.retrievalTokenizer}`);
  }
  if (summary.mode === 'retrieval' && summary.retrievalEmbeddingProvider) {
    console.log(`Retrieval embedding: ${summary.retrievalEmbeddingProvider}`);
  }
  if (summary.mode === 'retrieval' && summary.retrievalEmbeddingModel) {
    console.log(
      `Retrieval embedding model: ${summary.retrievalEmbeddingModel}`,
    );
  }
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

export const testOnlyLocomoNative = {
  flattenConversationTurns,
};
