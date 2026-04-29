import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

const runtimeHome = vi.hoisted(() => {
  const originalDataDir = process.env.HYBRIDCLAW_DATA_DIR;
  const originalHome = process.env.HOME;
  const getBuiltinModule = (
    process as typeof process & {
      getBuiltinModule?: (id: string) => unknown;
    }
  ).getBuiltinModule;
  const fsModule = getBuiltinModule?.('fs') as
    | { mkdtempSync: (prefix: string) => string }
    | undefined;
  const osModule = getBuiltinModule?.('os') as
    | { tmpdir: () => string }
    | undefined;
  const pathModule = getBuiltinModule?.('path') as
    | { join: (...parts: string[]) => string }
    | undefined;
  if (!fsModule || !osModule || !pathModule) {
    throw new Error('Unable to initialize temporary runtime home for tests.');
  }
  const homeDir = fsModule.mkdtempSync(
    pathModule.join(osModule.tmpdir(), 'hybridclaw-hybridai-skills-module-'),
  );
  process.env.HYBRIDCLAW_DATA_DIR = homeDir;
  process.env.HOME = homeDir;
  return { homeDir, originalDataDir, originalHome };
});

import { buildDefaultEvalProfile } from '../src/evals/eval-profile.js';
import {
  type HybridaiSkillFixture,
  handleHybridaiSkillsCommand,
  harvestHybridaiSkillsFixtures,
  readHybridaiSkillsFixtures,
  syncHybridaiSkillsFixturesWithDocs,
  writeHybridaiSkillsFixtures,
} from '../src/evals/hybridai-skills-command.js';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-hybridai-skills-');

afterAll(() => {
  if (runtimeHome.originalDataDir === undefined) {
    delete process.env.HYBRIDCLAW_DATA_DIR;
  } else {
    process.env.HYBRIDCLAW_DATA_DIR = runtimeHome.originalDataDir;
  }
  if (runtimeHome.originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = runtimeHome.originalHome;
  }
  fs.rmSync(runtimeHome.homeDir, { recursive: true, force: true });
});

function writeDoc(dir: string, filename: string, body: string): string {
  const target = path.join(dir, filename);
  fs.writeFileSync(target, body, 'utf8');
  return target;
}

function writeAuditWire(
  dataDir: string,
  sessionId: string,
  events: Array<Record<string, unknown>>,
): string {
  const safeSessionDir =
    sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'session';
  const target = path.join(dataDir, 'audit', safeSessionDir, 'wire.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'metadata',
      protocolVersion: '2.0',
      sessionId,
      createdAt: '2026-04-17T00:00:00.000Z',
    }),
    ...events.map((event, index) =>
      JSON.stringify({
        version: '2.0',
        seq: index + 1,
        timestamp: `2026-04-17T00:00:00.${String(index).padStart(3, '0')}Z`,
        runId: 'run_test',
        sessionId,
        event,
        _prevHash: `prev_${index}`,
        _hash: `hash_${index}`,
      }),
    ),
  ];
  fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  return target;
}

const SAMPLE_DOC = [
  '---',
  'title: Development Skills',
  '---',
  '',
  '# Development Skills',
  '',
  '## code-review',
  '',
  'Body text.',
  '',
  '> 💡 **Tips & Tricks**',
  '>',
  '> Reviews by severity.',
  '',
  '> 🎯 **Try it yourself**',
  '>',
  '> `Review the diff on my current branch for bugs and security issues`',
  '>',
  '> `Review PR #42 and list findings by severity`',
  '>',
  '> **Conversation flow:**',
  '>',
  '> `1. Review the diff on my current branch`',
  '> `2. Show me the exact code path for the auth issue you flagged`',
  '',
  '---',
  '',
  '## apple-music',
  '',
  '> 🎯 **Try it yourself**',
  '>',
  '> `Skip to the next track`',
  '>',
  '> `Use the apple-music skill to play my Focus playlist`',
  '',
  '---',
  '',
  '## code-simplification',
  '',
  '*(Model-invoked, not user-invocable)*',
  '',
  'Body only. No Try it yourself block.',
  '',
].join('\n');

describe('harvestHybridaiSkillsFixtures', () => {
  test('extracts try-it-yourself prompts and attaches them to the right skill', () => {
    const docsRoot = makeTempDir();
    writeDoc(docsRoot, 'development.md', SAMPLE_DOC);

    const set = harvestHybridaiSkillsFixtures(docsRoot);

    const codeReviewTryIt = set.fixtures.filter(
      (fixture) => fixture.skill === 'code-review' && fixture.kind === 'try-it',
    );
    expect(codeReviewTryIt.map((fixture) => fixture.prompt)).toEqual([
      'Review the diff on my current branch for bugs and security issues',
      'Review PR #42 and list findings by severity',
    ]);
  });

  test('splits conversation-flow turns into separate fixtures with the same conversation id', () => {
    const docsRoot = makeTempDir();
    writeDoc(docsRoot, 'development.md', SAMPLE_DOC);

    const set = harvestHybridaiSkillsFixtures(docsRoot);
    const conversation = set.fixtures.filter(
      (fixture) =>
        fixture.skill === 'code-review' && fixture.kind === 'conversation',
    );
    expect(conversation).toHaveLength(2);
    expect(conversation[0].turnIndex).toBe(1);
    expect(conversation[1].turnIndex).toBe(2);
    expect(conversation[0].conversationId).toBe(conversation[1].conversationId);
    expect(conversation[0].prompt).toBe('Review the diff on my current branch');
  });

  test('treats multi-step flow headings as conversation fixtures too', () => {
    const docsRoot = makeTempDir();
    writeDoc(
      docsRoot,
      'development.md',
      SAMPLE_DOC.replace('**Conversation flow:**', '**Multi-step flow:**'),
    );

    const set = harvestHybridaiSkillsFixtures(docsRoot);
    const conversation = set.fixtures.filter(
      (fixture) =>
        fixture.skill === 'code-review' && fixture.kind === 'conversation',
    );
    expect(conversation).toHaveLength(2);
    expect(conversation.map((fixture) => fixture.turnIndex)).toEqual([1, 2]);
  });

  test('marks prompts that name the skill as explicit and others as implicit', () => {
    const docsRoot = makeTempDir();
    writeDoc(docsRoot, 'apple.md', SAMPLE_DOC);

    const set = harvestHybridaiSkillsFixtures(docsRoot);
    const appleMusic = set.fixtures.filter(
      (fixture) => fixture.skill === 'apple-music',
    );
    const modes = appleMusic.map((fixture) => fixture.mode);
    expect(modes).toContain('explicit');
    expect(modes).toContain('implicit');
    const explicit = appleMusic.find((fixture) => fixture.mode === 'explicit');
    expect(explicit?.prompt).toContain('apple-music skill');
  });

  test('skips sections without a try-it block and excludes README', () => {
    const docsRoot = makeTempDir();
    writeDoc(docsRoot, 'development.md', SAMPLE_DOC);
    writeDoc(
      docsRoot,
      'README.md',
      '## decoy-skill\n\n> 🎯 **Try it yourself**\n>\n> `Should not be harvested`\n',
    );

    const set = harvestHybridaiSkillsFixtures(docsRoot);
    const skills = new Set(set.fixtures.map((fixture) => fixture.skill));
    expect(skills.has('code-simplification')).toBe(false);
    expect(skills.has('decoy-skill')).toBe(false);
    expect(set.sourceFiles).toEqual(['development.md']);
  });

  test('returns an empty set when the docs directory is missing', () => {
    const docsRoot = path.join(makeTempDir(), 'does-not-exist');
    const set = harvestHybridaiSkillsFixtures(docsRoot);
    expect(set.fixtures).toEqual([]);
    expect(set.sourceFiles).toEqual([]);
  });
});

describe('fixture store round-trip', () => {
  test('writes JSONL and reads it back with stable ids', () => {
    const docsRoot = makeTempDir();
    writeDoc(docsRoot, 'development.md', SAMPLE_DOC);
    const original = harvestHybridaiSkillsFixtures(docsRoot);

    const dataDir = makeTempDir();
    const paths = writeHybridaiSkillsFixtures(dataDir, original);
    expect(fs.existsSync(paths.fixturesPath)).toBe(true);
    expect(fs.existsSync(paths.metaPath)).toBe(true);

    const reloaded = readHybridaiSkillsFixtures(dataDir);
    expect(
      reloaded?.fixtures.map((fixture: HybridaiSkillFixture) => fixture.id),
    ).toEqual(original.fixtures.map((fixture) => fixture.id));
    expect(reloaded?.sourceFiles).toEqual(['development.md']);
  });

  test('returns null when no fixtures are on disk', () => {
    const dataDir = makeTempDir();
    expect(readHybridaiSkillsFixtures(dataDir)).toBeNull();
  });

  test('refreshes docs-backed fixtures when the source docs change', () => {
    const docsRoot = makeTempDir();
    writeDoc(docsRoot, 'development.md', SAMPLE_DOC);
    const current = harvestHybridaiSkillsFixtures(docsRoot);

    const dataDir = makeTempDir();
    writeHybridaiSkillsFixtures(dataDir, {
      generatedAt: new Date().toISOString(),
      docsRoot,
      sourceFiles: ['development.md'],
      fixtures: [
        {
          id: 'stale:code-review:try-it:1',
          docFile: 'development.md',
          skill: 'code-review',
          prompt: 'stale prompt',
          mode: 'implicit',
          kind: 'try-it',
        },
      ],
    });

    const synced = syncHybridaiSkillsFixturesWithDocs(dataDir, docsRoot);
    expect(synced?.fixtures).toEqual(current.fixtures);
    expect(readHybridaiSkillsFixtures(dataDir)?.fixtures).toEqual(
      current.fixtures,
    );
  });
});

describe('handleHybridaiSkillsCommand dispatch', () => {
  const env = {
    baseUrl: 'http://127.0.0.1:9090/v1',
    apiKey: 'hybridclaw-local',
    model: 'hybridai/gpt-4.1-mini',
    baseModel: 'hybridai/gpt-4.1-mini',
    profile: buildDefaultEvalProfile(),
  };

  test('returns an error (not help) for an unknown subcommand', async () => {
    const dataDir = makeTempDir();
    const result = await handleHybridaiSkillsCommand({
      dataDir,
      env,
      subcommand: 'bogus',
    });
    expect(result.kind).toBe('error');
    expect(result.text).toMatch(/Unknown hybridai-skills command/);
  });

  test('shows help for bare invocation and for explicit help flags', async () => {
    const dataDir = makeTempDir();
    const bare = await handleHybridaiSkillsCommand({ dataDir, env });
    expect(bare.kind).toBe('info');
    expect(bare.text).toMatch(/Usage:/);
    expect(bare.text).toContain(
      '--kind try-it|conversation] [--max N] [--explicit]',
    );
    const withHelp = await handleHybridaiSkillsCommand({
      dataDir,
      env,
      subcommand: 'help',
    });
    expect(withHelp.kind).toBe('info');
  });
});

describe('live runner grading', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeEnv() {
    return {
      baseUrl: 'http://127.0.0.1:9090/v1',
      apiKey: 'hybridclaw-local',
      model: 'hybridai/gpt-4.1-mini',
      baseModel: 'hybridai/gpt-4.1-mini',
      profile: buildDefaultEvalProfile(),
    };
  }

  test('rejects the removed --mode flag', async () => {
    const dataDir = makeTempDir();
    const fixture: HybridaiSkillFixture = {
      id: 'synthetic:pdf:try-it:mode-removed',
      docFile: 'synthetic.md',
      skill: 'pdf',
      prompt: 'Create a one-page PDF invoice for Acme Corp',
      mode: 'implicit',
      kind: 'try-it',
    };
    writeHybridaiSkillsFixtures(dataDir, {
      generatedAt: new Date().toISOString(),
      docsRoot: '',
      sourceFiles: ['synthetic.md'],
      fixtures: [fixture],
    });

    const result = await handleHybridaiSkillsCommand({
      dataDir,
      env: makeEnv(),
      subcommand: 'run',
      args: ['--skill', 'pdf', '--mode', 'explicit'],
    });

    expect(result.kind).toBe('error');
    expect(result.text).toContain('Unknown flag: `--mode`.');
  });

  test('does not short-circuit on explicit-mode fixtures; empty tool trace fails', async () => {
    const dataDir = makeTempDir();
    const fixture: HybridaiSkillFixture = {
      id: 'synthetic:code-review:try-it:1',
      docFile: 'synthetic.md',
      skill: 'code-review',
      prompt: '/code-review review current branch',
      mode: 'explicit',
      kind: 'try-it',
    };
    writeHybridaiSkillsFixtures(dataDir, {
      generatedAt: new Date().toISOString(),
      docsRoot: '',
      sourceFiles: ['synthetic.md'],
      fixtures: [fixture],
    });

    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Sure, I can help with that.',
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await handleHybridaiSkillsCommand({
      dataDir,
      env: makeEnv(),
      subcommand: 'run',
      args: ['--live', '--max', '1'],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('info');
    expect(result.text).toMatch(/Passed\s+0\/1/);
    expect(result.text).toMatch(/Failed\s+1/);
    expect(result.text).toMatch(/synthetic:code-review:try-it:1/);
    expect(result.text).toMatch(/skills=None/);
    expect(result.text).toContain('artefacts=❌');
    expect(result.text).not.toMatch(/session=/);
  });

  test('defaults to fresh-agent per fixture and grades from the audit trace', async () => {
    const dataDir = makeTempDir();
    const fixture: HybridaiSkillFixture = {
      id: 'synthetic:pdf:try-it:1',
      docFile: 'synthetic.md',
      skill: 'pdf',
      prompt: 'Create a one-page PDF invoice for Acme Corp',
      mode: 'implicit',
      kind: 'try-it',
    };
    writeHybridaiSkillsFixtures(dataDir, {
      generatedAt: new Date().toISOString(),
      docsRoot: '',
      sourceFiles: ['synthetic.md'],
      fixtures: [fixture],
    });
    const sessionId = 'sess_pdf_eval_1';
    const executionSessionId = 'sess_pdf_exec_1';
    const tempAgentId = 'eval-cleanup-agent-1';
    const auditPath = writeAuditWire(dataDir, sessionId, [
      {
        type: 'session.start',
        cwd: '/tmp/eval-agent/workspace',
      },
      {
        type: 'tool.call',
        toolCallId: 'tool-1',
        toolName: 'read',
        arguments: { path: 'skills/pdf/SKILL.md' },
      },
      {
        type: 'tool.result',
        toolCallId: 'tool-1',
        toolName: 'read',
        resultSummary: 'pdf skill',
        durationMs: 1,
        isError: false,
        blocked: false,
      },
      {
        type: 'skill.execution',
        skillName: 'pdf',
        outcome: 'success',
      },
    ]);
    const executionAuditPath = writeAuditWire(dataDir, executionSessionId, [
      {
        type: 'session.start',
        cwd: '/tmp/eval-agent/workspace',
      },
    ]);
    const { initDatabase } = await import('../src/memory/db.js');
    const { memoryService } = await import('../src/memory/memory-service.js');
    const { agentWorkspaceDir } = await import('../src/infra/ipc.js');
    initDatabase({ quiet: true });
    memoryService.getOrCreateSession(sessionId, null, 'openai', tempAgentId);
    memoryService.getOrCreateSession(
      executionSessionId,
      null,
      'openai',
      tempAgentId,
    );
    const tempAgentWorkspace = agentWorkspaceDir(tempAgentId);
    fs.mkdirSync(tempAgentWorkspace, { recursive: true });
    fs.writeFileSync(
      path.join(tempAgentWorkspace, 'placeholder.txt'),
      'temp\n',
      'utf8',
    );
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as { model?: string };
      expect(body.model).toContain('__hc_eval=fresh-agent');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Done.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-hybridclaw-session-id': sessionId,
            'x-hybridclaw-execution-session-id': executionSessionId,
            'x-hybridclaw-agent-id': tempAgentId,
            'x-hybridclaw-artifact-count': '1',
          },
        },
      );
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await handleHybridaiSkillsCommand({
      dataDir,
      env: makeEnv(),
      subcommand: 'run',
      args: ['--live', '--max', '1'],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('info');
    expect(result.text).toMatch(/Passed\s+1\/1/);
    expect(result.text).toContain('Profile');
    expect(result.text).toContain('skills=pdf artefacts=✅ tools=read (1)');

    const latestRun = JSON.parse(
      fs.readFileSync(
        path.join(dataDir, 'evals', 'hybridai-skills', 'latest-run.json'),
        'utf8',
      ),
    ) as {
      profile: { workspaceMode: string };
      runs: Array<{
        results: Array<{ sessionId?: string; auditPath?: string }>;
      }>;
    };
    expect(latestRun.profile.workspaceMode).toBe('fresh-agent');
    expect(latestRun.runs[0]?.results[0]?.sessionId).toBe(sessionId);
    expect(latestRun.runs[0]?.results[0]?.auditPath).toBe(auditPath);
    expect(memoryService.getSessionById(sessionId)).toBeUndefined();
    expect(memoryService.getSessionById(executionSessionId)).toBeUndefined();
    expect(fs.existsSync(tempAgentWorkspace)).toBe(false);
    expect(fs.existsSync(path.dirname(tempAgentWorkspace))).toBe(false);
    expect(fs.existsSync(auditPath)).toBe(false);
    expect(fs.existsSync(path.dirname(auditPath))).toBe(false);
    expect(fs.existsSync(executionAuditPath)).toBe(false);
    expect(fs.existsSync(path.dirname(executionAuditPath))).toBe(false);
  });

  test('supports suite-local current-agent override after run', async () => {
    const dataDir = makeTempDir();
    const fixture: HybridaiSkillFixture = {
      id: 'synthetic:pdf:try-it:2',
      docFile: 'synthetic.md',
      skill: 'pdf',
      prompt: 'Create a one-page PDF invoice for Acme Corp',
      mode: 'implicit',
      kind: 'try-it',
    };
    writeHybridaiSkillsFixtures(dataDir, {
      generatedAt: new Date().toISOString(),
      docsRoot: '',
      sourceFiles: ['synthetic.md'],
      fixtures: [fixture],
    });
    const sessionId = 'sess_pdf_eval_2';
    writeAuditWire(dataDir, sessionId, [
      {
        type: 'tool.call',
        toolCallId: 'tool-1',
        toolName: 'read',
        arguments: { path: 'skills/pdf/SKILL.md' },
      },
      {
        type: 'skill.execution',
        skillName: 'pdf',
        outcome: 'success',
      },
    ]);
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as { model?: string };
      expect(body.model).toBe('hybridai/gpt-4.1-mini');
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Done.' } }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-hybridclaw-session-id': sessionId,
          },
        },
      );
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await handleHybridaiSkillsCommand({
      dataDir,
      env: makeEnv(),
      subcommand: 'run',
      args: ['--live', '--max', '1', '--current-agent'],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('info');
    expect(result.text).toMatch(/Passed\s+1\/1/);
  });

  test('resolves audit traces by OpenAI session key and records the real session id', async () => {
    const dataDir = makeTempDir();
    const fixture: HybridaiSkillFixture = {
      id: 'synthetic:pdf:try-it:session-key',
      docFile: 'synthetic.md',
      skill: 'pdf',
      prompt: 'Create a one-page PDF invoice for Acme Corp',
      mode: 'implicit',
      kind: 'try-it',
    };
    writeHybridaiSkillsFixtures(dataDir, {
      generatedAt: new Date().toISOString(),
      docsRoot: '',
      sourceFiles: ['synthetic.md'],
      fixtures: [fixture],
    });
    const sessionKey =
      'agent:eval-pdf:channel:openai:chat:dm:peer:feedfacecafebeef';
    const sessionId = 'sess_pdf_session_key_1';
    const auditPath = writeAuditWire(dataDir, sessionId, [
      {
        type: 'session.start',
        userId: sessionKey,
        cwd: '/tmp/eval-agent/workspace',
      },
      {
        type: 'tool.call',
        toolCallId: 'tool-1',
        toolName: 'bash',
        arguments: { cmd: 'node skills/pdf/scripts/create_pdf.mjs' },
      },
      {
        type: 'tool.result',
        toolCallId: 'tool-1',
        toolName: 'bash',
        resultSummary: 'created acme-invoice.pdf',
        durationMs: 4,
        isError: false,
        blocked: false,
      },
    ]);
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Done.' } }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-hybridclaw-session-id': sessionKey,
          },
        },
      );
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await handleHybridaiSkillsCommand({
      dataDir,
      env: makeEnv(),
      subcommand: 'run',
      args: ['--live', '--max', '1'],
    });

    expect(result.kind).toBe('info');
    expect(result.text).toMatch(/Passed\s+1\/1/);

    const latestRun = JSON.parse(
      fs.readFileSync(
        path.join(dataDir, 'evals', 'hybridai-skills', 'latest-run.json'),
        'utf8',
      ),
    ) as {
      runs: Array<{
        results: Array<{ sessionId?: string; auditPath?: string }>;
      }>;
    };
    expect(latestRun.runs[0]?.results[0]?.sessionId).toBe(sessionId);
    expect(latestRun.runs[0]?.results[0]?.auditPath).toBe(auditPath);
  });

  test('does not count a bare SKILL.md read as observed skill usage', async () => {
    const dataDir = makeTempDir();
    const fixture: HybridaiSkillFixture = {
      id: 'synthetic:pdf:try-it:weak-trace',
      docFile: 'synthetic.md',
      skill: 'pdf',
      prompt: 'Create a one-page PDF invoice for Acme Corp',
      mode: 'implicit',
      kind: 'try-it',
    };
    writeHybridaiSkillsFixtures(dataDir, {
      generatedAt: new Date().toISOString(),
      docsRoot: '',
      sourceFiles: ['synthetic.md'],
      fixtures: [fixture],
    });
    const sessionId = 'sess_pdf_weak_trace_1';
    writeAuditWire(dataDir, sessionId, [
      {
        type: 'tool.call',
        toolCallId: 'tool-1',
        toolName: 'read',
        arguments: { path: 'skills/pdf/SKILL.md' },
      },
      {
        type: 'tool.result',
        toolCallId: 'tool-1',
        toolName: 'read',
        resultSummary: 'skill instructions',
        durationMs: 1,
        isError: false,
        blocked: false,
      },
    ]);
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Done.' } }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-hybridclaw-session-id': sessionId,
          },
        },
      );
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await handleHybridaiSkillsCommand({
      dataDir,
      env: makeEnv(),
      subcommand: 'run',
      args: ['--live', '--max', '1'],
    });

    expect(result.kind).toBe('info');
    expect(result.text).toMatch(/Passed\s+0\/1/);
    expect(result.text).toMatch(/skills=None/);
    expect(result.text).toContain('artefacts=❌');
    expect(result.text).not.toMatch(/session=/);
  });

  test('runs conversation fixtures as a chained conversation in one temporary agent workspace', async () => {
    const dataDir = makeTempDir();
    const fixtures: HybridaiSkillFixture[] = [
      {
        id: 'synthetic:pdf:conversation:1',
        docFile: 'synthetic.md',
        skill: 'pdf',
        prompt: 'Create a quarterly report PDF for Q1',
        mode: 'implicit',
        kind: 'conversation',
        conversationId: 'pdf#conv1',
        turnIndex: 1,
      },
      {
        id: 'synthetic:pdf:conversation:2',
        docFile: 'synthetic.md',
        skill: 'pdf',
        prompt: 'Now add a second page with a short appendix',
        mode: 'implicit',
        kind: 'conversation',
        conversationId: 'pdf#conv1',
        turnIndex: 2,
      },
    ];
    writeHybridaiSkillsFixtures(dataDir, {
      generatedAt: new Date().toISOString(),
      docsRoot: '',
      sourceFiles: ['synthetic.md'],
      fixtures,
    });
    writeAuditWire(dataDir, 'sess_pdf_conv_1', [
      {
        type: 'skill.execution',
        skillName: 'pdf',
        outcome: 'success',
      },
    ]);
    writeAuditWire(dataDir, 'sess_pdf_conv_2', [
      {
        type: 'skill.execution',
        skillName: 'pdf',
        outcome: 'success',
      },
    ]);

    const seenModels: string[] = [];
    const seenMessages: Array<Array<{ role: string; content: string }>> = [];
    const responseSessionIds = ['sess_pdf_conv_1', 'sess_pdf_conv_2'];
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as {
        model?: string;
        messages?: Array<{ role: string; content: string }>;
      };
      seenModels.push(String(body.model || ''));
      seenMessages.push(body.messages || []);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  responseSessionIds.length === 2
                    ? 'Created the report.'
                    : 'Added the appendix.',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-hybridclaw-session-id': responseSessionIds.shift() || 'sess',
          },
        },
      );
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await handleHybridaiSkillsCommand({
      dataDir,
      env: makeEnv(),
      subcommand: 'run',
      args: ['--live', '--kind', 'conversation', '--max', '2'],
    });

    expect(result.kind).toBe('info');
    expect(result.text).toMatch(/Passed\s+2\/2/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(seenModels[0]).toMatch(/__hc_eval=agent=eval-conv-[a-f0-9]+(?:,|$)/);
    expect(seenModels[1]).toBe(seenModels[0]);
    expect(seenMessages[0]).toEqual([
      { role: 'user', content: 'Create a quarterly report PDF for Q1' },
    ]);
    expect(seenMessages[1]).toEqual([
      { role: 'user', content: 'Create a quarterly report PDF for Q1' },
      { role: 'assistant', content: 'Created the report.' },
      { role: 'user', content: 'Now add a second page with a short appendix' },
    ]);
  });

  test('runs multiple models and renders a comparison section', async () => {
    const dataDir = makeTempDir();
    const fixture: HybridaiSkillFixture = {
      id: 'synthetic:pdf:try-it:3',
      docFile: 'synthetic.md',
      skill: 'pdf',
      prompt: 'Create a one-page PDF invoice for Acme Corp',
      mode: 'implicit',
      kind: 'try-it',
    };
    writeHybridaiSkillsFixtures(dataDir, {
      generatedAt: new Date().toISOString(),
      docsRoot: '',
      sourceFiles: ['synthetic.md'],
      fixtures: [fixture],
    });
    writeAuditWire(dataDir, 'sess_model_a', [
      {
        type: 'skill.execution',
        skillName: 'pdf',
        outcome: 'success',
      },
    ]);
    writeAuditWire(dataDir, 'sess_model_b', [
      {
        type: 'skill.execution',
        skillName: 'pdf',
        outcome: 'success',
      },
    ]);

    const responses = ['sess_model_a', 'sess_model_b'].map(
      (sessionId) =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Done.' } }],
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-hybridclaw-session-id': sessionId,
            },
          },
        ),
    );
    const mockFetch = vi.fn(async () => responses.shift() as Response);
    vi.stubGlobal('fetch', mockFetch);

    const result = await handleHybridaiSkillsCommand({
      dataDir,
      env: makeEnv(),
      subcommand: 'run',
      args: ['--live', '--max', '1', '--model', 'model-a,model-b'],
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe('info');
    expect(result.text).toContain('Comparison');
    expect(result.text).toContain('model-a');
    expect(result.text).toContain('model-b');

    const latestRun = JSON.parse(
      fs.readFileSync(
        path.join(dataDir, 'evals', 'hybridai-skills', 'latest-run.json'),
        'utf8',
      ),
    ) as { runs: Array<{ model: string }> };
    expect(latestRun.runs.map((run) => run.model)).toEqual([
      'model-a',
      'model-b',
    ]);
  });

  test('renders tool call counts instead of repeating tool names', async () => {
    const dataDir = makeTempDir();
    const fixture: HybridaiSkillFixture = {
      id: 'synthetic:pdf:try-it:counts',
      docFile: 'synthetic.md',
      skill: 'pdf',
      prompt: 'Create a one-page PDF invoice for Acme Corp',
      mode: 'implicit',
      kind: 'try-it',
    };
    writeHybridaiSkillsFixtures(dataDir, {
      generatedAt: new Date().toISOString(),
      docsRoot: '',
      sourceFiles: ['synthetic.md'],
      fixtures: [fixture],
    });
    const sessionId = 'sess_pdf_tool_counts_1';
    writeAuditWire(dataDir, sessionId, [
      {
        type: 'tool.call',
        toolCallId: 'tool-1',
        toolName: 'write',
        arguments: { path: 'invoice.md' },
      },
      {
        type: 'tool.result',
        toolCallId: 'tool-1',
        toolName: 'write',
        resultSummary: 'ok',
        durationMs: 1,
        isError: false,
        blocked: false,
      },
      {
        type: 'tool.call',
        toolCallId: 'tool-2',
        toolName: 'bash',
        arguments: { cmd: 'step 1' },
      },
      {
        type: 'tool.result',
        toolCallId: 'tool-2',
        toolName: 'bash',
        resultSummary: 'ok',
        durationMs: 1,
        isError: false,
        blocked: false,
      },
      {
        type: 'tool.call',
        toolCallId: 'tool-3',
        toolName: 'bash',
        arguments: { cmd: 'step 2' },
      },
      {
        type: 'tool.result',
        toolCallId: 'tool-3',
        toolName: 'bash',
        resultSummary: 'ok',
        durationMs: 1,
        isError: false,
        blocked: false,
      },
      {
        type: 'skill.execution',
        skillName: 'pdf',
        outcome: 'success',
      },
    ]);
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Done.' } }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-hybridclaw-session-id': sessionId,
          },
        },
      );
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await handleHybridaiSkillsCommand({
      dataDir,
      env: makeEnv(),
      subcommand: 'run',
      args: ['--live', '--max', '1'],
    });

    expect(result.kind).toBe('info');
    expect(result.text).toContain('tools=write (1),bash (2)');
    expect(result.text).not.toContain('tools=write,bash,bash');
  });
});
