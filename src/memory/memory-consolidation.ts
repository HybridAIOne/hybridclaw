import fs from 'node:fs';
import path from 'node:path';

import {
  currentDateStampInTimezone,
  extractUserTimezone,
} from '../../container/shared/workspace-time.js';
import {
  listAgents,
  resolveAgentForRequest,
} from '../agents/agent-registry.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';
import type { MemoryBackend } from './memory-service.js';

export interface MemoryConsolidationConfig {
  decayRate: number;
  staleAfterDays: number;
  minConfidence: number;
  language?: string;
}

export interface MemoryConsolidationReport {
  memoriesDecayed: number;
  dailyFilesCompiled: number;
  workspacesUpdated: number;
  modelCleanups: number;
  fallbacksUsed: number;
  durationMs: number;
}

const DAILY_MEMORY_BLOCK_START = '<!-- BEGIN DAILY MEMORY DIGEST -->';
const DAILY_MEMORY_BLOCK_END = '<!-- END DAILY MEMORY DIGEST -->';
const DAILY_MEMORY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
// Size budget hierarchy:
// - Each daily source file is truncated before summarization so one oversized
//   note cannot dominate the digest.
// - The digest itself is capped below the full MEMORY.md budget so existing
//   curated sections still have room to survive prompt injection.
// - Individual bullet lines and item counts keep the auto-generated digest
//   scannable and deterministic across reruns.
const DAILY_MEMORY_DIGEST_MAX_CHARS = 6_000;
const DAILY_MEMORY_FILE_MAX_CHARS = 4_000;
const DAILY_MEMORY_SUMMARY_MAX_ITEMS = 6;
const DAILY_MEMORY_LINE_MAX_CHARS = 220;
const MEMORY_FILE_MAX_CHARS = 12_000;
const MODEL_MEMORY_ITEM_MAX_CHARS = 280;
const MODEL_MEMORY_MAX_ITEMS_PER_SECTION = 18;
// Keep this aligned with DEFAULT_MEMORY_TEMPLATE and templates/MEMORY.md.
const MEMORY_SECTION_NAMES = new Set(['Facts', 'Decisions', 'Patterns']);
const DEFAULT_MEMORY_TEMPLATE = `# MEMORY.md - Session Memory

_Things you've learned across conversations. Update as you go._

## Facts

_(Key things you've discovered about the workspace, the user, the project.)_

## Decisions

_(Important choices that were made. Record the "why" so you don't revisit them.)_

## Patterns

_(Recurring things — how the user likes code formatted, common workflows, etc.)_

---

This is your persistent memory. Each session, read this first. Update it when you learn something worth remembering.
`;

interface DailyMemoryEntry {
  date: string;
  summary: string;
}

interface CanonicalMemorySections {
  facts: string[];
  decisions: string[];
  patterns: string[];
}

type MemoryCleanupFallbackReason =
  | 'invalid_model_output'
  | 'empty_model_output'
  | 'memory_budget_exceeded';

interface MemoryCleanupRewriteResult {
  content: string | null;
  fallbackReason: MemoryCleanupFallbackReason | null;
}

const DAILY_DIGEST_PREFIX = [
  DAILY_MEMORY_BLOCK_START,
  '## Daily Memory Digest',
  '',
  '_Auto-compiled from older `memory/YYYY-MM-DD.md` files._',
  '',
].join('\n');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DAILY_DIGEST_BLOCK_RE = new RegExp(
  `${escapeRegExp(DAILY_MEMORY_BLOCK_START)}[\\s\\S]*?${escapeRegExp(DAILY_MEMORY_BLOCK_END)}\\n*`,
  'g',
);

const MEMORY_CLEANUP_SYSTEM_PROMPT = [
  'You consolidate durable assistant memory.',
  'Return strict JSON only with this shape:',
  '{"facts":["..."],"decisions":["..."],"patterns":["..."]}',
  'Rules:',
  '- Merge older daily memory into durable memory when it is still relevant.',
  '- Remove duplicates, near-duplicates, outdated facts, and superseded decisions.',
  '- Prefer the newest valid statement when entries conflict.',
  '- Keep only durable facts, durable decisions, and recurring patterns.',
  '- Drop transient statuses, one-off progress notes, and stale historical context.',
  '- Each item must be a short standalone bullet sentence without markdown bullet prefixes.',
  '- Do not include dates, headings, commentary, markdown fences, or any keys besides facts, decisions, patterns.',
].join('\n');

function normalizeConsolidationLanguage(language?: string): string {
  const normalized = (language || '').trim().toLowerCase();
  return normalized || 'en';
}

function describeConsolidationLanguage(language?: string): string {
  const normalized = normalizeConsolidationLanguage(language);
  if (normalized === 'en' || normalized === 'en-us' || normalized === 'en-gb') {
    return 'English';
  }
  if (normalized === 'de' || normalized === 'de-de') {
    return 'German';
  }
  return normalized;
}

export function currentDateStamp(now = new Date(), timezone?: string): string {
  return currentDateStampInTimezone(timezone, now);
}

function resolveWorkspaceTimezone(workspaceDir: string): string | undefined {
  try {
    const userPath = path.join(workspaceDir, 'USER.md');
    if (!fs.existsSync(userPath)) return undefined;
    return extractUserTimezone(fs.readFileSync(userPath, 'utf-8'));
  } catch {
    return undefined;
  }
}

function readMemoryTemplate(): string {
  try {
    return fs.readFileSync(
      resolveInstallPath('templates', 'MEMORY.md'),
      'utf-8',
    );
  } catch {
    return DEFAULT_MEMORY_TEMPLATE;
  }
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function addUniqueKey(seen: Set<string>, key: string): boolean {
  const normalized = key.trim();
  if (!normalized || seen.has(normalized)) return false;
  seen.add(normalized);
  return true;
}

function truncateLine(
  value: string,
  maxChars = DAILY_MEMORY_LINE_MAX_CHARS,
): string {
  const compact = compactWhitespace(value);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 3).trimEnd()}...`;
}

function normalizeBullet(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/^\s*\[[ xX]\]\s+/, '')
    .trim();
}

function emptyCanonicalMemorySections(): CanonicalMemorySections {
  return {
    facts: [],
    decisions: [],
    patterns: [],
  };
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const fencedMatch = /^```(?:json|markdown)?\s*([\s\S]*?)\s*```$/i.exec(
    trimmed,
  );
  return fencedMatch?.[1]?.trim() || trimmed;
}

function normalizeMemoryItems(
  input: unknown,
  maxChars = MODEL_MEMORY_ITEM_MAX_CHARS,
): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const normalized = truncateLine(normalizeBullet(raw), maxChars);
    const key = normalized.toLowerCase();
    if (!addUniqueKey(seen, key)) continue;
    items.push(normalized);
    if (items.length >= MODEL_MEMORY_MAX_ITEMS_PER_SECTION) break;
  }
  return items;
}

function parseCanonicalMemorySections(
  rawContent: string,
): CanonicalMemorySections | null {
  try {
    const parsed = JSON.parse(stripCodeFence(rawContent)) as Record<
      string,
      unknown
    >;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return {
      facts: normalizeMemoryItems(parsed.facts),
      decisions: normalizeMemoryItems(parsed.decisions),
      patterns: normalizeMemoryItems(parsed.patterns),
    };
  } catch {
    return null;
  }
}

function extractCanonicalMemorySections(
  memoryContent: string,
): CanonicalMemorySections {
  const sections = emptyCanonicalMemorySections();
  let activeSection: keyof CanonicalMemorySections | null = null;

  for (const line of stripDailyDigestBlock(memoryContent)
    .replace(/\r/g, '')
    .split('\n')) {
    const headingMatch = /^##\s+(.+?)\s*$/.exec(line.trim());
    if (headingMatch) {
      const sectionName = headingMatch[1]?.trim();
      if (sectionName === 'Facts') activeSection = 'facts';
      else if (sectionName === 'Decisions') activeSection = 'decisions';
      else if (sectionName === 'Patterns') activeSection = 'patterns';
      else activeSection = null;
      continue;
    }

    if (!activeSection || !/^[-*+]\s+/.test(line.trim())) {
      continue;
    }

    const bullet = truncateLine(
      normalizeBullet(line),
      MODEL_MEMORY_ITEM_MAX_CHARS,
    );
    if (!bullet) continue;
    const current = sections[activeSection];
    if (current.some((entry) => entry.toLowerCase() === bullet.toLowerCase())) {
      continue;
    }
    current.push(bullet);
  }

  return sections;
}

function countCanonicalMemoryItems(sections: CanonicalMemorySections): number {
  return (
    sections.facts.length + sections.decisions.length + sections.patterns.length
  );
}

function renderMemorySection(
  title: string,
  items: string[],
  placeholder: string,
): string {
  return [
    `## ${title}`,
    '',
    items.length > 0
      ? items.map((item) => `- ${item}`).join('\n')
      : placeholder,
  ].join('\n');
}

function renderCanonicalMemoryDocument(
  sections: CanonicalMemorySections,
): string {
  return [
    '# MEMORY.md - Session Memory',
    '',
    "_Things you've learned across conversations. Update as you go._",
    '',
    renderMemorySection(
      'Facts',
      sections.facts,
      '_(No durable facts captured yet.)_',
    ),
    '',
    renderMemorySection(
      'Decisions',
      sections.decisions,
      '_(No durable decisions captured yet.)_',
    ),
    '',
    renderMemorySection(
      'Patterns',
      sections.patterns,
      '_(No recurring patterns captured yet.)_',
    ),
    '',
    '---',
    '',
    'This is your persistent memory. Each session, read this first. Update it when you learn something worth remembering.',
    '',
  ].join('\n');
}

function fitCanonicalMemoryDocument(
  sections: CanonicalMemorySections,
): string | null {
  const fitted: CanonicalMemorySections = {
    facts: [...sections.facts],
    decisions: [...sections.decisions],
    patterns: [...sections.patterns],
  };

  let rendered = renderCanonicalMemoryDocument(fitted);
  while (rendered.length > MEMORY_FILE_MAX_CHARS) {
    const buckets: Array<keyof CanonicalMemorySections> = [
      'patterns',
      'facts',
      'decisions',
    ];
    const target = buckets.find((key) => fitted[key].length > 0);
    if (!target) return null;
    fitted[target].pop();
    rendered = renderCanonicalMemoryDocument(fitted);
  }

  return rendered;
}

function formatDailyEntriesForPrompt(entries: DailyMemoryEntry[]): string {
  if (entries.length === 0) return 'None.';
  return entries
    .map((entry) => [`### ${entry.date}`, entry.summary].join('\n'))
    .join('\n\n');
}

function buildModelCleanupPrompt(params: {
  existing: string;
  entries: DailyMemoryEntry[];
  language?: string;
}): string {
  const sections = extractCanonicalMemorySections(params.existing);
  const existingSummary =
    countCanonicalMemoryItems(sections) > 0
      ? [
          '## Current durable memory',
          '',
          `Facts: ${sections.facts.length > 0 ? sections.facts.map((item) => `- ${item}`).join('\n') : 'None.'}`,
          '',
          `Decisions: ${sections.decisions.length > 0 ? sections.decisions.map((item) => `- ${item}`).join('\n') : 'None.'}`,
          '',
          `Patterns: ${sections.patterns.length > 0 ? sections.patterns.map((item) => `- ${item}`).join('\n') : 'None.'}`,
        ].join('\n')
      : '## Current durable memory\n\nNone.';

  return [
    'Rewrite the durable memory from these sources.',
    '',
    existingSummary,
    '',
    '## Older daily memory summaries',
    '',
    formatDailyEntriesForPrompt(params.entries),
    '',
    `Write every returned item in ${describeConsolidationLanguage(params.language)}.`,
    '',
    'Keep the result concise and durable. If a newer daily note supersedes an existing item, keep only the newer truth.',
  ].join('\n');
}

async function rewriteMemoryContentWithModel(params: {
  agentId: string;
  existing: string;
  entries: DailyMemoryEntry[];
  language?: string;
}): Promise<MemoryCleanupRewriteResult> {
  const runtime = resolveAgentForRequest({ agentId: params.agentId });
  const result = await callAuxiliaryModel({
    task: 'flush_memories',
    agentId: params.agentId,
    fallbackModel: runtime.model,
    fallbackChatbotId: runtime.chatbotId,
    fallbackEnableRag: false,
    messages: [
      { role: 'system', content: MEMORY_CLEANUP_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildModelCleanupPrompt({
          existing: params.existing,
          entries: params.entries,
          language: params.language,
        }),
      },
    ],
    temperature: 0.1,
  });

  const sections = parseCanonicalMemorySections(result.content);
  if (!sections) {
    return {
      content: null,
      fallbackReason: 'invalid_model_output',
    };
  }
  if (
    countCanonicalMemoryItems(sections) === 0 &&
    (countCanonicalMemoryItems(
      extractCanonicalMemorySections(params.existing),
    ) > 0 ||
      params.entries.length > 0)
  ) {
    return {
      content: null,
      fallbackReason: 'empty_model_output',
    };
  }
  const content = fitCanonicalMemoryDocument(sections);
  if (!content) {
    return {
      content: null,
      fallbackReason: 'memory_budget_exceeded',
    };
  }
  return {
    content,
    fallbackReason: null,
  };
}

function summarizeDailyMemory(rawContent: string): string {
  const trimmed = rawContent.trim();
  if (!trimmed) return '';

  const lines = trimmed
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index) => !(index === 0 && line.startsWith('#')));
  const seen = new Set<string>();
  const items: string[] = [];

  for (const line of lines) {
    if (!/^([-*+]|\d+\.)\s+/.test(line) && !/^\[[ xX]\]\s+/.test(line)) {
      continue;
    }
    const normalized = normalizeBullet(line);
    const dedupeKey = normalized.toLowerCase();
    if (!addUniqueKey(seen, dedupeKey)) continue;
    items.push(`- ${truncateLine(normalized)}`);
    if (items.length >= DAILY_MEMORY_SUMMARY_MAX_ITEMS) break;
  }

  return items.join('\n');
}

function buildDailyDigest(entries: DailyMemoryEntry[]): string {
  if (entries.length === 0) return '';

  const body = entries
    .map((entry) => `### ${entry.date}\n${entry.summary}`)
    .join('\n\n');
  return `${DAILY_DIGEST_PREFIX}\n${body}\n${DAILY_MEMORY_BLOCK_END}`;
}

function stripDailyDigestBlock(memoryContent: string): string {
  return memoryContent
    .replace(/\r\n/g, '\n')
    .trimEnd()
    .replace(DAILY_DIGEST_BLOCK_RE, '')
    .trimEnd();
}

function renderMemoryContent(strippedContent: string, block: string): string {
  if (!block) return strippedContent ? `${strippedContent}\n` : '';
  if (!strippedContent) return `${block}\n`;
  return `${strippedContent}\n\n${block}\n`;
}

function dedupeMemorySections(memoryContent: string): string {
  const lines = memoryContent.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];
  let activeSection: string | null = null;
  let seenBullets = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = /^##\s+(.+?)\s*$/.exec(trimmed);
    if (headingMatch) {
      const sectionName = headingMatch[1]?.trim() || '';
      activeSection = MEMORY_SECTION_NAMES.has(sectionName)
        ? sectionName
        : null;
      seenBullets = new Set<string>();
      output.push(line);
      continue;
    }

    if (activeSection && /^[-*+]\s+/.test(trimmed)) {
      const bullet = normalizeBullet(trimmed);
      const key = bullet.toLowerCase();
      if (!addUniqueKey(seenBullets, key)) continue;
      output.push(`- ${bullet}`);
      continue;
    }

    output.push(line);
  }

  return `${output
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

function buildMemoryContent(params: {
  existing: string;
  entries: DailyMemoryEntry[];
}): string {
  const normalized = dedupeMemorySections(params.existing);
  if (normalized.length > MEMORY_FILE_MAX_CHARS) {
    throw new Error(
      `MEMORY.md exceeds ${MEMORY_FILE_MAX_CHARS} chars before adding the daily digest.`,
    );
  }
  const stripped = stripDailyDigestBlock(normalized);
  const baseContent = renderMemoryContent(stripped, '');
  if (params.entries.length === 0) {
    return baseContent;
  }
  const digestBudget =
    MEMORY_FILE_MAX_CHARS - baseContent.length - (stripped ? 2 : 1);
  if (digestBudget <= 0) {
    return baseContent;
  }

  const formattedEntries = params.entries.map(
    (entry) => `### ${entry.date}\n${entry.summary}`,
  );
  let bodyLength = formattedEntries.reduce(
    (total, entry, index) => total + entry.length + (index > 0 ? 2 : 0),
    0,
  );
  const fixedDigestLength =
    DAILY_DIGEST_PREFIX.length + DAILY_MEMORY_BLOCK_END.length + 2;
  let firstEntryIndex = 0;

  while (
    firstEntryIndex < formattedEntries.length &&
    fixedDigestLength + bodyLength > digestBudget
  ) {
    bodyLength -= formattedEntries[firstEntryIndex]?.length || 0;
    if (firstEntryIndex < formattedEntries.length - 1) {
      bodyLength -= 2;
    }
    firstEntryIndex += 1;
  }

  if (firstEntryIndex >= params.entries.length) {
    return baseContent;
  }

  return renderMemoryContent(
    stripped,
    buildDailyDigest(params.entries.slice(firstEntryIndex)),
  );
}

function buildMemoryContentWithFallback(params: {
  existing: string;
  entries: DailyMemoryEntry[];
}): string {
  try {
    return buildMemoryContent(params);
  } catch {
    return dedupeMemorySections(params.existing);
  }
}

function readDailyMemoryFile(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size <= 0) return '';
    if (stats.size <= DAILY_MEMORY_FILE_MAX_CHARS) {
      return fs.readFileSync(filePath, 'utf-8');
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(DAILY_MEMORY_FILE_MAX_CHARS);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return `${buffer.toString('utf8', 0, bytesRead)}\n...[truncated]`;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function collectDailyMemoryEntries(workspaceDir: string): DailyMemoryEntry[] {
  const dailyDir = path.join(workspaceDir, 'memory');
  if (!fs.existsSync(dailyDir)) return [];

  const today = currentDateStamp(
    undefined,
    resolveWorkspaceTimezone(workspaceDir),
  );
  const selected: DailyMemoryEntry[] = [];
  let usedChars = 0;
  for (const name of fs
    .readdirSync(dailyDir)
    .sort((left, right) => right.localeCompare(left))) {
    const match = DAILY_MEMORY_FILE_RE.exec(name);
    if (!match) continue;
    const date = match[1];
    if (!date || date >= today) continue;
    const filePath = path.join(dailyDir, name);
    const content = readDailyMemoryFile(filePath);
    if (content == null) continue;
    if (!content.trim()) continue;
    const summary = summarizeDailyMemory(content);
    if (!summary) continue;
    const entry = { date, summary };
    const candidate = `### ${entry.date}\n${entry.summary}`;
    const nextSize = candidate.length + (selected.length > 0 ? 2 : 0);
    if (
      selected.length > 0 &&
      usedChars + nextSize > DAILY_MEMORY_DIGEST_MAX_CHARS
    ) {
      break;
    }
    selected.push(entry);
    usedChars += nextSize;
    if (usedChars >= DAILY_MEMORY_DIGEST_MAX_CHARS) {
      break;
    }
  }
  return selected.reverse();
}

export class MemoryConsolidationEngine {
  private readonly backend: MemoryBackend;
  private config: MemoryConsolidationConfig;

  constructor(backend: MemoryBackend, config: MemoryConsolidationConfig) {
    this.backend = backend;
    this.config = {
      ...config,
      language: normalizeConsolidationLanguage(config.language),
    };
  }

  setDecayRate(decayRate: number): void {
    this.config = {
      ...this.config,
      decayRate,
    };
  }

  setLanguage(language: string): void {
    this.config = {
      ...this.config,
      language: normalizeConsolidationLanguage(language),
    };
  }

  consolidate(): MemoryConsolidationReport {
    const start = Date.now();
    const memoriesDecayed = this.backend.decaySemanticMemories({
      decayRate: this.config.decayRate,
      staleAfterDays: this.config.staleAfterDays,
      minConfidence: this.config.minConfidence,
    });
    let dailyFilesCompiled = 0;
    let workspacesUpdated = 0;
    for (const agent of listAgents()) {
      const workspaceDir = agentWorkspaceDir(agent.id);
      if (!fs.existsSync(workspaceDir)) continue;
      try {
        const entries = collectDailyMemoryEntries(workspaceDir);
        const memoryPath = path.join(workspaceDir, 'MEMORY.md');
        const existing = fs.existsSync(memoryPath)
          ? fs.readFileSync(memoryPath, 'utf-8')
          : readMemoryTemplate();
        const next = buildMemoryContent({ existing, entries });
        dailyFilesCompiled += entries.length;
        if (next === existing) continue;
        fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
        fs.writeFileSync(memoryPath, next, 'utf-8');
        workspacesUpdated += 1;
      } catch (err) {
        logger.warn(
          { agentId: agent.id, workspaceDir, err },
          'Memory consolidation skipped a workspace after a file error',
        );
      }
    }
    return {
      memoriesDecayed,
      dailyFilesCompiled,
      workspacesUpdated,
      modelCleanups: 0,
      fallbacksUsed: 0,
      durationMs: Math.max(0, Date.now() - start),
    };
  }

  async consolidateWithCleanup(): Promise<MemoryConsolidationReport> {
    const start = Date.now();
    const memoriesDecayed = this.backend.decaySemanticMemories({
      decayRate: this.config.decayRate,
      staleAfterDays: this.config.staleAfterDays,
      minConfidence: this.config.minConfidence,
    });
    let dailyFilesCompiled = 0;
    let workspacesUpdated = 0;
    let modelCleanups = 0;
    let fallbacksUsed = 0;

    for (const agent of listAgents()) {
      const workspaceDir = agentWorkspaceDir(agent.id);
      if (!fs.existsSync(workspaceDir)) continue;

      try {
        const entries = collectDailyMemoryEntries(workspaceDir);
        const memoryPath = path.join(workspaceDir, 'MEMORY.md');
        const hasExistingMemory = fs.existsSync(memoryPath);
        if (!hasExistingMemory && entries.length === 0) {
          continue;
        }

        const existing = hasExistingMemory
          ? fs.readFileSync(memoryPath, 'utf-8')
          : readMemoryTemplate();
        dailyFilesCompiled += entries.length;

        let next: string | null = null;
        try {
          const rewriteResult = await rewriteMemoryContentWithModel({
            agentId: agent.id,
            existing,
            entries,
            language: this.config.language,
          });
          next = rewriteResult.content;
          if (!next && rewriteResult.fallbackReason) {
            logger.warn(
              {
                agentId: agent.id,
                workspaceDir,
                fallbackReason: rewriteResult.fallbackReason,
              },
              'Model-backed memory cleanup returned unusable output; falling back to deterministic consolidation',
            );
          }
        } catch (err) {
          logger.warn(
            { agentId: agent.id, workspaceDir, err },
            'Model-backed memory cleanup failed; falling back to deterministic consolidation',
          );
        }

        if (!next) {
          next = buildMemoryContentWithFallback({ existing, entries });
          fallbacksUsed += 1;
        } else {
          modelCleanups += 1;
        }

        if (next === existing) continue;
        fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
        fs.writeFileSync(memoryPath, next, 'utf-8');
        workspacesUpdated += 1;
      } catch (err) {
        logger.warn(
          { agentId: agent.id, workspaceDir, err },
          'Memory consolidation skipped a workspace after a file error',
        );
      }
    }

    return {
      memoriesDecayed,
      dailyFilesCompiled,
      workspacesUpdated,
      modelCleanups,
      fallbacksUsed,
      durationMs: Math.max(0, Date.now() - start),
    };
  }
}
