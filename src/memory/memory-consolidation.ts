import fs from 'node:fs';
import path from 'node:path';

import { listAgents } from '../agents/agent-registry.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import type { MemoryBackend } from './memory-service.js';

export interface MemoryConsolidationConfig {
  decayRate: number;
  staleAfterDays: number;
  minConfidence: number;
}

export interface MemoryConsolidationReport {
  memoriesDecayed: number;
  dailyFilesCompiled: number;
  workspacesUpdated: number;
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

export function currentDateStamp(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

  const today = currentDateStamp();
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
    this.config = { ...config };
  }

  setDecayRate(decayRate: number): void {
    this.config = {
      ...this.config,
      decayRate,
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
      durationMs: Math.max(0, Date.now() - start),
    };
  }
}
