import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { parseEvalProfileModel } from '../src/evals/eval-profile.ts';
import { testOnlyLocomoNativeRetrieval } from '../src/evals/locomo-native.ts';
import {
  scoreOfficialLocomoAnswer,
  testOnlyLocomoOfficialScoring,
} from '../src/evals/locomo-official-scoring.ts';

const originalFetch = globalThis.fetch;
const originalOpenAIBaseUrl = process.env.OPENAI_BASE_URL;
const originalOpenAIApiKey = process.env.OPENAI_API_KEY;
const originalEvalModel = process.env.HYBRIDCLAW_EVAL_MODEL;
const LOCOMO_DATASET_URL =
  'https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json';
const LOCOMO_DATASET_SHA256 =
  '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4';

async function flushMicrotasks(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildTimeoutError(): Error {
  return Object.assign(new Error('timed out'), { name: 'TimeoutError' });
}

function buildCompletionResponse(answer: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: answer } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function toBuffer(
  value: string | ArrayBuffer | ArrayBufferView<ArrayBufferLike>,
): Buffer {
  if (typeof value === 'string') {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(value);
}

async function mockPinnedDatasetDigest(dataset: string): Promise<void> {
  vi.resetModules();
  vi.doMock('node:crypto', async () => {
    const actual =
      await vi.importActual<typeof import('node:crypto')>('node:crypto');
    return {
      ...actual,
      createHash(algorithm: string) {
        if (algorithm !== 'sha256') {
          return actual.createHash(algorithm);
        }

        const fallbackHash = actual.createHash('sha256');
        const chunks: Buffer[] = [];
        const mockedHash = {
          update(
            value: string | ArrayBuffer | ArrayBufferView<ArrayBufferLike>,
          ) {
            const buffer = toBuffer(value);
            chunks.push(buffer);
            fallbackHash.update(buffer);
            return mockedHash;
          },
          digest(encoding?: import('node:crypto').BinaryToTextEncoding) {
            const buffer = Buffer.concat(chunks);
            if (buffer.equals(Buffer.from(dataset, 'utf-8'))) {
              return LOCOMO_DATASET_SHA256;
            }
            return encoding
              ? fallbackHash.digest(encoding)
              : fallbackHash.digest();
          },
        };

        return mockedHash as unknown as ReturnType<typeof actual.createHash>;
      },
    };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('node:crypto');
  vi.resetModules();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  } else {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  }
  if (originalOpenAIBaseUrl == null) {
    delete process.env.OPENAI_BASE_URL;
  } else {
    process.env.OPENAI_BASE_URL = originalOpenAIBaseUrl;
  }
  if (originalOpenAIApiKey == null) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIApiKey;
  }
  if (originalEvalModel == null) {
    delete process.env.HYBRIDCLAW_EVAL_MODEL;
  } else {
    process.env.HYBRIDCLAW_EVAL_MODEL = originalEvalModel;
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

function buildTwoSampleDataset(): string {
  return JSON.stringify([
    ...JSON.parse(buildSampleDataset()),
    {
      sample_id: 'sample-2',
      conversation: {
        speaker_a: 'Carol',
        speaker_b: 'Dan',
        session_1_date_time: '2024-03-02 10:00:00',
        session_1: [
          {
            speaker: 'Carol',
            dia_id: 'D2:1',
            text: 'I adopted a greyhound named Orbit last spring.',
          },
        ],
      },
      qa: [
        {
          question: 'What is the name of Carol’s dog?',
          answer: 'Orbit',
          evidence: ['D2:1'],
          category: 1,
        },
      ],
    },
  ]);
}

function buildCategoryFiveDataset(): string {
  return JSON.stringify([
    {
      sample_id: 'sample-5',
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
        ],
      },
      qa: [
        {
          question: 'What is Bob planning for his ski trip next month?',
          answer: 'ski trip',
          evidence: [],
          category: 5,
        },
      ],
    },
  ]);
}

test('locomo native caches flattened conversation turns per conversation object', async () => {
  const { testOnlyLocomoNative } = await import(
    '../src/evals/locomo-native.ts'
  );
  const [sample] = JSON.parse(buildSampleDataset()) as Array<{
    conversation: Record<string, unknown>;
  }>;

  const first = testOnlyLocomoNative.flattenConversationTurns(
    sample.conversation,
  );
  const second = testOnlyLocomoNative.flattenConversationTurns(
    sample.conversation,
  );

  expect(second).toBe(first);
  expect(second.map((turn) => turn.dia_id)).toEqual(['D1:1', 'D1:2', 'D1:3']);
});

test('locomo native setup downloads the dataset and verifies bytes after redirects', async () => {
  const dataset = buildSampleDataset();
  await mockPinnedDatasetDigest(dataset);
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
    ok: true,
    status: 200,
    url: 'https://objects.githubusercontent.com/redirected/locomo10.json',
    arrayBuffer: async () => Buffer.from(dataset, 'utf-8'),
  } as Response);
  globalThis.fetch = fetchMock;

  await runLocomoNativeCli(['setup', '--install-dir', installDir]);

  expect(timeoutSpy).toHaveBeenCalledWith(120_000);
  expect(fetchMock).toHaveBeenCalledWith(
    LOCOMO_DATASET_URL,
    expect.objectContaining({
      signal: timeoutSpy.mock.results[0]?.value,
    }),
  );
  expect(fs.existsSync(path.join(installDir, '.hybridclaw-setup-ok'))).toBe(
    true,
  );
  expect(
    fs.readFileSync(path.join(installDir, 'data', 'locomo10.json'), 'utf-8'),
  ).toBe(dataset);
});

test('locomo native setup times out stalled dataset downloads', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockRejectedValue(buildTimeoutError());
  globalThis.fetch = fetchMock;

  await expect(
    runLocomoNativeCli(['setup', '--install-dir', installDir]),
  ).rejects.toThrow(/^LOCOMO dataset download timed out after 120000ms\.$/);

  expect(timeoutSpy).toHaveBeenCalledWith(120_000);
  expect(fetchMock).toHaveBeenCalledWith(
    LOCOMO_DATASET_URL,
    expect.objectContaining({
      signal: timeoutSpy.mock.results[0]?.value,
    }),
  );
});

test('locomo native setup rejects downloads that fail the pinned digest check after redirects', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue({
    ok: true,
    status: 200,
    url: 'https://objects.githubusercontent.com/redirected/locomo10.json',
    arrayBuffer: async () => Buffer.from(buildSampleDataset(), 'utf-8'),
  } as Response);

  await expect(
    runLocomoNativeCli(['setup', '--install-dir', installDir]),
  ).rejects.toThrow(/SHA-256 verification/);
});

test('locomo native run reports setup guidance that works for cli and slash wrappers', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );

  await expect(
    runLocomoNativeCli(['run', '--install-dir', installDir]),
  ).rejects.toThrow('LOCOMO is not set up. Run `setup` first');
});

test('locomo native run reports when the cached dataset is missing', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );

  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), 'ok\n');

  await expect(
    runLocomoNativeCli(['run', '--install-dir', installDir]),
  ).rejects.toThrow('LOCOMO dataset is missing');
});

test('locomo native run reports when the setup marker is missing', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );

  fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'data', 'locomo10.json'),
    buildSampleDataset(),
    'utf-8',
  );

  await expect(
    runLocomoNativeCli(['run', '--install-dir', installDir]),
  ).rejects.toThrow('LOCOMO setup marker is missing');
});

test('locomo native run rejects malformed cached datasets immediately', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );

  fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'data', 'locomo10.json'),
    JSON.stringify([{ sample_id: 'broken-sample', conversation: {} }]),
    'utf-8',
  );
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), 'ok\n');

  await expect(
    runLocomoNativeCli(['run', '--install-dir', installDir]),
  ).rejects.toThrow(/Invalid LOCOMO sample at index 0/);
});

test('locomo native run generates answers through the local gateway and scores them', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9090/v1';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.HYBRIDCLAW_EVAL_MODEL = 'hybridai/gpt-4.1-mini';
  const requestModels: string[] = [];

  fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'data', 'locomo10.json'),
    buildSampleDataset(),
    'utf-8',
  );
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), 'ok\n');
  globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input) !== 'http://127.0.0.1:9090/v1/chat/completions') {
      throw new Error(`Unexpected fetch URL: ${String(input)}`);
    }
    const body = JSON.parse(String(init?.body || '{}')) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    requestModels.push(body.model);
    const parsedModel = parseEvalProfileModel(body.model);
    expect(parsedModel.model).toBe('hybridai/gpt-4.1-mini');
    expect(parsedModel.profile.agentId).toBeTruthy();
    const prompt = body.messages[0]?.content || '';
    const answer = prompt.includes('pack for lunch tomorrow')
      ? 'carrots'
      : 'fetch';
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: answer } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });

  await runLocomoNativeCli([
    'run',
    '--install-dir',
    installDir,
    '--budget',
    '4000',
    '--num-samples',
    '1',
  ]);

  const jobRoot = path.join(installDir, 'jobs');
  const [jobDirName] = fs.readdirSync(jobRoot);
  const summary = JSON.parse(
    fs.readFileSync(path.join(jobRoot, jobDirName, 'result.json'), 'utf-8'),
  ) as {
    suite: string;
    model: string;
    sampleCount: number;
    questionCount: number;
    overallScore: number;
    tokenUsage: {
      totalTokens: number;
    };
    categories: Record<
      string,
      {
        meanScore: number;
        questionCount: number;
      }
    >;
    predictionsPath: string;
  };

  expect(summary.suite).toBe('locomo');
  expect(summary.model).toBe('hybridai/gpt-4.1-mini');
  expect(summary.sampleCount).toBe(1);
  expect(summary.questionCount).toBe(2);
  expect(summary.overallScore).toBe(1);
  expect(summary.categories['1']).toEqual({
    meanScore: 1,
    questionCount: 2,
    contextF1: null,
  });
  expect(summary.tokenUsage.totalTokens).toBe(24);
  expect(fs.existsSync(summary.predictionsPath)).toBe(true);
  const predictions = JSON.parse(
    fs.readFileSync(summary.predictionsPath, 'utf-8'),
  ) as Array<{
    sampleId: string;
    meanScore: number;
    qa: Array<{ prediction: string; score: number }>;
  }>;
  expect(predictions[0]?.sampleId).toBe('sample-1');
  expect(predictions[0]?.meanScore).toBe(1);
  expect(predictions[0]?.qa.map((entry) => entry.prediction)).toEqual([
    'fetch',
    'carrots',
  ]);
  expect(requestModels).toHaveLength(2);
  expect(requestModels[0]).toBe(requestModels[1]);
});

test('locomo native run evaluates QA questions concurrently while preserving question order', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9090/v1';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.HYBRIDCLAW_EVAL_MODEL = 'hybridai/gpt-4.1-mini';

  fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'data', 'locomo10.json'),
    buildSampleDataset(),
    'utf-8',
  );
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), 'ok\n');

  const firstResponse = createDeferred<Response>();
  const secondResponse = createDeferred<Response>();
  let activeRequests = 0;
  let maxConcurrentRequests = 0;

  globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
    activeRequests += 1;
    maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
    const body = JSON.parse(String(init?.body || '{}')) as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = body.messages[0]?.content || '';
    const response = prompt.includes('pack for lunch tomorrow')
      ? await secondResponse.promise
      : await firstResponse.promise;
    activeRequests -= 1;
    return response;
  });

  const runPromise = runLocomoNativeCli([
    'run',
    '--install-dir',
    installDir,
    '--budget',
    '4000',
    '--num-samples',
    '1',
  ]);

  await flushMicrotasks();
  expect(maxConcurrentRequests).toBe(2);
  secondResponse.resolve(buildCompletionResponse('carrots'));
  firstResponse.resolve(buildCompletionResponse('fetch'));
  await runPromise;

  const jobRoot = path.join(installDir, 'jobs');
  const [jobDirName] = fs.readdirSync(jobRoot);
  const summary = JSON.parse(
    fs.readFileSync(path.join(jobRoot, jobDirName, 'result.json'), 'utf-8'),
  ) as {
    predictionsPath: string;
  };
  const predictions = JSON.parse(
    fs.readFileSync(summary.predictionsPath, 'utf-8'),
  ) as Array<{
    qa: Array<{ prediction: string }>;
  }>;

  expect(predictions[0]?.qa.map((entry) => entry.prediction)).toEqual([
    'fetch',
    'carrots',
  ]);
});

test('locomo native run times out stalled model calls', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9090/v1';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.HYBRIDCLAW_EVAL_MODEL = 'hybridai/gpt-4.1-mini';

  fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'data', 'locomo10.json'),
    buildSampleDataset(),
    'utf-8',
  );
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), 'ok\n');
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockRejectedValue(buildTimeoutError());
  globalThis.fetch = fetchMock;

  await expect(
    runLocomoNativeCli([
      'run',
      '--install-dir',
      installDir,
      '--budget',
      '4000',
      '--num-samples',
      '1',
    ]),
  ).rejects.toThrow(/^LOCOMO model call timed out after 30000ms\.$/);

  expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  expect(fetchMock).toHaveBeenCalledWith(
    'http://127.0.0.1:9090/v1/chat/completions',
    expect.objectContaining({
      signal: timeoutSpy.mock.results[0]?.value,
    }),
  );
});

test('locomo native run does not echo failed model response bodies', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9090/v1';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.HYBRIDCLAW_EVAL_MODEL = 'hybridai/gpt-4.1-mini';

  fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'data', 'locomo10.json'),
    buildSampleDataset(),
    'utf-8',
  );
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), 'ok\n');
  globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(
    new Response('token=test-key server stack trace', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' },
    }),
  );

  await expect(
    runLocomoNativeCli([
      'run',
      '--install-dir',
      installDir,
      '--budget',
      '4000',
      '--num-samples',
      '1',
    ]),
  ).rejects.toThrow(/^LOCOMO model call failed with HTTP 401\.$/);
});

test('locomo native default creates one fresh agent per conversation sample', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9090/v1';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.HYBRIDCLAW_EVAL_MODEL = 'hybridai/gpt-4.1-mini';

  fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'data', 'locomo10.json'),
    buildTwoSampleDataset(),
    'utf-8',
  );
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), 'ok\n');
  const requestModels: string[] = [];
  globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}')) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    requestModels.push(body.model);
    const prompt = body.messages[0]?.content || '';
    let answer = 'fetch';
    if (prompt.includes('pack for lunch tomorrow')) {
      answer = 'carrots';
    } else if (prompt.includes('name of Carol')) {
      answer = 'Orbit';
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: answer } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });

  await runLocomoNativeCli([
    'run',
    '--install-dir',
    installDir,
    '--budget',
    '4000',
    '--num-samples',
    '2',
  ]);

  expect(requestModels).toHaveLength(3);
  const [first, second, third] = requestModels.map((model) =>
    parseEvalProfileModel(model),
  );
  expect(first.model).toBe('hybridai/gpt-4.1-mini');
  expect(first.profile.agentId).toBeTruthy();
  expect(second.profile.agentId).toBe(first.profile.agentId);
  expect(third.profile.agentId).toBeTruthy();
  expect(third.profile.agentId).not.toBe(first.profile.agentId);
});

test('locomo native run maps category-5 option labels back to the correct answer key', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9090/v1';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.HYBRIDCLAW_EVAL_MODEL = 'hybridai/gpt-4.1-mini';

  fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'data', 'locomo10.json'),
    buildCategoryFiveDataset(),
    'utf-8',
  );
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), 'ok\n');
  globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}')) as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = body.messages[0]?.content || '';
    const answer = prompt.includes('(a) Not mentioned in the conversation')
      ? 'a'
      : 'b';
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: answer } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });

  await runLocomoNativeCli([
    'run',
    '--install-dir',
    installDir,
    '--budget',
    '4000',
    '--num-samples',
    '1',
  ]);

  const jobRoot = path.join(installDir, 'jobs');
  const [jobDirName] = fs.readdirSync(jobRoot);
  const summary = JSON.parse(
    fs.readFileSync(path.join(jobRoot, jobDirName, 'result.json'), 'utf-8'),
  ) as {
    overallScore: number;
    categories: Record<
      string,
      {
        meanScore: number;
        questionCount: number;
      }
    >;
    predictionsPath: string;
  };

  expect(summary.overallScore).toBe(1);
  expect(summary.categories['5']).toEqual({
    meanScore: 1,
    questionCount: 1,
    contextF1: null,
  });
  const predictions = JSON.parse(
    fs.readFileSync(summary.predictionsPath, 'utf-8'),
  ) as Array<{
    qa: Array<{ prediction: string; score: number }>;
  }>;
  expect(predictions[0]?.qa[0]).toMatchObject({
    prediction: 'Not mentioned in the conversation',
    score: 1,
  });
});

test('locomo native run respects max question limits and writes progress metadata', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9090/v1';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.HYBRIDCLAW_EVAL_MODEL = 'hybridai/gpt-4.1-mini';

  fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'data', 'locomo10.json'),
    buildSampleDataset(),
    'utf-8',
  );
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), 'ok\n');
  globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: 'fetch' } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    ),
  );

  await runLocomoNativeCli([
    'run',
    '--install-dir',
    installDir,
    '--budget',
    '4000',
    '--num-samples',
    '1',
    '--max-questions',
    '1',
  ]);

  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  const jobRoot = path.join(installDir, 'jobs');
  const [jobDirName] = fs.readdirSync(jobRoot);
  const jobDir = path.join(jobRoot, jobDirName);
  const summary = JSON.parse(
    fs.readFileSync(path.join(jobDir, 'result.json'), 'utf-8'),
  ) as {
    sampleCount: number;
    questionCount: number;
    overallScore: number;
    predictionsPath: string;
  };
  const progress = JSON.parse(
    fs.readFileSync(path.join(jobDir, 'progress.json'), 'utf-8'),
  ) as {
    sampleCount: number;
    completedSampleCount: number;
    questionCount: number;
    completedQuestionCount: number;
    overallScore: number;
    currentSampleId: string | null;
  };
  const predictions = JSON.parse(
    fs.readFileSync(summary.predictionsPath, 'utf-8'),
  ) as Array<{
    qa: Array<{ prediction: string }>;
  }>;

  expect(summary.sampleCount).toBe(1);
  expect(summary.questionCount).toBe(1);
  expect(summary.overallScore).toBe(1);
  expect(progress.sampleCount).toBe(1);
  expect(progress.completedSampleCount).toBe(1);
  expect(progress.questionCount).toBe(1);
  expect(progress.completedQuestionCount).toBe(1);
  expect(progress.overallScore).toBe(1);
  expect(progress.currentSampleId).toBeNull();
  expect(predictions[0]?.qa).toHaveLength(1);
});

test('locomo native run throttles in-sample progress writes', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9090/v1';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.HYBRIDCLAW_EVAL_MODEL = 'hybridai/gpt-4.1-mini';

  fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'data', 'locomo10.json'),
    buildSampleDataset(),
    'utf-8',
  );
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), 'ok\n');
  globalThis.fetch = vi.fn<typeof fetch>(async () =>
    buildCompletionResponse('fetch'),
  );

  const writeFileSpy = vi.spyOn(fs, 'writeFileSync');

  await runLocomoNativeCli([
    'run',
    '--install-dir',
    installDir,
    '--budget',
    '4000',
    '--num-samples',
    '1',
  ]);

  const progressWrites = writeFileSpy.mock.calls.filter(([filePath]) =>
    String(filePath).endsWith('progress.json'),
  );

  expect(progressWrites).toHaveLength(3);
});

test('official LOCOMO scoring keeps lexical F1 behavior for paraphrases', () => {
  expect(
    scoreOfficialLocomoAnswer({
      category: 1,
      answer: 'Transgender woman',
      prediction: 'a trans woman',
    }),
  ).toBe(0.5);
});

test('locomo native retrieval mode scores native memory hit rate without model calls', async () => {
  const { runLocomoNativeCli } = await import('../src/evals/locomo-native.ts');
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-locomo-'),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9090/v1';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.HYBRIDCLAW_EVAL_MODEL = 'hybridai/gpt-4.1-mini';

  fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'data', 'locomo10.json'),
    buildSampleDataset(),
    'utf-8',
  );
  fs.writeFileSync(path.join(installDir, '.hybridclaw-setup-ok'), 'ok\n');
  globalThis.fetch = vi.fn<typeof fetch>(async () => {
    throw new Error('retrieval mode should not call the model gateway');
  });

  await runLocomoNativeCli([
    'run',
    '--install-dir',
    installDir,
    '--mode',
    'retrieval',
    '--budget',
    '4000',
    '--num-samples',
    '1',
  ]);

  expect(globalThis.fetch).not.toHaveBeenCalled();
  const jobRoot = path.join(installDir, 'jobs');
  const [jobDirName] = fs.readdirSync(jobRoot);
  const summary = JSON.parse(
    fs.readFileSync(path.join(jobRoot, jobDirName, 'result.json'), 'utf-8'),
  ) as {
    mode: string;
    model: string | null;
    overallScore: number;
    contextF1: number | null;
    tokenUsage: unknown;
    categories: Record<
      string,
      {
        meanScore: number;
        questionCount: number;
        contextF1: number | null;
      }
    >;
    predictionsPath: string;
  };
  const predictions = JSON.parse(
    fs.readFileSync(summary.predictionsPath, 'utf-8'),
  ) as Array<{
    qa: Array<{
      score: number;
      contextF1: number | null;
      retrievedSourceMessageIds: number[];
    }>;
  }>;

  expect(summary.mode).toBe('retrieval');
  expect(summary.model).toBeNull();
  expect(summary.overallScore).toBe(1);
  expect(summary.contextF1).toBeGreaterThan(0);
  expect(summary.tokenUsage).toBeNull();
  expect(summary.categories['1']?.meanScore).toBe(1);
  expect(summary.categories['1']?.contextF1).toBeGreaterThan(0);
  expect(predictions[0]?.qa).toHaveLength(2);
  expect(predictions[0]?.qa.every((entry) => entry.score === 1)).toBe(true);
  expect(
    predictions[0]?.qa.every(
      (entry) =>
        Array.isArray(entry.retrievedSourceMessageIds) &&
        entry.retrievedSourceMessageIds.length > 0,
    ),
  ).toBe(true);
});

test('locomo native retrieval hit-rate matches substring evidence recall semantics', () => {
  const [sample] = JSON.parse(buildSampleDataset()) as Array<{
    sample_id: string;
    conversation: Record<string, unknown>;
    qa: Array<{ evidence: string[] }>;
  }>;

  const hitRate = testOnlyLocomoNativeRetrieval.computeRetrievalHitRate({
    sample,
    evidence: ['D1:1', 'D1:3'],
    retrievedContent: [
      'DATE: 2024-03-01 10:00:00',
      'Alice said, "Pepper loves playing fetch every evening."',
      'Alice said, "Tomorrow I will pack crunchy carrots for lunch."',
    ].join('\n'),
  });
  const missRate = testOnlyLocomoNativeRetrieval.computeRetrievalHitRate({
    sample,
    evidence: ['D1:1', 'D1:3'],
    retrievedContent: 'Bob said, "The weather turned rainy today."',
  });

  expect(hitRate).toBe(1);
  expect(missRate).toBe(0);
});

test('locomo native retrieval context F1 matches whitespace token overlap semantics', () => {
  expect(
    testOnlyLocomoNativeRetrieval.computeContextTokenF1('fetch,', 'fetch'),
  ).toBe(0);
  expect(
    testOnlyLocomoNativeRetrieval.computeContextTokenF1('fetch fetch', 'fetch'),
  ).toBeCloseTo(2 / 3, 6);
});

test('official LOCOMO scoring uses Porter stemming semantics', () => {
  expect(
    testOnlyLocomoOfficialScoring.singleAnswerF1('adopted', 'adoption'),
  ).toBe(1);
  expect(
    scoreOfficialLocomoAnswer({
      category: 2,
      answer: 'adoption',
      prediction: 'adopted',
    }),
  ).toBe(1);
});
