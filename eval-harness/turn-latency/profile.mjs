#!/usr/bin/env node
/**
 * Turn-latency profiler — the lap timer for "how fast is a HybridClaw turn".
 *
 * Reads what the gateway already records (audit wire logs, the model-response
 * debug log and the last-prompt dump) and prints where wall time goes: per
 * model call, per round trip, per tool, and in the gateway before and after
 * the agent runs. It fits a per-provider latency model
 * (floor + ms per 1K prompt tokens + ms per output token) so a prompt-size
 * change can be translated into seconds before it ships.
 *
 * Read-only. It never talks to the gateway or a provider; run it against a
 * data dir with real traffic (`HYBRIDCLAW_DATA_DIR`, default ~/.hybridclaw/data).
 *
 *   node eval-harness/turn-latency/profile.mjs [--days 14] [--source gateway.chat]
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined
    ? args[index + 1]
    : fallback;
};
const DAYS = Number(flag('days', '14'));
const SOURCE = flag('source', null);
const DATA_DIR =
  process.env.HYBRIDCLAW_DATA_DIR ||
  path.join(os.homedir(), '.hybridclaw', 'data');
const DISCOVERY_TOOLS = new Set([
  'skills_list',
  'tool_catalog',
  'hybridai__list_connectors',
]);

const q = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))],
  );
};
const fmt = (value) => (value == null ? '-' : String(value));

/** Least squares y = Xb via normal equations (small column counts only). */
function leastSquares(rows, columns) {
  const n = columns.length;
  const a = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (const [x, y] of rows) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) a[i][j] += x[i] * x[j];
      a[i][n] += x[i] * y;
    }
  }
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++)
      if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    if (Math.abs(a[i][i]) < 1e-9) return null;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = a[r][i] / a[i][i];
      for (let c = i; c <= n; c++) a[r][c] -= f * a[i][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

async function readAuditTurns() {
  const auditDir = path.join(DATA_DIR, 'audit');
  const cutoff = Date.now() - DAYS * 86_400_000;
  const turns = new Map();
  const toolDurations = new Map();
  const toolErrors = new Map();
  const systemPrompts = [];
  let sessionDirs = [];
  try {
    sessionDirs = await fs.readdir(auditDir);
  } catch {
    return { turns, toolDurations, toolErrors, systemPrompts };
  }
  for (const dir of sessionDirs) {
    const file = path.join(auditDir, dir, 'wire.jsonl');
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoff) continue;
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const event = record.event;
      if (!event || typeof event !== 'object' || !record.timestamp) continue;
      const ts = Date.parse(record.timestamp);
      const key = `${record.sessionId}\u0000${record.runId}`;
      let turn = turns.get(key);
      if (!turn) {
        turn = { tools: [], toolMs: [], errors: 0, samples: [] };
        turns.set(key, turn);
      }
      switch (event.type) {
        case 'turn.start':
          turn.start = ts;
          turn.source = event.source;
          break;
        case 'agent.start':
          turn.agent = ts;
          if (typeof event.systemPrompt === 'string')
            systemPrompts.push(event.systemPrompt);
          break;
        case 'model.usage':
          turn.usage = ts;
          turn.modelMs = event.durationMs;
          turn.calls = event.modelCalls;
          turn.provider = event.provider;
          turn.model = event.model;
          turn.samples = Array.isArray(event.performanceSamples)
            ? event.performanceSamples
            : [];
          break;
        case 'turn.end':
          turn.end = ts;
          break;
        case 'tool.call':
          turn.tools.push(event.toolName);
          break;
        case 'tool.result': {
          const ms = event.durationMs || 0;
          turn.toolMs.push(ms);
          if (!toolDurations.has(event.toolName))
            toolDurations.set(event.toolName, []);
          toolDurations.get(event.toolName).push(ms);
          if (event.isError) {
            turn.errors += 1;
            toolErrors.set(
              event.toolName,
              (toolErrors.get(event.toolName) || 0) + 1,
            );
          }
          break;
        }
        default:
          break;
      }
    }
  }
  return { turns, toolDurations, toolErrors, systemPrompts };
}

/** cached_tokens per (provider, prompt_tokens, completion_tokens) from the debug log. */
async function readCachedTokens() {
  const cached = new Map();
  let text;
  try {
    text = await fs.readFile(
      path.join(DATA_DIR, 'gateway', 'model-responses.log'),
      'utf8',
    );
  } catch {
    return cached;
  }
  const prefix = '[model-response-debug] ';
  for (const line of text.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    let record;
    try {
      record = JSON.parse(line.slice(prefix.length));
    } catch {
      continue;
    }
    if (
      record.kind !== 'streaming_response' &&
      record.kind !== 'non_streaming_response'
    )
      continue;
    const usage = record.response?.usage;
    if (!usage) continue;
    const details = usage.prompt_tokens_details || {};
    const key = `${record.provider}\u0000${usage.prompt_tokens || 0}\u0000${usage.completion_tokens || 0}`;
    if (!cached.has(key)) {
      cached.set(
        key,
        details.cached_tokens ?? usage.cache_read_input_tokens ?? null,
      );
    }
  }
  return cached;
}

async function readLastPrompt() {
  let text;
  try {
    text = await fs.readFile(path.join(DATA_DIR, 'last_prompt.jsonl'), 'utf8');
  } catch {
    return null;
  }
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const record = JSON.parse(lines[i]);
      if (record.request?.body) return record;
    } catch {
      /* skip */
    }
  }
  return null;
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function printTurns(turns) {
  const complete = [...turns.values()].filter(
    (t) =>
      t.start && t.end && t.modelMs != null && (!SOURCE || t.source === SOURCE),
  );
  section(`Turns (last ${DAYS} days${SOURCE ? `, source=${SOURCE}` : ''})`);
  const bySource = new Map();
  for (const t of complete) {
    if (!bySource.has(t.source)) bySource.set(t.source, []);
    bySource.get(t.source).push(t);
  }
  for (const [source, rows] of [...bySource.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const wall = rows.map((t) => t.end - t.start);
    const calls = rows.map((t) => Math.min(t.calls || 0, 6));
    const dist = Array.from(
      { length: 7 },
      (_, i) => calls.filter((c) => c === i).length,
    );
    const single = rows
      .filter((t) => t.calls === 1)
      .map((t) => t.end - t.start);
    const pre = rows.filter((t) => t.agent).map((t) => t.agent - t.start);
    const post = rows.filter((t) => t.usage).map((t) => t.end - t.usage);
    console.log(
      `${source}: n=${rows.length} wall p50=${fmt(q(wall, 0.5))}ms p90=${fmt(q(wall, 0.9))}ms | ` +
        `calls/turn [0..6+]=${dist.join('/')} | single-call wall p50=${fmt(q(single, 0.5))}ms | ` +
        `receipt→agent p50=${fmt(q(pre, 0.5))}ms p90=${fmt(q(pre, 0.9))}ms | ` +
        `agent end→turn end p50=${fmt(q(post, 0.5))}ms`,
    );
  }
  return complete;
}

function printCalls(turns, cachedTokens) {
  section('Model calls by provider/model');
  const byModel = new Map();
  for (const t of turns) {
    for (const s of t.samples) {
      if (!s.durationMs || !s.promptTokens) continue;
      const key = `${t.provider}/${t.model}`;
      if (!byModel.has(key)) byModel.set(key, []);
      const cached = cachedTokens.get(
        `${t.provider}\u0000${s.promptTokens}\u0000${s.completionTokens}`,
      );
      byModel.get(key).push({ ...s, cached });
    }
  }
  for (const [model, rows] of [...byModel.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    if (rows.length < 5) continue;
    const dur = rows.map((r) => r.durationMs);
    const ttft = rows
      .filter((r) => r.firstTextDeltaMs)
      .map((r) => r.firstTextDeltaMs);
    const withCache = rows.filter((r) => r.cached != null);
    const uncached = withCache.map((r) => r.promptTokens - r.cached);
    const tail = rows
      .filter((r) => r.firstTextDeltaMs && r.completionTokens <= 40)
      .map((r) => r.durationMs - r.firstTextDeltaMs);
    console.log(
      `${model}: n=${rows.length} dur p50=${fmt(q(dur, 0.5))}ms p90=${fmt(q(dur, 0.9))}ms | ` +
        `TTFT p50=${fmt(q(ttft, 0.5))}ms (n=${ttft.length}) | prompt p50=${fmt(
          q(
            rows.map((r) => r.promptTokens),
            0.5,
          ),
        )} ` +
        `out p50=${fmt(
          q(
            rows.map((r) => r.completionTokens),
            0.5,
          ),
        )} | ` +
        `uncached p50=${fmt(q(uncached, 0.5))} p90=${fmt(q(uncached, 0.9))} (n=${withCache.length}) | ` +
        `tail after first delta (≤40 out) p50=${fmt(q(tail, 0.5))}ms`,
    );
    const model1 = leastSquares(
      rows.map((r) => [
        [1, r.promptTokens / 1000, r.completionTokens],
        r.durationMs,
      ]),
      ['floor', 'promptK', 'out'],
    );
    if (model1 && rows.length >= 20) {
      console.log(
        `   fit: call_ms ≈ ${model1[0].toFixed(0)} + ${model1[1].toFixed(0)}·promptK + ${model1[2].toFixed(1)}·outTokens`,
      );
    }
    const ttftRows = withCache.filter((r) => r.firstTextDeltaMs);
    const model2 = leastSquares(
      ttftRows.map((r) => [
        [1, r.promptTokens / 1000, (r.promptTokens - r.cached) / 1000],
        r.firstTextDeltaMs,
      ]),
      ['floor', 'promptK', 'uncachedK'],
    );
    if (model2 && ttftRows.length >= 20) {
      console.log(
        `   fit: ttft_ms ≈ ${model2[0].toFixed(0)} + ${model2[1].toFixed(0)}·promptK + ${model2[2].toFixed(0)}·uncachedK (n=${ttftRows.length})`,
      );
    }
  }
}

function printRoundTripWaste(turns, toolErrors) {
  section('Round trips the harness could avoid');
  const modelCalls = turns.reduce((sum, t) => sum + (t.calls || 0), 0);
  const toolCalls = turns.reduce((sum, t) => sum + t.tools.length, 0);
  const discovery = turns.reduce(
    (sum, t) =>
      sum + t.tools.filter((name) => DISCOVERY_TOOLS.has(name)).length,
    0,
  );
  const skillLoads = turns.reduce(
    (sum, t) =>
      sum +
      t.tools.filter(
        (name, i) => name === 'skills_list' && t.tools[i + 1] === 'read',
      ).length,
    0,
  );
  const errors = turns.reduce((sum, t) => sum + t.errors, 0);
  const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : '-');
  console.log(`model calls=${modelCalls} tool calls=${toolCalls}`);
  console.log(
    `discovery calls (${[...DISCOVERY_TOOLS].join(', ')})=${discovery} (${pct(discovery, modelCalls)} of model calls)`,
  );
  console.log(
    `skills_list → read pairs (two round trips to load one skill)=${skillLoads}`,
  );
  console.log(
    `tool errors=${errors} (${pct(errors, toolCalls)} of tool calls; each one is an extra round trip)`,
  );
  const topErrors = [...toolErrors.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  if (topErrors.length)
    console.log(
      `   by tool: ${topErrors.map(([n, c]) => `${n}=${c}`).join(' ')}`,
    );
}

function printTools(toolDurations) {
  section('Tool durations (ms)');
  const rows = [...toolDurations.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 14);
  for (const [name, values] of rows) {
    console.log(
      `${name.padEnd(48)} n=${String(values.length).padStart(4)} p50=${fmt(q(values, 0.5)).padStart(6)} p90=${fmt(q(values, 0.9)).padStart(6)}`,
    );
  }
}

function printSystemPrompt(systemPrompts) {
  if (systemPrompts.length === 0) return;
  section(
    `System prompt sections (median chars over ${systemPrompts.length} turns)`,
  );
  const sizes = new Map();
  for (const prompt of systemPrompts) {
    for (const part of prompt.split(/\n(?=## |# |<[a-z_]+[ >])/)) {
      const title = part.trim().split('\n', 1)[0].slice(0, 56);
      if (!sizes.has(title)) sizes.set(title, []);
      sizes.get(title).push(part.length);
    }
  }
  console.log(
    `total p50=${fmt(
      q(
        systemPrompts.map((p) => p.length),
        0.5,
      ),
    )} chars`,
  );
  const rows = [...sizes.entries()]
    .map(([title, values]) => [title, q(values, 0.5), values.length])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16);
  for (const [title, median, count] of rows) {
    console.log(
      `${String(median).padStart(7)}  x${String(count).padStart(3)}  ${title}`,
    );
  }
}

function printLastPrompt(record) {
  if (!record) return;
  const body = record.request.body;
  const messages = body.messages || body.input || [];
  const tools = body.tools || [];
  const size = (value) => JSON.stringify(value).length;
  const system = messages.filter(
    (m) => m.role === 'system' || m.role === 'developer',
  );
  const history = messages.filter(
    (m) => m.role !== 'system' && m.role !== 'developer',
  );
  section(
    `Latest request body (${record.provider} ${record.model}, ${record.ts || ''})`,
  );
  console.log(
    `total=${size(body)} chars | system=${system.reduce((s, m) => s + size(m), 0)} | ` +
      `history=${history.reduce((s, m) => s + size(m), 0)} (${history.length} msgs) | ` +
      `tools=${tools.reduce((s, t) => s + size(t), 0)} (${tools.length} tools)`,
  );
  const groups = new Map();
  for (const tool of tools) {
    const name = tool.function?.name || tool.name || '';
    const group = name.includes('__')
      ? `mcp:${name.split('__')[0]}`
      : name.startsWith('browser_')
        ? 'browser_*'
        : 'builtin';
    groups.set(group, (groups.get(group) || 0) + size(tool));
  }
  console.log(
    `tool chars by group: ${[...groups.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([g, c]) => `${g}=${c}`)
      .join(' ')}`,
  );
  const largest = tools
    .map((t) => [size(t), t.function?.name || t.name])
    .sort((a, b) => b[0] - a[0])
    .slice(0, 10);
  console.log(
    `largest tools: ${largest.map(([c, n]) => `${n}=${c}`).join(' ')}`,
  );
}

const [
  { turns, toolDurations, toolErrors, systemPrompts },
  cachedTokens,
  lastPrompt,
] = await Promise.all([readAuditTurns(), readCachedTokens(), readLastPrompt()]);
console.log(`data dir: ${DATA_DIR}`);
const complete = printTurns(turns);
printCalls(complete, cachedTokens);
printRoundTripWaste(complete, toolErrors);
printTools(toolDurations);
printSystemPrompt(systemPrompts);
printLastPrompt(lastPrompt);
