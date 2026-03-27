import fs from 'node:fs';
import path from 'node:path';

import { listAgents } from '../agents/agent-registry.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
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
const DAILY_MEMORY_DIGEST_MAX_CHARS = 6_000;
const DAILY_MEMORY_FILE_MAX_CHARS = 4_000;
const DAILY_MEMORY_SUMMARY_MAX_ITEMS = 6;
const DAILY_MEMORY_LINE_MAX_CHARS = 220;
const MEMORY_FILE_MAX_CHARS = 12_000;
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

function currentDateStamp(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (year && month && day) return `${year}-${month}-${day}`;
  return now.toISOString().slice(0, 10);
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

function splitParagraphs(raw: string): string[] {
  return raw
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((paragraph) => compactWhitespace(paragraph))
    .filter(Boolean);
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
    if (!normalized || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    items.push(`- ${truncateLine(normalized)}`);
    if (items.length >= DAILY_MEMORY_SUMMARY_MAX_ITEMS) break;
  }

  if (items.length === 0) {
    const paragraphs = splitParagraphs(trimmed);
    for (const paragraph of paragraphs) {
      const dedupeKey = paragraph.toLowerCase();
      if (!paragraph || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      items.push(`- ${truncateLine(paragraph)}`);
      if (items.length >= DAILY_MEMORY_SUMMARY_MAX_ITEMS) break;
    }
  }

  return items.join('\n');
}

function buildDailyDigest(entries: DailyMemoryEntry[]): string {
  if (entries.length === 0) return '';

  const body = entries
    .map((entry) => `### ${entry.date}\n${entry.summary}`)
    .join('\n\n');
  return [
    DAILY_MEMORY_BLOCK_START,
    '## Daily Memory Digest',
    '',
    '_Auto-compiled from older `memory/YYYY-MM-DD.md` files._',
    '',
    body,
    DAILY_MEMORY_BLOCK_END,
  ].join('\n');
}

function replaceDailyDigestBlock(memoryContent: string, block: string): string {
  const normalized = memoryContent.replace(/\r\n/g, '\n').trimEnd();
  const escapedStart = DAILY_MEMORY_BLOCK_START.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  const escapedEnd = DAILY_MEMORY_BLOCK_END.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  const blockPattern = new RegExp(
    `${escapedStart}[\\s\\S]*?${escapedEnd}\\n*`,
    'm',
  );
  const stripped = normalized.replace(blockPattern, '').trimEnd();
  if (!block) return stripped ? `${stripped}\n` : '';
  if (!stripped) return `${block}\n`;
  return `${stripped}\n\n${block}\n`;
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
      if (!bullet || seenBullets.has(key)) continue;
      seenBullets.add(key);
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
  const candidateEntries = [...params.entries];

  for (;;) {
    const digest = buildDailyDigest(candidateEntries);
    const next = replaceDailyDigestBlock(normalized, digest);
    if (next.length <= MEMORY_FILE_MAX_CHARS || candidateEntries.length === 0) {
      return next;
    }
    candidateEntries.shift();
  }
}

function collectDailyMemoryEntries(workspaceDir: string): DailyMemoryEntry[] {
  const dailyDir = path.join(workspaceDir, 'memory');
  if (!fs.existsSync(dailyDir)) return [];

  const today = currentDateStamp();
  const entries: DailyMemoryEntry[] = [];
  for (const name of fs
    .readdirSync(dailyDir)
    .sort((left, right) => right.localeCompare(left))) {
    const match = DAILY_MEMORY_FILE_RE.exec(name);
    if (!match) continue;
    const date = match[1];
    if (!date || date >= today) continue;
    const filePath = path.join(dailyDir, name);
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    if (!content.trim()) continue;
    const limitedContent =
      content.length > DAILY_MEMORY_FILE_MAX_CHARS
        ? `${content.slice(0, DAILY_MEMORY_FILE_MAX_CHARS)}\n...[truncated]`
        : content;
    const summary = summarizeDailyMemory(limitedContent);
    if (!summary) continue;
    entries.push({ date, summary });
  }

  const selected: DailyMemoryEntry[] = [];
  let usedChars = 0;
  for (const entry of entries) {
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
  }
  return selected.reverse();
}

export class MemoryConsolidationEngine {
  private readonly backend: MemoryBackend;
  private readonly config: MemoryConsolidationConfig;

  constructor(backend: MemoryBackend, config: MemoryConsolidationConfig) {
    this.backend = backend;
    this.config = config;
  }

  consolidate(
    overrides?: Partial<MemoryConsolidationConfig>,
  ): MemoryConsolidationReport {
    const start = Date.now();
    const config = {
      ...this.config,
      ...(overrides || {}),
    };
    const memoriesDecayed = this.backend.decaySemanticMemories({
      decayRate: config.decayRate,
      staleAfterDays: config.staleAfterDays,
      minConfidence: config.minConfidence,
    });
    let dailyFilesCompiled = 0;
    let workspacesUpdated = 0;
    for (const agent of listAgents()) {
      const workspaceDir = agentWorkspaceDir(agent.id);
      if (!fs.existsSync(workspaceDir)) continue;
      const entries = collectDailyMemoryEntries(workspaceDir);
      dailyFilesCompiled += entries.length;
      const memoryPath = path.join(workspaceDir, 'MEMORY.md');
      const existing = fs.existsSync(memoryPath)
        ? fs.readFileSync(memoryPath, 'utf-8')
        : readMemoryTemplate();
      const next = buildMemoryContent({ existing, entries });
      if (next === existing) continue;
      fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
      fs.writeFileSync(memoryPath, next, 'utf-8');
      workspacesUpdated += 1;
    }
    return {
      memoriesDecayed,
      dailyFilesCompiled,
      workspacesUpdated,
      durationMs: Math.max(0, Date.now() - start),
    };
  }
}
