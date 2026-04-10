import fs from 'node:fs';
import path from 'node:path';
import {
  getOrCreateSession,
  initDatabase,
  recallSemanticMemories,
  storeSemanticMemory,
} from '../memory/db.js';

const LOCOMO_DATASET_URL =
  'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';
const LOCOMO_DATASET_FILENAME = 'locomo10.json';
const LOCOMO_SETUP_MARKER = '.hybridclaw-setup-ok';
const EMBEDDING_DIMENSIONS = 128;
const DEFAULT_TOKEN_BUDGET = 4000;
const DEFAULT_TOP_K = 20;

type LocomoMode = 'recent' | 'semantic';
type LocomoRequestedMode = 'all' | LocomoMode;

interface LocomoTurn {
  speaker: string;
  dia_id: string;
  text: string;
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
  operation: 'setup' | 'run';
  installDir: string;
  budgetTokens: number;
  requestedMode: LocomoRequestedMode;
  numSamples: number | null;
  topK: number;
}

interface CategoryAggregate {
  f1: number;
  hitRate: number;
  questionCount: number;
}

interface ModeAggregate {
  overallF1: number;
  overallHitRate: number;
  totalQuestions: number;
  byCategory: Record<string, CategoryAggregate>;
}

interface SampleModeSummary {
  overallF1: number;
  overallHitRate: number;
  totalQuestions: number;
}

interface SampleSummary {
  sampleId: string;
  modes: Partial<Record<LocomoMode, SampleModeSummary>>;
}

interface LocomoRunSummary {
  suite: 'locomo';
  dataset: string;
  generatedAt: string;
  budgetTokens: number;
  topK: number;
  sampleCount: number;
  requestedMode: LocomoRequestedMode;
  resultPath: string;
  modes: Partial<Record<LocomoMode, ModeAggregate>>;
  samples: SampleSummary[];
}

interface SemanticSessionRecord {
  sessionId: string;
  turns: string[];
}

const STOPWORDS = new Set([
  'a',
  'about',
  'after',
  'all',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'before',
  'between',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'over',
  'she',
  'so',
  'some',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'to',
  'until',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

export async function runLocomoNativeCli(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  if (options.operation === 'setup') {
    await runSetup(options);
    return;
  }
  await runEvaluation(options);
}

function parseArgs(argv: string[]): LocomoRunnerOptions {
  let operation: LocomoRunnerOptions['operation'] | null = null;
  let installDir = '';
  let budgetTokens = DEFAULT_TOKEN_BUDGET;
  let requestedMode: LocomoRequestedMode = 'all';
  let numSamples: number | null = null;
  let topK = DEFAULT_TOP_K;

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
    if (flag === '--mode') {
      const value = nextValue().toLowerCase();
      if (value === 'all' || value === 'recent' || value === 'semantic') {
        requestedMode = value;
      } else {
        throw new Error(
          `Unsupported LOCOMO mode \`${value || '(empty)'}\`. Use all, recent, or semantic.`,
        );
      }
      if (!inlineValue) index += 1;
      continue;
    }
    if (flag === '--num-samples') {
      const parsed = clampPositiveInt(nextValue(), 0);
      numSamples = parsed > 0 ? parsed : null;
      if (!inlineValue) index += 1;
      continue;
    }
    if (flag === '--top-k') {
      topK = clampPositiveInt(nextValue(), DEFAULT_TOP_K);
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
    requestedMode,
    numSamples,
    topK,
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
    const raw = await response.text();
    if (!raw.trim().startsWith('[')) {
      throw new Error('Downloaded LOCOMO dataset is not valid JSON.');
    }
    fs.writeFileSync(datasetPath, raw, 'utf-8');
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
    throw new Error('LOCOMO is not set up. Run `/eval locomo setup` first.');
  }

  const allSamples = loadSamples(datasetPath);
  const selectedSamples =
    options.numSamples && options.numSamples > 0
      ? allSamples.slice(0, options.numSamples)
      : allSamples;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jobDir = path.join(options.installDir, 'jobs', timestamp);
  fs.mkdirSync(jobDir, { recursive: true });

  console.log(`Job dir: ${jobDir}`);
  console.log(`Dataset: ${datasetPath}`);
  console.log(`Samples: ${selectedSamples.length}`);
  console.log(`Budget: ${options.budgetTokens}`);
  console.log(`Mode: ${options.requestedMode}`);
  console.log(`Top K: ${options.topK}`);

  const modes = resolveModes(options.requestedMode);
  const semanticSessions = modes.includes('semantic')
    ? ingestSemanticDataset(selectedSamples, path.join(jobDir, 'locomo.db'))
    : new Map<string, SemanticSessionRecord>();
  const summary = evaluateSamples({
    datasetPath,
    jobDir,
    budgetTokens: options.budgetTokens,
    requestedMode: options.requestedMode,
    topK: options.topK,
    samples: selectedSamples,
    modes,
    semanticSessions,
  });

  fs.writeFileSync(
    summary.resultPath,
    JSON.stringify(summary, null, 2),
    'utf-8',
  );
  printSummaryTable(summary);
}

function resolveModes(requestedMode: LocomoRequestedMode): LocomoMode[] {
  if (requestedMode === 'all') return ['recent', 'semantic'];
  return [requestedMode];
}

function loadSamples(datasetPath: string): LocomoSample[] {
  const raw = fs.readFileSync(datasetPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected LOCOMO dataset array in ${datasetPath}.`);
  }
  return parsed as LocomoSample[];
}

function ingestSemanticDataset(
  samples: LocomoSample[],
  dbPath: string,
): Map<string, SemanticSessionRecord> {
  initDatabase({ dbPath, quiet: true });
  const sessions = new Map<string, SemanticSessionRecord>();

  for (const sample of samples) {
    const sessionId = `locomo-${sample.sample_id}`;
    getOrCreateSession(sessionId, null, 'eval-locomo', 'main');

    const turns = getTurns(sample);
    const formattedTurns: string[] = [];
    for (const turn of turns) {
      const content = formatTurn(turn);
      formattedTurns.push(content);
      storeSemanticMemory({
        sessionId,
        role: 'user',
        source: 'locomo',
        scope: 'episodic',
        metadata: {
          diaId: turn.dia_id,
          speaker: turn.speaker,
        },
        content,
        confidence: 1,
        embedding: embedText(content),
      });
    }
    sessions.set(sample.sample_id, {
      sessionId,
      turns: formattedTurns,
    });
  }

  return sessions;
}

function evaluateSamples(params: {
  datasetPath: string;
  jobDir: string;
  budgetTokens: number;
  requestedMode: LocomoRequestedMode;
  topK: number;
  samples: LocomoSample[];
  modes: LocomoMode[];
  semanticSessions: Map<string, SemanticSessionRecord>;
}): LocomoRunSummary {
  const overall = new Map<LocomoMode, RunningAggregate>();
  const sampleSummaries: SampleSummary[] = [];
  for (const mode of params.modes) {
    overall.set(mode, createRunningAggregate());
  }

  for (const sample of params.samples) {
    const turns = getTurns(sample).map(formatTurn);
    const sampleSummary: SampleSummary = {
      sampleId: sample.sample_id,
      modes: {},
    };

    for (const mode of params.modes) {
      const aggregate = createRunningAggregate();
      for (const qa of sample.qa || []) {
        const answer = answerToString(qa);
        const context =
          mode === 'recent'
            ? buildRecentContext(turns, params.budgetTokens)
            : buildSemanticContext({
                session: params.semanticSessions.get(sample.sample_id) || null,
                question: qa.question,
                topK: params.topK,
                budgetTokens: params.budgetTokens,
              });
        accumulateScore({
          aggregate,
          category: qa.category,
          answer,
          context,
          evidence: qa.evidence || [],
          sample,
        });
      }

      sampleSummary.modes[mode] = finalizeAggregate(aggregate);
      mergeAggregate(overall.get(mode) || createRunningAggregate(), aggregate);
    }

    sampleSummaries.push(sampleSummary);
  }

  const modeSummaries: Partial<Record<LocomoMode, ModeAggregate>> = {};
  for (const mode of params.modes) {
    const aggregate = overall.get(mode);
    if (!aggregate) continue;
    modeSummaries[mode] = finalizeAggregate(aggregate);
  }

  const resultPath = path.join(params.jobDir, 'result.json');
  return {
    suite: 'locomo',
    dataset: path.basename(params.datasetPath),
    generatedAt: new Date().toISOString(),
    budgetTokens: params.budgetTokens,
    topK: params.topK,
    sampleCount: params.samples.length,
    requestedMode: params.requestedMode,
    resultPath,
    modes: modeSummaries,
    samples: sampleSummaries,
  };
}

interface RunningAggregate {
  totalF1: number;
  totalHitRate: number;
  totalQuestions: number;
  byCategory: Map<number, CategoryAggregate>;
}

function createRunningAggregate(): RunningAggregate {
  return {
    totalF1: 0,
    totalHitRate: 0,
    totalQuestions: 0,
    byCategory: new Map<number, CategoryAggregate>(),
  };
}

function accumulateScore(params: {
  aggregate: RunningAggregate;
  category: number;
  answer: string;
  context: string;
  evidence: string[];
  sample: LocomoSample;
}): void {
  const f1 = tokenOverlapF1(params.context, params.answer);
  const hitRate = recallHitRate(params.evidence, params.sample, params.context);
  params.aggregate.totalF1 += f1;
  params.aggregate.totalHitRate += hitRate;
  params.aggregate.totalQuestions += 1;

  const current = params.aggregate.byCategory.get(params.category) || {
    f1: 0,
    hitRate: 0,
    questionCount: 0,
  };
  current.f1 += f1;
  current.hitRate += hitRate;
  current.questionCount += 1;
  params.aggregate.byCategory.set(params.category, current);
}

function mergeAggregate(
  target: RunningAggregate,
  source: RunningAggregate,
): void {
  target.totalF1 += source.totalF1;
  target.totalHitRate += source.totalHitRate;
  target.totalQuestions += source.totalQuestions;
  for (const [category, value] of source.byCategory.entries()) {
    const current = target.byCategory.get(category) || {
      f1: 0,
      hitRate: 0,
      questionCount: 0,
    };
    current.f1 += value.f1;
    current.hitRate += value.hitRate;
    current.questionCount += value.questionCount;
    target.byCategory.set(category, current);
  }
}

function finalizeAggregate(aggregate: RunningAggregate): ModeAggregate {
  const totalQuestions = Math.max(aggregate.totalQuestions, 1);
  const byCategory: Record<string, CategoryAggregate> = {};
  for (const [category, value] of aggregate.byCategory.entries()) {
    byCategory[String(category)] = {
      f1: roundMetric(value.f1 / Math.max(value.questionCount, 1)),
      hitRate: roundMetric(value.hitRate / Math.max(value.questionCount, 1)),
      questionCount: value.questionCount,
    };
  }
  return {
    overallF1: roundMetric(aggregate.totalF1 / totalQuestions),
    overallHitRate: roundMetric(aggregate.totalHitRate / totalQuestions),
    totalQuestions: aggregate.totalQuestions,
    byCategory,
  };
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

function getTurns(sample: LocomoSample): LocomoTurn[] {
  const sessionNames = Object.keys(sample.conversation || {})
    .filter((key) => /^session_\d+$/.test(key))
    .sort((left, right) => {
      const leftNum = Number.parseInt(left.slice('session_'.length), 10) || 0;
      const rightNum = Number.parseInt(right.slice('session_'.length), 10) || 0;
      return leftNum - rightNum;
    });
  const turns: LocomoTurn[] = [];
  for (const sessionName of sessionNames) {
    const raw = sample.conversation[sessionName];
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const speaker = String(record.speaker || '').trim();
      const diaId = String(record.dia_id || '').trim();
      const text = String(record.text || '').trim();
      if (!speaker || !diaId || !text) continue;
      turns.push({
        speaker,
        dia_id: diaId,
        text,
      });
    }
  }
  return turns;
}

function formatTurn(turn: LocomoTurn): string {
  return `${turn.speaker}: ${turn.text}`;
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

function buildRecentContext(turns: string[], budgetTokens: number): string {
  const selected: string[] = [];
  let totalTokens = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const content = turns[index];
    const nextTokens = estimateTokenCount(content);
    if (totalTokens + nextTokens > budgetTokens && selected.length > 0) {
      break;
    }
    selected.unshift(content);
    totalTokens += nextTokens;
  }
  return selected.join('\n');
}

function buildSemanticContext(params: {
  session: SemanticSessionRecord | null;
  question: string;
  topK: number;
  budgetTokens: number;
}): string {
  if (!params.session) return '';
  const memories = recallSemanticMemories({
    sessionId: params.session.sessionId,
    query: params.question,
    limit: params.topK,
    minConfidence: 0,
    queryEmbedding: embedText(params.question),
  });
  const selected: string[] = [];
  let totalTokens = 0;
  for (const memory of memories) {
    const content = String(memory.content || '').trim();
    if (!content) continue;
    const nextTokens = estimateTokenCount(content);
    if (totalTokens + nextTokens > params.budgetTokens && selected.length > 0) {
      break;
    }
    selected.push(content);
    totalTokens += nextTokens;
  }
  return selected.join('\n');
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function embedText(text: string): number[] | null {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;

  const tokens = normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .slice(0, 256);
  if (tokens.length === 0) return null;

  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  for (const token of tokens) {
    const hash = hashToken(token);
    const index = hash % EMBEDDING_DIMENSIONS;
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

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function tokenOverlapF1(prediction: string, reference: string): number {
  const predictionTokens = tokenize(prediction);
  const referenceTokens = tokenize(reference);
  if (predictionTokens.length === 0 || referenceTokens.length === 0) {
    return 0;
  }

  const referenceCounts = new Map<string, number>();
  for (const token of referenceTokens) {
    referenceCounts.set(token, (referenceCounts.get(token) || 0) + 1);
  }

  let matches = 0;
  for (const token of predictionTokens) {
    const remaining = referenceCounts.get(token) || 0;
    if (remaining <= 0) continue;
    matches += 1;
    referenceCounts.set(token, remaining - 1);
  }

  if (matches === 0) return 0;
  const precision = matches / predictionTokens.length;
  const recall = matches / referenceTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

const DIA_ID_PATTERN = /^D(\d+):(\d+)$/i;

function recallHitRate(
  evidenceIds: string[],
  sample: LocomoSample,
  retrievedContent: string,
): number {
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) {
    return 1;
  }
  const expanded = evidenceIds.flatMap(splitEvidenceIds);
  if (expanded.length === 0) return 0;

  const turns = new Map(getTurns(sample).map((turn) => [turn.dia_id, turn]));
  const haystack = retrievedContent.toLowerCase();
  let found = 0;
  let total = 0;

  for (const evidenceId of expanded) {
    const turn = turns.get(evidenceId);
    if (!turn) continue;
    total += 1;
    if (haystack.includes(turn.text.toLowerCase())) {
      found += 1;
    }
  }

  if (total === 0) return 0;
  return found / total;
}

function splitEvidenceIds(value: string): string[] {
  return String(value || '')
    .split(';')
    .flatMap((part) => part.split(/\s+/g))
    .map((part) => normalizeDiaId(part.trim()))
    .filter((part) => DIA_ID_PATTERN.test(part));
}

function normalizeDiaId(value: string): string {
  const match = value.match(DIA_ID_PATTERN);
  if (!match) return value;
  return `D${Number.parseInt(match[1] || '0', 10)}:${Number.parseInt(match[2] || '0', 10)}`;
}

function printSummaryTable(summary: LocomoRunSummary): void {
  console.log('');
  console.log('Mode      HitRate   F1       Questions');
  for (const mode of Object.keys(summary.modes).sort()) {
    const aggregate = summary.modes[mode as LocomoMode];
    if (!aggregate) continue;
    console.log(
      `${mode.padEnd(9)} ${aggregate.overallHitRate.toFixed(3).padEnd(9)} ${aggregate.overallF1.toFixed(3).padEnd(8)} ${String(aggregate.totalQuestions)}`,
    );
  }
  console.log('');
  console.log(`Result JSON: ${summary.resultPath}`);
}
