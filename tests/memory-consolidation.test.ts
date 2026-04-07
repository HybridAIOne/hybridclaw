import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { MemoryBackend } from '../src/memory/memory-service.js';

async function loadConsolidationModule(
  workspaces: string | Record<string, string>,
) {
  const workspaceMap =
    typeof workspaces === 'string' ? { main: workspaces } : workspaces;
  vi.doMock('../src/agents/agent-registry.js', () => ({
    listAgents: vi.fn(() =>
      Object.keys(workspaceMap).map((id) => ({
        id,
      })),
    ),
    resolveAgentForRequest: vi.fn((params?: { agentId?: string }) => ({
      agentId: params?.agentId || 'main',
      model: 'gpt-5-nano',
      chatbotId: '',
    })),
  }));
  vi.doMock('../src/infra/ipc.js', () => ({
    agentWorkspaceDir: vi.fn((agentId: string) => workspaceMap[agentId]),
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: {
      warn: vi.fn(),
    },
  }));
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: vi.fn(async () => ({
      provider: 'hybridai',
      model: 'gpt-5-nano',
      content: JSON.stringify({
        facts: [],
        decisions: [],
        patterns: [],
      }),
    })),
  }));
  return import('../src/memory/memory-consolidation.js');
}

function makeBackend(memoriesDecayed = 0): MemoryBackend {
  return {
    decaySemanticMemories: vi.fn(() => memoriesDecayed),
  } as unknown as MemoryBackend;
}

describe.sequential('memory consolidation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../src/agents/agent-registry.js');
    vi.doUnmock('../src/infra/ipc.js');
    vi.doUnmock('../src/providers/auxiliary.js');
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

  test('treats today according to USER.md timezone when selecting daily files', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-07T00:30:00.000Z'));

      const workspaceDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-timezone-'),
      );
      const dailyDir = path.join(workspaceDir, 'memory');
      fs.mkdirSync(dailyDir, { recursive: true });
      fs.writeFileSync(
        path.join(workspaceDir, 'USER.md'),
        '# USER.md\n\n- **Timezone:** America/Los_Angeles\n',
        'utf-8',
      );

      const { MemoryConsolidationEngine, currentDateStamp } =
        await loadConsolidationModule(workspaceDir);
      const laToday = currentDateStamp(
        new Date('2026-04-07T00:30:00.000Z'),
        'America/Los_Angeles',
      );
      const laYesterday = currentDateStamp(
        new Date('2026-04-06T00:30:00.000Z'),
        'America/Los_Angeles',
      );

      fs.writeFileSync(
        path.join(dailyDir, `${laYesterday}.md`),
        '- Durable memory from yesterday.\n',
        'utf-8',
      );
      fs.writeFileSync(
        path.join(dailyDir, `${laToday}.md`),
        '- Still active in the user timezone.\n',
        'utf-8',
      );

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

      expect(report.dailyFilesCompiled).toBe(1);
      expect(memoryContent).toContain('Durable memory from yesterday.');
      expect(memoryContent).not.toContain('Still active in the user timezone.');
    } finally {
      vi.useRealTimers();
    }
  });

  test('ignores prose-only daily memory files instead of synthesizing digest bullets', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-prose-'),
    );
    const dailyDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(dailyDir, { recursive: true });

    const { MemoryConsolidationEngine, currentDateStamp } =
      await loadConsolidationModule(workspaceDir);
    const older = new Date();
    older.setDate(older.getDate() - 1);
    const olderStamp = currentDateStamp(older);

    fs.writeFileSync(
      path.join(dailyDir, `${olderStamp}.md`),
      [
        '# Daily Notes',
        '',
        'This is free-form prose without any bullet structure.',
        '',
        'It should not be converted into a synthetic digest item.',
      ].join('\n'),
      'utf-8',
    );

    const engine = new MemoryConsolidationEngine(makeBackend(), {
      decayRate: 0.1,
      staleAfterDays: 7,
      minConfidence: 0.1,
    });

    const report = engine.consolidate();
    const memoryPath = path.join(workspaceDir, 'MEMORY.md');

    expect(report.dailyFilesCompiled).toBe(0);
    expect(report.workspacesUpdated).toBe(0);
    expect(fs.existsSync(memoryPath)).toBe(false);
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

  test('model-backed cleanup rewrites MEMORY.md without the daily digest block', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-llm-'),
    );
    const dailyDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(dailyDir, { recursive: true });

    const { MemoryConsolidationEngine, currentDateStamp } =
      await loadConsolidationModule(workspaceDir);
    const { callAuxiliaryModel } = await import(
      '../src/providers/auxiliary.js'
    );
    const older = new Date();
    older.setDate(older.getDate() - 1);
    const olderStamp = currentDateStamp(older);

    fs.writeFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      [
        '# MEMORY.md - Session Memory',
        '',
        '## Facts',
        '- Test runner is Jest.',
        '',
        '## Decisions',
        '- Keep broad refactors.',
        '',
        '## Patterns',
        '- Replies should stay long.',
        '',
        '<!-- BEGIN DAILY MEMORY DIGEST -->',
        'stale digest',
        '<!-- END DAILY MEMORY DIGEST -->',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(dailyDir, `${olderStamp}.md`),
      [
        '- Test runner is Vitest.',
        '- Keep changes tightly scoped.',
        '- User prefers concise replies.',
      ].join('\n'),
      'utf-8',
    );

    vi.mocked(callAuxiliaryModel).mockResolvedValueOnce({
      provider: 'hybridai',
      model: 'gpt-5-nano',
      content: JSON.stringify({
        facts: ['Test runner is Vitest.'],
        decisions: ['Keep changes tightly scoped.'],
        patterns: ['User prefers concise replies.'],
      }),
    });

    const engine = new MemoryConsolidationEngine(makeBackend(4), {
      decayRate: 0.1,
      staleAfterDays: 7,
      minConfidence: 0.1,
    });

    const report = await engine.consolidateWithCleanup();
    const memoryContent = fs.readFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      'utf-8',
    );

    expect(report.memoriesDecayed).toBe(4);
    expect(report.dailyFilesCompiled).toBe(1);
    expect(report.workspacesUpdated).toBe(1);
    expect(report.modelCleanups).toBe(1);
    expect(report.fallbacksUsed).toBe(0);
    expect(memoryContent).toContain('Test runner is Vitest.');
    expect(memoryContent).not.toContain('Test runner is Jest.');
    expect(memoryContent).toContain('Keep changes tightly scoped.');
    expect(memoryContent).toContain('User prefers concise replies.');
    expect(memoryContent).not.toContain('BEGIN DAILY MEMORY DIGEST');
  });

  test('model-backed cleanup requests English output by default', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-language-'),
    );
    const dailyDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(dailyDir, { recursive: true });

    const { MemoryConsolidationEngine, currentDateStamp } =
      await loadConsolidationModule(workspaceDir);
    const { callAuxiliaryModel } = await import(
      '../src/providers/auxiliary.js'
    );
    const older = new Date();
    older.setDate(older.getDate() - 1);
    const olderStamp = currentDateStamp(older);

    fs.writeFileSync(
      path.join(dailyDir, `${olderStamp}.md`),
      '- The test suite should stay deterministic.\n',
      'utf-8',
    );

    vi.mocked(callAuxiliaryModel).mockResolvedValueOnce({
      provider: 'hybridai',
      model: 'gpt-5-nano',
      content: JSON.stringify({
        facts: ['The test suite should stay deterministic.'],
        decisions: [],
        patterns: [],
      }),
    });

    const engine = new MemoryConsolidationEngine(makeBackend(1), {
      decayRate: 0.1,
      staleAfterDays: 7,
      minConfidence: 0.1,
    });

    await engine.consolidateWithCleanup();

    expect(callAuxiliaryModel).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 2048,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining(
              'Write every returned item in language code "en".',
            ),
          }),
        ]),
      }),
    );
  });

  test('model-backed cleanup falls back to deterministic digest when the model fails', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-fallback-'),
    );
    const dailyDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(dailyDir, { recursive: true });

    const { MemoryConsolidationEngine, currentDateStamp } =
      await loadConsolidationModule(workspaceDir);
    const { callAuxiliaryModel } = await import(
      '../src/providers/auxiliary.js'
    );
    const older = new Date();
    older.setDate(older.getDate() - 1);
    const olderStamp = currentDateStamp(older);

    fs.writeFileSync(
      path.join(dailyDir, `${olderStamp}.md`),
      '- Durable fallback memory.\n',
      'utf-8',
    );

    vi.mocked(callAuxiliaryModel).mockRejectedValueOnce(
      new Error('model offline'),
    );

    const engine = new MemoryConsolidationEngine(makeBackend(), {
      decayRate: 0.1,
      staleAfterDays: 7,
      minConfidence: 0.1,
    });

    const report = await engine.consolidateWithCleanup();
    const memoryContent = fs.readFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      'utf-8',
    );

    expect(report.modelCleanups).toBe(0);
    expect(report.fallbacksUsed).toBe(1);
    expect(memoryContent).toContain('## Daily Memory Digest');
    expect(memoryContent).toContain('Durable fallback memory.');
  });

  test('logs a fallback reason when model cleanup returns unusable output', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-fallback-log-'),
    );
    const dailyDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(dailyDir, { recursive: true });

    const { MemoryConsolidationEngine, currentDateStamp } =
      await loadConsolidationModule(workspaceDir);
    const { logger } = await import('../src/logger.js');
    const { callAuxiliaryModel } = await import(
      '../src/providers/auxiliary.js'
    );
    const older = new Date();
    older.setDate(older.getDate() - 1);
    const olderStamp = currentDateStamp(older);

    fs.writeFileSync(
      path.join(dailyDir, `${olderStamp}.md`),
      '- Durable fallback memory.\n',
      'utf-8',
    );

    vi.mocked(callAuxiliaryModel).mockResolvedValueOnce({
      provider: 'openai-codex',
      model: 'openai-codex/gpt-5-codex',
      content: 'not valid json',
    });

    const engine = new MemoryConsolidationEngine(makeBackend(), {
      decayRate: 0.1,
      staleAfterDays: 7,
      minConfidence: 0.1,
    });

    const report = await engine.consolidateWithCleanup();

    expect(report.fallbacksUsed).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'main',
        workspaceDir,
        fallbackReason: 'invalid_model_output',
      }),
      'Model-backed memory cleanup returned unusable output; falling back to deterministic consolidation',
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

  test('keeps only the newest digest suffix when existing MEMORY.md leaves limited headroom', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-suffix-'),
    );
    const dailyDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(dailyDir, { recursive: true });

    const { MemoryConsolidationEngine, currentDateStamp } =
      await loadConsolidationModule(workspaceDir);
    const now = new Date();
    for (let offset = 1; offset <= 3; offset += 1) {
      const date = new Date(now);
      date.setDate(date.getDate() - offset);
      const stamp = currentDateStamp(date);
      fs.writeFileSync(
        path.join(dailyDir, `${stamp}.md`),
        `- Recent digest entry ${offset} ${'q'.repeat(180)}\n`,
        'utf-8',
      );
    }
    fs.writeFileSync(
      path.join(workspaceDir, 'MEMORY.md'),
      [
        '# MEMORY.md - Session Memory',
        '',
        '## Facts',
        `- ${'x'.repeat(11_450)}`,
      ].join('\n'),
      'utf-8',
    );

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
    expect(memoryContent).toContain('Recent digest entry 1');
    expect(memoryContent).not.toContain('Recent digest entry 2');
    expect(memoryContent).not.toContain('Recent digest entry 3');
  });

  test('stops reading older daily files once the digest budget is full', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-budget-stop-'),
    );
    const dailyDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(dailyDir, { recursive: true });

    const { MemoryConsolidationEngine, currentDateStamp } =
      await loadConsolidationModule(workspaceDir);
    const now = new Date();
    const entries = Array.from({ length: 40 }, (_, index) => {
      const date = new Date(now);
      date.setDate(date.getDate() - (index + 1));
      const stamp = currentDateStamp(date);
      const filePath = path.join(dailyDir, `${stamp}.md`);
      fs.writeFileSync(
        filePath,
        `- Budget stop entry ${index + 1} ${'z'.repeat(250)}\n`,
        'utf-8',
      );
      return { stamp, filePath };
    });

    const oldestEntry = entries.at(-1);
    expect(oldestEntry).toBeDefined();

    const statSync = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation((filePath) => {
      if (String(filePath) === oldestEntry?.filePath) {
        throw new Error(
          'Oldest file should not be touched after digest budget is full',
        );
      }
      return statSync(filePath);
    });

    try {
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

      expect(report.dailyFilesCompiled).toBeGreaterThan(0);
      expect(memoryContent).toContain('Budget stop entry 1');
      expect(memoryContent).not.toContain('Budget stop entry 40');
    } finally {
      statSpy.mockRestore();
    }
  });

  test('reads only a capped prefix for oversized daily memory files', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-large-daily-'),
    );
    const dailyDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(dailyDir, { recursive: true });

    const { MemoryConsolidationEngine, currentDateStamp } =
      await loadConsolidationModule(workspaceDir);
    const older = new Date();
    older.setDate(older.getDate() - 1);
    const olderStamp = currentDateStamp(older);
    const largeDailyPath = path.join(dailyDir, `${olderStamp}.md`);
    fs.writeFileSync(
      largeDailyPath,
      `- Oversized daily memory ${'x'.repeat(6_000)}\n`,
      'utf-8',
    );

    const readFileSync = fs.readFileSync.bind(fs);
    const readSpy = vi
      .spyOn(fs, 'readFileSync')
      .mockImplementation((filePath, options) => {
        if (String(filePath) === largeDailyPath) {
          throw new Error('Large daily file should not be fully read');
        }
        return readFileSync(filePath, options as never);
      });

    try {
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

      expect(report.dailyFilesCompiled).toBe(1);
      expect(memoryContent).toContain('Oversized daily memory');
      expect(memoryContent).not.toContain(
        'Large daily file should not be fully read',
      );
    } finally {
      readSpy.mockRestore();
    }
  });

  test('skips a workspace when the existing MEMORY.md already exceeds the file budget', async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-oversized-'),
    );
    const memoryPath = path.join(workspaceDir, 'MEMORY.md');
    fs.writeFileSync(
      memoryPath,
      `# MEMORY.md - Session Memory\n\n## Facts\n- ${'x'.repeat(12_500)}\n`,
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

    expect(report.dailyFilesCompiled).toBe(0);
    expect(report.workspacesUpdated).toBe(0);
    expect(fs.readFileSync(memoryPath, 'utf-8')).toContain('x'.repeat(12_500));
  });

  test('continues consolidating other workspaces when one workspace file read fails', async () => {
    const badWorkspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-bad-'),
    );
    const goodWorkspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-memory-consolidation-good-'),
    );
    const badDailyDir = path.join(badWorkspaceDir, 'memory');
    const goodDailyDir = path.join(goodWorkspaceDir, 'memory');
    fs.mkdirSync(badDailyDir, { recursive: true });
    fs.mkdirSync(goodDailyDir, { recursive: true });

    const { MemoryConsolidationEngine, currentDateStamp } =
      await loadConsolidationModule({
        bad: badWorkspaceDir,
        good: goodWorkspaceDir,
      });
    const older = new Date();
    older.setDate(older.getDate() - 1);
    const olderStamp = currentDateStamp(older);

    const badMemoryPath = path.join(badWorkspaceDir, 'MEMORY.md');
    fs.writeFileSync(
      badMemoryPath,
      '# MEMORY.md - Session Memory\n\n## Facts\n- Broken workspace.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(badDailyDir, `${olderStamp}.md`),
      '- This workspace should fail during read.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(goodDailyDir, `${olderStamp}.md`),
      '- This workspace should still be consolidated.\n',
      'utf-8',
    );

    const readFileSync = fs.readFileSync.bind(fs);
    const readSpy = vi
      .spyOn(fs, 'readFileSync')
      .mockImplementation((filePath, options) => {
        if (String(filePath) === badMemoryPath) {
          throw new Error('EACCES: mocked unreadable MEMORY.md');
        }
        return readFileSync(filePath, options as never);
      });

    try {
      const engine = new MemoryConsolidationEngine(makeBackend(), {
        decayRate: 0.1,
        staleAfterDays: 7,
        minConfidence: 0.1,
      });

      const report = engine.consolidate();
      const goodMemoryContent = fs.readFileSync(
        path.join(goodWorkspaceDir, 'MEMORY.md'),
        'utf-8',
      );

      expect(report.dailyFilesCompiled).toBe(1);
      expect(report.workspacesUpdated).toBe(1);
      expect(goodMemoryContent).toContain(
        'This workspace should still be consolidated.',
      );
    } finally {
      readSpy.mockRestore();
    }
  });
});
