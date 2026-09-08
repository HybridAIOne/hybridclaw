/**
 * Consolidation owns durable MEMORY.md updates, unlike daily-note tool writes.
 * File transactions serialize cooperating writers; model results are committed only
 * if their input snapshot is still current. Cleanup preserves non-managed text;
 * external editors do not take this lock.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DAILY_MEMORY_MAX_CHARS,
  readDailyMemoryFile,
  truncateDailyMemoryText,
} from '../../container/shared/daily-memory.js';
import {
  lockMemoryFile,
  writeMemoryFileAtomic,
} from '../../container/shared/memory-file.js';

import {
  currentDateStampInTimezone,
  readUserTimezoneFile,
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
const DAILY_MEMORY_DIGEST_MAX_CHARS = DAILY_MEMORY_MAX_CHARS;
const MEMORY_FILE_MAX_CHARS = 12_000;
const MODEL_MEMORY_ITEM_MAX_CHARS = 280;
const MODEL_MEMORY_MAX_ITEMS_PER_SECTION = 18;
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
  return `language code "${normalizeConsolidationLanguage(language)}"`;
}

export function currentDateStamp(now = new Date(), timezone?: string): string {
  return currentDateStampInTimezone(timezone, now);
}

function resolveWorkspaceTimezone(workspaceDir: string): string | undefined {
  return readUserTimezoneFile(path.join(workspaceDir, 'USER.md'));
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

function truncateLine(value: string, maxChars: number): string {
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

function renderCanonicalMemoryDocument(
  sections: CanonicalMemorySections,
  existing: string,
): string {
  const remaining = new Set(['Facts', 'Decisions', 'Patterns']);
  let active = false;
  let fence: string | null = null;
  const output: string[] = [];
  for (const line of existing
    .replace(DAILY_DIGEST_BLOCK_RE, '')
    .match(/[^\n]*\n|[^\n]+$/g) || []) {
    const fenceMatch = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      output.push(line);
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length
      )
        fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      output.push(line);
      continue;
    }
    const heading = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    if (heading) {
      active = heading[1] === '##' && MEMORY_SECTION_NAMES.has(heading[2]);
      output.push(line);
      if (active && remaining.delete(heading[2])) {
        const key = heading[2].toLowerCase() as keyof CanonicalMemorySections;
        output.push(
          `${line.endsWith('\n') ? '' : '\n'}${sections[key].map((item) => `- ${item}\n`).join('')}`,
        );
      }
    } else if (!active || !/^\s*[-*+]\s+/.test(line)) {
      output.push(line);
    }
  }
  for (const title of remaining) {
    const key = title.toLowerCase() as keyof CanonicalMemorySections;
    output.push(
      `\n\n## ${title}\n${sections[key].map((item) => `- ${item}\n`).join('')}`,
    );
  }
  return output.join('');
}

function fitCanonicalMemoryDocument(
  sections: CanonicalMemorySections,
  existing: string,
): string | null {
  const rendered = renderCanonicalMemoryDocument(sections, existing);
  return rendered.length <= MEMORY_FILE_MAX_CHARS ? rendered : null;
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
  const existingSummary = `## Current durable memory\n\n${params.existing}`;

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
    maxTokens: 2048,
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
  const content = fitCanonicalMemoryDocument(sections, params.existing);
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
  // Keep prose, long entries, and appended notes intact for model cleanup.
  return rawContent.trim();
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
    return normalized;
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
    const newest = params.entries.at(-1);
    if (!newest) return baseContent;
    const summaryBudget =
      digestBudget - fixedDigestLength - `### ${newest.date}\n`.length;
    if (summaryBudget <= 0) return baseContent;
    return renderMemoryContent(
      stripped,
      buildDailyDigest([
        {
          date: newest.date,
          summary: truncateDailyMemoryText(newest.summary, summaryBudget),
        },
      ]),
    );
  }

  return renderMemoryContent(
    stripped,
    buildDailyDigest(params.entries.slice(firstEntryIndex)),
  );
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
    const entry = {
      date,
      summary: truncateDailyMemoryText(
        summary,
        DAILY_MEMORY_DIGEST_MAX_CHARS - `### ${date}\n`.length,
      ),
    };
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
        const release = lockMemoryFile(memoryPath);
        try {
          const existing = fs.existsSync(memoryPath)
            ? fs.readFileSync(memoryPath, 'utf-8')
            : readMemoryTemplate();
          const next = buildMemoryContent({ existing, entries });
          dailyFilesCompiled += entries.length;
          if (next === existing) continue;
          fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
          writeMemoryFileAtomic(memoryPath, next);
          workspacesUpdated += 1;
        } finally {
          release();
        }
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
          next = buildMemoryContent({ existing, entries });
          fallbacksUsed += 1;
        } else {
          modelCleanups += 1;
        }

        if (next === existing) continue;
        const release = lockMemoryFile(memoryPath);
        try {
          const current = fs.existsSync(memoryPath)
            ? fs.readFileSync(memoryPath, 'utf-8')
            : null;
          if (current !== (hasExistingMemory ? existing : null)) {
            logger.warn(
              { agentId: agent.id },
              'Memory changed during cleanup; skipping stale rewrite',
            );
            continue;
          }
          writeMemoryFileAtomic(memoryPath, next);
          workspacesUpdated += 1;
        } finally {
          release();
        }
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
