import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { MemoryBackend } from '../src/memory/memory-service.js';

async function loadConsolidationModule(workspaceDir: string) {
  vi.doMock('../src/agents/agent-registry.js', () => ({
    listAgents: vi.fn(() => [{ id: 'main' }]),
  }));
  vi.doMock('../src/infra/ipc.js', () => ({
    agentWorkspaceDir: vi.fn(() => workspaceDir),
  }));
  return import('../src/memory/memory-consolidation.js');
}

function makeBackend(memoriesDecayed = 0): MemoryBackend {
  return {
    resetSessionIfExpired: () => null,
    getOrCreateSession: vi.fn(),
    getSessionById: vi.fn(),
    getConversationHistory: vi.fn(() => []),
    getConversationHistoryPage: vi.fn(() => ({
      sessionKey: null,
      mainSessionKey: null,
      history: [],
      branchFamilies: [],
    })),
    getConversationBranchFamilies: vi.fn(() => []),
    getRecentMessages: vi.fn(() => []),
    forkSessionBranch: vi.fn(),
    get: vi.fn(() => null),
    set: vi.fn(),
    delete: vi.fn(() => false),
    list: vi.fn(() => []),
    appendCanonicalMessages: vi.fn(),
    getCanonicalContext: vi.fn(),
    clearCanonicalContext: vi.fn(() => 0),
    addKnowledgeEntity: vi.fn(() => 'entity-1'),
    addKnowledgeRelation: vi.fn(() => 'relation-1'),
    queryKnowledgeGraph: vi.fn(() => []),
    getCompactionCandidateMessages: vi.fn(() => null),
    storeMessage: vi.fn(() => 1),
    storeSemanticMemory: vi.fn(() => 1),
    recallSemanticMemories: vi.fn(() => []),
    forgetSemanticMemory: vi.fn(() => false),
    decaySemanticMemories: vi.fn(() => memoriesDecayed),
    clearSessionHistory: vi.fn(() => 0),
    deleteMessagesBeforeId: vi.fn(() => 0),
    deleteMessagesByIds: vi.fn(() => 0),
    updateSessionSummary: vi.fn(),
    markSessionMemoryFlush: vi.fn(),
  } as unknown as MemoryBackend;
}

describe.sequential('memory consolidation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../src/agents/agent-registry.js');
    vi.doUnmock('../src/infra/ipc.js');
  });

  test('compiles older daily memory files into MEMORY.md and skips today', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-'),
    );
    const dailyDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(dailyDir, { recursive: true });

    const { MemoryConsolidationEngine, currentDateStamp } =
      await loadConsolidationModule(workspaceDir);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const todayStamp = currentDateStamp(today);
    const yesterdayStamp = currentDateStamp(yesterday);

    fs.writeFileSync(
      path.join(dailyDir, `${yesterdayStamp}.md`),
      [
        '# Daily Notes',
        '',
        '- User prefers release updates by Friday.',
        '- Keep memory compaction deterministic.',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(dailyDir, `${todayStamp}.md`),
      '- Still in progress today.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      '# MEMORY.md - Session Memory\n\n## Facts\n- Existing fact.\n',
      'utf-8',
    );

    const engine = new MemoryConsolidationEngine(makeBackend(2), {
      decayRate: 0.1,
      staleAfterDays: 7,
      minConfidence: 0.1,
    });

    const report = engine.consolidate();
    const memoryContent = fs.readFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      'utf-8',
    );

    expect(report.memoriesDecayed).toBe(2);
    expect(report.dailyFilesCompiled).toBe(1);
    expect(report.workspacesUpdated).toBe(1);
    expect(memoryContent).toContain('## Facts');
    expect(memoryContent).toContain('## Daily Memory Digest');
    expect(memoryContent).toContain(`### ${yesterdayStamp}`);
    expect(memoryContent).toContain('User prefers release updates by Friday.');
    expect(memoryContent).not.toContain('Still in progress today.');
  });

  test('re-running consolidation replaces the managed digest instead of duplicating it', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-repeat-'),
    );
    const dailyDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(dailyDir, { recursive: true });

    const older = new Date();
    older.setDate(older.getDate() - 2);
    const { MemoryConsolidationEngine, currentDateStamp } =
      await loadConsolidationModule(workspaceDir);
    const olderStamp = currentDateStamp(older);
    fs.writeFileSync(
      path.join(dailyDir, `${olderStamp}.md`),
      '- Consolidate this once.\n',
      'utf-8',
    );

    const engine = new MemoryConsolidationEngine(makeBackend(), {
      decayRate: 0.1,
      staleAfterDays: 7,
      minConfidence: 0.1,
    });

    const first = engine.consolidate();
    const firstContent = fs.readFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      'utf-8',
    );
    const second = engine.consolidate();
    const secondContent = fs.readFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      'utf-8',
    );

    expect(first.workspacesUpdated).toBe(1);
    expect(second.workspacesUpdated).toBe(0);
    expect(secondContent).toBe(firstContent);
    expect(secondContent.match(/BEGIN DAILY MEMORY DIGEST/g)).toHaveLength(1);
    expect(secondContent).toContain(`### ${olderStamp}`);
  });

  test('deduplicates repeated structured bullets already stored in MEMORY.md', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-dedupe-'),
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      [
        '# MEMORY.md - Session Memory',
        '',
        '## Facts',
        '- User prefers concise replies.',
        '- User prefers concise replies.',
        '',
        '## Decisions',
        '- Keep compaction deterministic.',
        '- Keep compaction deterministic.',
        '',
        '## Patterns',
        '- Use small targeted patches.',
        '- Use small targeted patches.',
      ].join('\n'),
      'utf-8',
    );

    const { MemoryConsolidationEngine } =
      await loadConsolidationModule(workspaceDir);
    const engine = new MemoryConsolidationEngine(makeBackend(), {
      decayRate: 0.1,
      staleAfterDays: 7,
      minConfidence: 0.1,
    });

    const report = engine.consolidate();
    const memoryContent = fs.readFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      'utf-8',
    );

    expect(report.workspacesUpdated).toBe(1);
    expect(memoryContent.match(/User prefers concise replies\./g)).toHaveLength(
      1,
    );
    expect(
      memoryContent.match(/Keep compaction deterministic\./g),
    ).toHaveLength(1);
    expect(memoryContent.match(/Use small targeted patches\./g)).toHaveLength(
      1,
    );
  });

  test('drops oldest daily digest entries first to keep MEMORY.md bounded', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-bounded-'),
    );
    const dailyDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(dailyDir, { recursive: true });

    const { MemoryConsolidationEngine, currentDateStamp } =
      await loadConsolidationModule(workspaceDir);
    const now = new Date();
    for (let offset = 1; offset <= 40; offset += 1) {
      const date = new Date(now);
      date.setDate(date.getDate() - offset);
      const stamp = currentDateStamp(date);
      fs.writeFileSync(
        path.join(dailyDir, `${stamp}.md`),
        [
          `- Durable memory entry ${offset} ${'x'.repeat(180)}`,
          `- Another note ${offset} ${'y'.repeat(180)}`,
        ].join('\n'),
        'utf-8',
      );
    }

    const engine = new MemoryConsolidationEngine(makeBackend(), {
      decayRate: 0.1,
      staleAfterDays: 7,
      minConfidence: 0.1,
    });

    engine.consolidate();
    const memoryContent = fs.readFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      'utf-8',
    );

    expect(memoryContent.length).toBeLessThanOrEqual(12_000);
    expect(memoryContent).toContain('## Daily Memory Digest');
    expect(memoryContent).toContain('Durable memory entry 1');
    expect(memoryContent).not.toContain('Durable memory entry 40');
  });
});
