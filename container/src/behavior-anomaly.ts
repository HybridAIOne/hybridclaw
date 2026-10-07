/**
 * Behavior anomaly reranker — how unusual a tool call is for this agent,
 * measured against its own approved skill-run trajectories (read-only store).
 *
 * A tuple comes from the tool name and arguments only, so a live call and its
 * recorded twin always share one; no clock, policy, or classifier facts enter
 * it. The score can only raise a tier through `anomaly_reranker` in
 * approval-policy.ts; this module decides no tier and abstains without history.
 */
import fs from 'node:fs';
import path from 'node:path';

export type BehaviorAnomalyStatus = 'scored' | 'abstained' | 'borderline';

export interface BehaviorAnomalyTraceJudgeResult {
  verdict: 'normal' | 'anomalous' | 'inconclusive' | 'error';
  score: number | null;
  reason: string;
}

export interface BehaviorAnomalyScore {
  score: number;
  threshold: number | null;
  reason: string;
  status: BehaviorAnomalyStatus;
  model: 'order2_markov_frequency_v1';
  trajectoryCount: number;
  tuple: string;
  traceJudge?: BehaviorAnomalyTraceJudgeResult;
}

export interface BehaviorAnomalyInput {
  toolName: string;
  args: Record<string, unknown>;
}

interface TrajectoryToolUse {
  name?: unknown;
  blocked?: unknown;
  is_error?: unknown;
  approval_decision?: unknown;
  arguments?: { content?: unknown } | null;
}

interface TrajectoryRecord {
  agent_id?: unknown;
  tools_used?: unknown;
}

interface TrajectoryFile {
  path: string;
  signature: string;
}

interface CachedTrajectoryFile {
  signature: string;
  sequences: string[][];
}

interface AgentBehaviorModel {
  loadedAtMs: number;
  trajectoryCount: number;
  totalTuples: number;
  tupleCounts: Map<string, number>;
  contextCounts: Map<string, number>;
  transitionCounts: Map<string, Map<string, number>>;
  threshold: number | null;
}

const MODEL_NAME = 'order2_markov_frequency_v1' as const;
const DEFAULT_MIN_TRAJECTORIES = 50;
const DEFAULT_EPSILON = 0.02;
const DEFAULT_THRESHOLD_QUANTILE = 0.99;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_ANOMALY_STORE_DIR_ENV =
  'HYBRIDCLAW_BEHAVIOR_ANOMALY_TRAJECTORY_STORE_DIR';
const FIELD_SEPARATOR = '\u001f';
const CONTEXT_SEPARATOR = '\u001e';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function safeFilePart(raw: string): string {
  return raw.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function parsePositiveInteger(raw: unknown, fallback: number): number {
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseInt(raw, 10)
        : NaN;
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function parseNonNegativeInteger(raw: unknown, fallback: number): number {
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseInt(raw, 10)
        : NaN;
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function parsePositiveNumber(raw: unknown, fallback: number): number {
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseFloat(raw)
        : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Trajectory arguments are best-effort training signals only.
  }
  return {};
}

function firstStringField(
  args: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function classifyPathTarget(rawPath: string): string {
  const value = rawPath.trim();
  if (!value) return 'unknown';
  if (/^https?:\/\//i.test(value)) return 'network';
  if (value.startsWith('/workspace') || value.startsWith('./')) {
    return 'workspace';
  }
  if (
    value.startsWith('/tmp') ||
    value.startsWith('/private/tmp') ||
    value.includes('/tmp/')
  ) {
    return 'scratch';
  }
  if (value.startsWith('/etc') || value.startsWith('/var')) return 'system';
  if (value.startsWith('/Users') || value.startsWith('~')) return 'home';
  if (value.startsWith('.')) return 'workspace';
  return value.includes('/') ? 'path' : 'named';
}

function classifyTarget(input: BehaviorAnomalyInput): string {
  const toolName = input.toolName.trim().toLowerCase();
  const args = input.args;
  const url = firstStringField(args, ['url', 'uri', 'href']);
  if (url) return /^https?:\/\//i.test(url) ? 'network' : 'url';
  const pathValue = firstStringField(args, [
    'path',
    'file',
    'filename',
    'target',
    'destination',
    'cwd',
  ]);
  if (pathValue) return classifyPathTarget(pathValue);
  const command = firstStringField(args, ['command', 'cmd']);
  if (command) {
    const urlMatch = command.match(/https?:\/\/[^\s"'`<>]+/i);
    if (urlMatch) return 'network';
    const pathMatch = command.match(/(?:^|\s)(\/[^\s"'`;,|&()<>]+)/);
    if (pathMatch?.[1]) return classifyPathTarget(pathMatch[1]);
  }
  if (toolName === 'message') {
    const action = firstStringField(args, ['action']);
    return action === 'send' ? 'message-send' : 'message-read';
  }
  if (toolName.startsWith('browser_')) return 'browser';
  return 'unknown';
}

// Only argument-derived classes: a class that follows from the tool name alone
// repeats the tool field and never splits a tuple.
function classifyAction(args: Record<string, unknown>): string {
  const command = firstStringField(args, ['command', 'cmd']);
  if (!command) return 'call';
  if (/\b(?:npm|pnpm|yarn|pip|uv)\s+(?:install|add)\b/i.test(command)) {
    return 'install';
  }
  if (/\b(?:rm|unlink|delete)\b/i.test(command)) return 'delete';
  if (/\bgit\b/i.test(command)) return 'git';
  if (/\b(?:curl|wget|ssh|scp)\b/i.test(command)) return 'network';
  return 'command';
}

// Training replays raw trajectory tool uses, so live scoring must derive the
// tuple from the same tool name + args. Approval-classifier facts (action keys,
// path/host hints) depend on the loaded policy and session state; mixing them
// in makes calls miss their own history and shift across policy reloads.
// No time-of-day field (owner call, 2026-10-03): a 4-hour UTC bucket made a
// familiar call look novel, and elevated it, whenever it ran in a new window.
export function buildBehaviorTuple(input: BehaviorAnomalyInput): string {
  return [
    classifyAction(input.args),
    classifyTarget(input),
    normalizeToken(input.toolName) || 'tool',
  ].join(FIELD_SEPARATOR);
}

function contextKey(previous: string[]): string {
  return previous.join(CONTEXT_SEPARATOR);
}

function addCount(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) || 0) + by);
}

function incrementTransition(
  model: Pick<AgentBehaviorModel, 'contextCounts' | 'transitionCounts'>,
  previous: string[],
  tuple: string,
): void {
  if (previous.length < 2) return;
  const key = contextKey(previous.slice(-2));
  addCount(model.contextCounts, key);
  let next = model.transitionCounts.get(key);
  if (!next) {
    next = new Map();
    model.transitionCounts.set(key, next);
  }
  addCount(next, tuple);
}

function scoreTupleWithModel(
  model: Pick<
    AgentBehaviorModel,
    'totalTuples' | 'tupleCounts' | 'contextCounts' | 'transitionCounts'
  >,
  previous: string[],
  tuple: string,
): number {
  if (model.totalTuples <= 0 || model.tupleCounts.size === 0) return 0;
  const vocabularySize = Math.max(1, model.tupleCounts.size);
  const tupleCount = model.tupleCounts.get(tuple) || 0;
  const frequencyProbability =
    (tupleCount + 1) / (model.totalTuples + vocabularySize);
  const frequencyRarity = 1 - frequencyProbability;
  if (previous.length < 2) return clamp01(frequencyRarity);

  const key = contextKey(previous.slice(-2));
  const contextCount = model.contextCounts.get(key) || 0;
  const transitionCount = model.transitionCounts.get(key)?.get(tuple) || 0;
  const transitionProbability =
    (transitionCount + 1) / (contextCount + vocabularySize);
  return clamp01((frequencyRarity + (1 - transitionProbability)) / 2);
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * q) - 1),
  );
  return sorted[index] ?? null;
}

function isApprovedToolUse(tool: TrajectoryToolUse): boolean {
  if (tool.blocked === true) return false;
  const decision = String(tool.approval_decision || '').trim();
  return decision !== 'required' && decision !== 'denied';
}

function normalizeTrajectoryToolUses(
  record: TrajectoryRecord,
): TrajectoryToolUse[] {
  if (!Array.isArray(record.tools_used)) return [];
  return record.tools_used.filter(
    (tool): tool is TrajectoryToolUse =>
      Boolean(tool) && typeof tool === 'object' && !Array.isArray(tool),
  );
}

function readTrajectoryRecords(filePath: string): TrajectoryRecord[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as TrajectoryRecord)
            : null;
        } catch {
          return null;
        }
      })
      .filter((record): record is TrajectoryRecord => Boolean(record));
  } catch {
    return [];
  }
}

// The writer names each day's file after the agent (`skillRunTrajectoryFilePath`
// in src/skills/skill-run-trajectories.ts), so other agents' files are never
// opened. The signature lets a reload re-read only the files that changed.
function listAgentTrajectoryFiles(
  storeDir: string,
  agentId: string,
): TrajectoryFile[] {
  const fileName = `${safeFilePart(agentId)}.jsonl`;
  const out: TrajectoryFile[] = [];
  try {
    for (const dateEntry of fs.readdirSync(storeDir, { withFileTypes: true })) {
      if (!dateEntry.isDirectory()) continue;
      const filePath = path.join(storeDir, dateEntry.name, fileName);
      try {
        const stat = fs.statSync(filePath);
        out.push({ path: filePath, signature: `${stat.mtimeMs}:${stat.size}` });
      } catch {
        // No trajectories for this agent on that day.
      }
    }
  } catch {
    return [];
  }
  return out;
}

function readAgentSequences(filePath: string, agentId: string): string[][] {
  const sequences: string[][] = [];
  for (const record of readTrajectoryRecords(filePath)) {
    // Distinct agent ids can share a sanitized file name.
    if (String(record.agent_id || '').trim() !== agentId) continue;
    const sequence = normalizeTrajectoryToolUses(record)
      .filter(isApprovedToolUse)
      .map((tool) =>
        buildBehaviorTuple({
          toolName: String(tool.name || 'tool'),
          args: parseJsonObject(tool.arguments?.content),
        }),
      );
    if (sequence.length > 0) sequences.push(sequence);
  }
  return sequences;
}

function buildModel(sequences: string[][]): AgentBehaviorModel {
  const model: AgentBehaviorModel = {
    loadedAtMs: Date.now(),
    trajectoryCount: sequences.length,
    totalTuples: 0,
    tupleCounts: new Map(),
    contextCounts: new Map(),
    transitionCounts: new Map(),
    threshold: null,
  };

  for (const sequence of sequences) {
    const previous: string[] = [];
    for (const tuple of sequence) {
      addCount(model.tupleCounts, tuple);
      model.totalTuples += 1;
      incrementTransition(model, previous, tuple);
      previous.push(tuple);
    }
  }

  const trainingScores: number[] = [];
  for (const sequence of sequences) {
    const previous: string[] = [];
    for (const tuple of sequence) {
      trainingScores.push(scoreTupleWithModel(model, previous, tuple));
      previous.push(tuple);
    }
  }
  model.threshold = quantile(trainingScores, DEFAULT_THRESHOLD_QUANTILE);
  return model;
}

export class BehaviorAnomalyReranker {
  private readonly storeDir: string;
  private readonly agentId: string;
  private readonly minTrajectories: number;
  private readonly epsilon: number;
  private readonly cacheTtlMs: number;
  private model: AgentBehaviorModel | null = null;
  private files = new Map<string, CachedTrajectoryFile>();
  private recentTuples: string[] = [];
  private traceJudgeResults = new Map<
    string,
    BehaviorAnomalyTraceJudgeResult
  >();

  constructor(options?: {
    storeDir?: string;
    agentId?: string;
    minTrajectories?: number;
    epsilon?: number;
    cacheTtlMs?: number;
  }) {
    this.storeDir =
      options?.storeDir || process.env[DEFAULT_ANOMALY_STORE_DIR_ENV] || '';
    this.agentId =
      options?.agentId ||
      String(process.env.HYBRIDCLAW_AGENT_ID || '').trim() ||
      'default';
    this.minTrajectories =
      options?.minTrajectories ||
      parsePositiveInteger(
        process.env.HYBRIDCLAW_BEHAVIOR_ANOMALY_MIN_TRAJECTORIES,
        DEFAULT_MIN_TRAJECTORIES,
      );
    this.epsilon =
      options?.epsilon ||
      parsePositiveNumber(
        process.env.HYBRIDCLAW_BEHAVIOR_ANOMALY_EPSILON,
        DEFAULT_EPSILON,
      );
    this.cacheTtlMs =
      options?.cacheTtlMs ??
      parseNonNegativeInteger(
        process.env.HYBRIDCLAW_BEHAVIOR_ANOMALY_CACHE_TTL_MS,
        DEFAULT_CACHE_TTL_MS,
      );
    this.model = this.getModel();
  }

  score(input: BehaviorAnomalyInput): BehaviorAnomalyScore {
    const tuple = buildBehaviorTuple(input);
    const model = this.getModel();
    if (!model || !this.storeDir) {
      return {
        score: 0,
        threshold: null,
        reason:
          'behavior anomaly reranker abstained: no trajectory store configured',
        status: 'abstained',
        model: MODEL_NAME,
        trajectoryCount: 0,
        tuple,
      };
    }
    if (model.trajectoryCount < this.minTrajectories) {
      return {
        score: 0,
        threshold: model.threshold,
        reason: `behavior anomaly reranker abstained: ${model.trajectoryCount}/${this.minTrajectories} approved trajectories available`,
        status: 'abstained',
        model: MODEL_NAME,
        trajectoryCount: model.trajectoryCount,
        tuple,
      };
    }
    if (model.threshold == null) {
      return {
        score: 0,
        threshold: null,
        reason:
          'behavior anomaly reranker abstained: no approved tool-call baseline',
        status: 'abstained',
        model: MODEL_NAME,
        trajectoryCount: model.trajectoryCount,
        tuple,
      };
    }

    const score = scoreTupleWithModel(model, this.recentTuples, tuple);
    const traceJudge = this.traceJudgeResults.get(tuple);
    if (traceJudge) {
      const adjustedScore =
        traceJudge.verdict === 'anomalous'
          ? Math.max(score, model.threshold + this.epsilon + 0.000_001)
          : Math.min(
              score,
              Math.max(0, model.threshold - this.epsilon - 0.000_001),
            );
      return {
        score: adjustedScore,
        threshold: model.threshold,
        reason: `behavior anomaly borderline resolved by F11 trace-judge ${traceJudge.verdict}: ${traceJudge.reason}`,
        status: 'scored',
        model: MODEL_NAME,
        trajectoryCount: model.trajectoryCount,
        tuple,
        traceJudge,
      };
    }
    const distance = score - model.threshold;
    if (Math.abs(distance) <= this.epsilon) {
      return {
        score,
        threshold: model.threshold,
        reason:
          'behavior anomaly score is borderline; F11 trace-judge second opinion required before tier elevation',
        status: 'borderline',
        model: MODEL_NAME,
        trajectoryCount: model.trajectoryCount,
        tuple,
      };
    }
    return {
      score,
      threshold: model.threshold,
      reason:
        score > model.threshold
          ? `behavior anomaly score ${score.toFixed(3)} exceeds adaptive threshold ${model.threshold.toFixed(3)}`
          : `behavior anomaly score ${score.toFixed(3)} is below adaptive threshold ${model.threshold.toFixed(3)}`,
      status: 'scored',
      model: MODEL_NAME,
      trajectoryCount: model.trajectoryCount,
      tuple,
    };
  }

  recordApprovedTuple(tuple: string): void {
    this.recentTuples.push(tuple);
    if (this.recentTuples.length > 32) {
      this.recentTuples = this.recentTuples.slice(-32);
    }
  }

  recordTraceJudgeResult(
    tuple: string,
    result: BehaviorAnomalyTraceJudgeResult,
  ): void {
    this.traceJudgeResults.set(tuple, result);
    if (this.traceJudgeResults.size > 128) {
      const firstKey = this.traceJudgeResults.keys().next().value;
      if (firstKey) this.traceJudgeResults.delete(firstKey);
    }
  }

  private getModel(): AgentBehaviorModel | null {
    if (!this.storeDir) return null;
    const existing = this.model;
    const nowMs = Date.now();
    if (
      existing &&
      this.cacheTtlMs > 0 &&
      nowMs - existing.loadedAtMs < this.cacheTtlMs
    ) {
      return existing;
    }

    // Past days' files never change, so a reload re-reads only today's file.
    const files = new Map<string, CachedTrajectoryFile>();
    let changed = false;
    for (const file of listAgentTrajectoryFiles(this.storeDir, this.agentId)) {
      const cached = this.files.get(file.path);
      if (cached?.signature === file.signature) {
        files.set(file.path, cached);
        continue;
      }
      changed = true;
      files.set(file.path, {
        signature: file.signature,
        sequences: readAgentSequences(file.path, this.agentId),
      });
    }
    changed ||= files.size !== this.files.size;
    this.files = files;
    if (existing && !changed) {
      existing.loadedAtMs = nowMs;
      return existing;
    }

    this.model = buildModel(
      [...files.values()].flatMap((file) => file.sequences),
    );
    return this.model;
  }
}
