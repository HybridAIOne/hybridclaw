import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { parseConfidentialYaml } from '../src/security/confidential-rules.js';

let tmpDir: string;
let originalDataDir: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-trace-prep-'));
  originalDataDir = process.env.HYBRIDCLAW_DATA_DIR;
  originalHome = process.env.HOME;
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HOME = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.HYBRIDCLAW_DATA_DIR;
  else process.env.HYBRIDCLAW_DATA_DIR = originalDataDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('prepareTraceJudgePrompt keeps the last configured tool calls', async () => {
  const { prepareTraceJudgePrompt } = await import(
    '../src/evals/trace-preparation.js'
  );

  const prepared = prepareTraceJudgePrompt(
    {
      sessionId: 'session-1',
      toolExecutions: Array.from({ length: 5 }, (_, index) => ({
        name: `tool_${index + 1}`,
        arguments: JSON.stringify({ index: index + 1 }),
        result: `result ${index + 1}`,
      })),
    },
    'Pass when the final tools support the answer.',
    {
      maxToolCalls: 2,
      maxTraceTokens: 10_000,
      confidentialRuleSet: null,
    },
  );

  const trace = JSON.parse(prepared.traceText) as {
    toolExecutions: Array<{ name: string }>;
  };
  expect(trace.toolExecutions.map((tool) => tool.name)).toEqual([
    'tool_4',
    'tool_5',
  ]);
  expect(prepared.window).toMatchObject({
    originalToolCallCount: 5,
    includedToolCallCount: 2,
    droppedToolCallCount: 3,
    truncatedByTokens: false,
  });
});

test('prepareTraceJudgePrompt windows exported and OpenAI-style tool calls', async () => {
  const { prepareTraceJudgePrompt } = await import(
    '../src/evals/trace-preparation.js'
  );

  const exportedTrace = prepareTraceJudgePrompt(
    {
      steps: [
        {
          tool_calls: [
            { tool_name: 'old_tool', arguments: '{}', result: 'old' },
            { tool_name: 'new_tool', arguments: '{}', result: 'new' },
          ],
        },
      ],
    },
    'Pass.',
    { maxToolCalls: 1, confidentialRuleSet: null },
  );
  expect(exportedTrace.traceText).toContain('new_tool');
  expect(exportedTrace.traceText).not.toContain('old_tool');

  const openAiTrace = prepareTraceJudgePrompt(
    {
      tool_calls: [
        { function: { name: 'older_tool', arguments: '{}' } },
        { function: { name: 'newer_tool', arguments: '{}' } },
      ],
    },
    'Pass.',
    { maxToolCalls: 1, confidentialRuleSet: null },
  );
  expect(openAiTrace.traceText).toContain('newer_tool');
  expect(openAiTrace.traceText).not.toContain('older_tool');
});

test('prepareTraceJudgePrompt trims additional tool calls to fit token budget', async () => {
  const { prepareTraceJudgePrompt } = await import(
    '../src/evals/trace-preparation.js'
  );

  const prepared = prepareTraceJudgePrompt(
    {
      toolExecutions: Array.from({ length: 6 }, (_, index) => ({
        name: `tool_${index + 1}`,
        arguments: '{}',
        result: `${index + 1}: ${'x'.repeat(120)}`,
      })),
    },
    'Pass when the newest useful tool evidence is present.',
    {
      maxToolCalls: 6,
      maxTraceTokens: 120,
      confidentialRuleSet: null,
    },
  );

  expect(prepared.window.includedToolCallCount).toBeGreaterThan(0);
  expect(prepared.window.includedToolCallCount).toBeLessThan(6);
  expect(prepared.window.droppedToolCallCount).toBeGreaterThan(0);
  expect(prepared.window.truncatedByTokens).toBe(true);
  expect(prepared.traceText).toContain('tool_6');
  expect(prepared.traceText).not.toContain('tool_1');
});

test('prepareTraceJudgePrompt tail-windows long traces without tool arrays', async () => {
  const { prepareTraceJudgePrompt } = await import(
    '../src/evals/trace-preparation.js'
  );

  const prepared = prepareTraceJudgePrompt(
    `start-${'a'.repeat(1000)}-end`,
    'Pass when the tail evidence is present.',
    {
      maxTraceTokens: 80,
      confidentialRuleSet: null,
    },
  );

  expect(prepared.window.truncatedSerializedTrace).toBe(true);
  expect(prepared.traceText).toContain('[truncated leading trace]');
  expect(prepared.traceText).toContain('-end');
  expect(prepared.traceText).not.toContain('start-');
});

test('prepareTraceJudgePrompt rejects empty traces before template I/O', async () => {
  const { DEFAULT_TRACE_JUDGE_TEMPLATE_PATH, prepareTraceJudgePrompt } =
    await import('../src/evals/trace-preparation.js');

  expect(() =>
    prepareTraceJudgePrompt('', 'Pass.', {
      confidentialRuleSet: null,
    }),
  ).toThrow('Judge trace is required.');
  expect(fs.existsSync(DEFAULT_TRACE_JUDGE_TEMPLATE_PATH)).toBe(false);
});

test('serializeTracePreparationInput normalizes non-serializable values', async () => {
  const { serializeTracePreparationInput } = await import(
    '../src/evals/trace-preparation.js'
  );

  expect(serializeTracePreparationInput(undefined)).toBe('');
  expect(serializeTracePreparationInput(Symbol('trace'))).toBe('Symbol(trace)');
});

test('prepareTraceJudgePrompt redacts trace and criteria with round-trip mappings', async () => {
  const { prepareTraceJudgePrompt } = await import(
    '../src/evals/trace-preparation.js'
  );
  const ruleSet = parseConfidentialYaml(`
version: 1
clients:
  - name: Acme Medical
    sensitivity: high
`);

  const prepared = prepareTraceJudgePrompt(
    {
      toolExecutions: [
        {
          name: 'httpRequest',
          arguments:
            '{"client":"Acme Medical","token":"super-secret-token-value-123456"}',
          result: 'Acme Medical request succeeded.',
        },
      ],
    },
    'Pass when Acme Medical request succeeded.',
    {
      confidentialRuleSet: ruleSet,
      maxTraceTokens: 10_000,
    },
  );

  expect(prepared.traceText).not.toContain('Acme Medical');
  expect(prepared.criteriaText).not.toContain('Acme Medical');
  expect(String(prepared.messages[1]?.content)).not.toContain('Acme Medical');
  expect(prepared.traceText).not.toContain('super-secret-token-value-123456');
  expect(prepared.traceText).toContain('«CONF:CLIENT_001»');
  expect(prepared.criteriaText).toContain('«CONF:CLIENT_001»');
  expect(prepared.redaction).toMatchObject({
    confidentialEnabled: true,
    confidentialHits: 3,
    placeholderCount: 1,
    secretRedactedStringCount: 1,
  });
  expect(prepared.redaction.rehydrate(prepared.traceText)).toContain(
    'Acme Medical',
  );
});

test('prepareTraceJudgePrompt rejects ambiguous inline and file templates', async () => {
  const { prepareTraceJudgePrompt } = await import(
    '../src/evals/trace-preparation.js'
  );

  expect(() =>
    prepareTraceJudgePrompt({ answer: 'A' }, 'Pass.', {
      confidentialRuleSet: null,
      template: {
        id: 'inline',
        system: 'System',
        user: '{{judge_input_json}}',
      },
      templatePath: path.join(tmpDir, 'templates', 'judge.json'),
    }),
  ).toThrow('Pass either trace prompt template or templatePath, not both.');
});

test('default prompt template is versioned as a runtime template asset', async () => {
  const { DEFAULT_TRACE_JUDGE_TEMPLATE_PATH, prepareTraceJudgePrompt } =
    await import('../src/evals/trace-preparation.js');
  const configMod = await import('../src/config/runtime-config.js');

  const prepared = prepareTraceJudgePrompt({ answer: 'A' }, 'Pass.', {
    confidentialRuleSet: null,
    revisionMeta: {
      actor: 'trace-prep-test',
      route: 'trace.default-template.seed',
      source: 'test',
    },
  });

  expect(prepared.template).toMatchObject({
    id: 'trace-judge-v1',
    path: DEFAULT_TRACE_JUDGE_TEMPLATE_PATH,
    versioned: true,
    revisionChanged: false,
  });
  expect(fs.existsSync(DEFAULT_TRACE_JUDGE_TEMPLATE_PATH)).toBe(true);
  expect(
    configMod.getLastKnownGoodRuntimeAssetState(
      'template',
      DEFAULT_TRACE_JUDGE_TEMPLATE_PATH,
    )?.content,
  ).toContain('trace-judge-v1');
});

test('file-backed prompt templates are versioned as runtime template assets', async () => {
  const { prepareTraceJudgePrompt } = await import(
    '../src/evals/trace-preparation.js'
  );
  const configMod = await import('../src/config/runtime-config.js');
  const templatePath = path.join(tmpDir, 'templates', 'judge.json');

  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.writeFileSync(
    templatePath,
    JSON.stringify({
      id: 'custom-judge',
      system: 'System v1',
      user: 'Judge v1: {{judge_input_json}}',
    }),
    'utf-8',
  );
  prepareTraceJudgePrompt({ answer: 'A' }, 'Pass.', {
    templatePath,
    confidentialRuleSet: null,
    revisionMeta: {
      actor: 'trace-prep-test',
      route: 'trace.template.seed',
      source: 'test',
    },
  });

  fs.writeFileSync(
    templatePath,
    JSON.stringify({
      id: 'custom-judge',
      system: 'System v2',
      user: 'Judge v2: {{judge_input_json}}',
    }),
    'utf-8',
  );
  const prepared = prepareTraceJudgePrompt({ answer: 'B' }, 'Pass.', {
    templatePath,
    confidentialRuleSet: null,
    revisionMeta: {
      actor: 'trace-prep-test',
      route: 'trace.template.update',
      source: 'test',
    },
  });

  const revisions = configMod.listRuntimeAssetRevisions(
    'template',
    templatePath,
  );
  expect(prepared.messages[0]?.content).toBe('System v2');
  expect(prepared.template).toMatchObject({
    id: 'custom-judge',
    path: templatePath,
    versioned: true,
    revisionChanged: true,
  });
  expect(revisions).toHaveLength(1);
  expect(revisions[0]).toMatchObject({
    assetType: 'template',
    route: 'trace.template.update',
  });

  const restored = configMod.restoreRuntimeTemplateRevision(
    templatePath,
    revisions[0].id,
    {
      actor: 'trace-prep-test',
      route: 'trace.template.rollback',
      source: 'test',
    },
  );
  expect(restored).toContain('System v1');
  expect(fs.readFileSync(templatePath, 'utf-8')).toContain('System v1');
});
