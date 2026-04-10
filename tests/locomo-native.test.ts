import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  } else {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  }
});

function buildSampleDataset(): string {
  return JSON.stringify([
    {
      sample_id: 'sample-1',
      conversation: {
        speaker_a: 'Alice',
        speaker_b: 'Bob',
        session_1_date_time: '2024-03-01 10:00:00',
        session_1: [
          {
            speaker: 'Alice',
            dia_id: 'D1:1',
            text: 'Pepper loves playing fetch every evening.',
          },
          {
            speaker: 'Bob',
            dia_id: 'D1:2',
            text: 'The weather turned rainy today.',
          },
          {
            speaker: 'Alice',
            dia_id: 'D1:3',
            text: 'Tomorrow I will pack crunchy carrots for lunch.',
          },
        ],
      },
      qa: [
        {
          question: 'What does Pepper love playing every evening?',
          answer: 'fetch',
          evidence: ['D1:1'],
          category: 1,
        },
        {
          question: 'What will Alice pack for lunch tomorrow?',
          answer: 'carrots',
          evidence: ['D1:3'],
          category: 1,
        },
      ],
    },
  ]);
}

test('locomo native setup downloads the dataset and writes the setup marker', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  const dataset = buildSampleDataset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  globalThis.fetch = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(dataset, { status: 200 }));

  await runLocomoNativeCli(['setup', '--install-dir', installDir]);

  expect(fs.existsSync(path.join(installDir, '.hybridclaw-setup-ok'))).toBe(
    true,
  );
  expect(
    fs.readFileSync(path.join(installDir, 'data', 'locomo10.json'), 'utf-8'),
  ).toBe(dataset);
});

test('locomo native run writes recent and semantic benchmark summaries', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});

  fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'data', 'locomo10.json'),
    buildSampleDataset(),
    'utf-8',
  );
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), 'ok\n');

  await runLocomoNativeCli([
    'run',
    '--install-dir',
    installDir,
    '--budget',
    '14',
    '--num-samples',
    '1',
    '--top-k',
    '5',
  ]);

  const jobRoot = path.join(installDir, 'jobs');
  const [jobDirName] = fs.readdirSync(jobRoot);
  const summary = JSON.parse(
    fs.readFileSync(path.join(jobRoot, jobDirName, 'result.json'), 'utf-8'),
  ) as {
    suite: string;
    sampleCount: number;
    modes: Record<
      string,
      {
        overallF1: number;
        overallHitRate: number;
        totalQuestions: number;
      }
    >;
  };

  expect(summary.suite).toBe('locomo');
  expect(summary.sampleCount).toBe(1);
  expect(summary.modes.recent).toBeDefined();
  expect(summary.modes.semantic).toBeDefined();
  expect(summary.modes.semantic.totalQuestions).toBe(2);
  expect(summary.modes.semantic.overallHitRate).toBeGreaterThan(
    summary.modes.recent.overallHitRate,
  );
  expect(summary.modes.semantic.overallF1).toBeGreaterThan(
    summary.modes.recent.overallF1,
  );
});
