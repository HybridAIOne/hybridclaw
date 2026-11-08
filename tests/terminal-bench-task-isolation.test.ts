import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { runTerminalBenchNativeCli } from '../eval-harness/src/terminal-bench-native.js';
import type { GatewayChatRequest } from '../src/gateway/gateway-types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  handle: vi.fn(),
  stop: vi.fn(),
  controller: new AbortController(),
}));
vi.mock('../src/agent/executor.js', () => ({
  stopSessionExecution: mocks.stop,
}));
vi.mock('../src/gateway/gateway-chat-service.js', () => ({
  handleGatewayMessage: mocks.handle,
}));
vi.mock('../eval-harness/src/benchmark-command.js', () => ({
  benchmarkCommand: mocks.command,
}));
vi.mock('../eval-harness/src/benchmark-resources.js', () => ({
  DEFAULT_BENCHMARK_BUDGET: {
    memoryGiB: 2,
    swapGiB: 1,
    diskGiB: 8,
    artifactGiB: 1,
  },
  BenchmarkResources: class {
    signal = mocks.controller.signal;
    constructor(
      _paths: string[],
      readonly budget: Record<string, number>,
    ) {}
    async start() {}
    async check() {}
    async close() {}
    registerContainer() {}
    async removeContainer() {}
    abort(reason: Error) {
      mocks.controller.abort(reason);
    }
  },
}));

interface Task {
  task_name: string;
  instruction: string;
  docker_image?: string;
  environment_tar?: string;
}
const temp = useTempDir('benchmark-task-isolation-');
useCleanMocks({
  restoreAllMocks: true,
  cleanup: () => {
    vi.useRealTimers();
  },
});
let root: string;
let tasks: Task[];
const artifacts = new Map<string, string>();
beforeEach(() => {
  root = temp();
  tasks = [
    {
      task_name: 'example',
      instruction: 'Create fixture 0.',
      docker_image: 'example/task:latest',
    },
  ];
  artifacts.clear();
  mocks.controller = new AbortController();
  mocks.handle
    .mockReset()
    .mockImplementation(async (request: GatewayChatRequest) => {
      artifacts.set(request.bashProxy!.containerName, request.content);
      return { status: 'success', result: request.content };
    });
  mocks.command
    .mockReset()
    .mockImplementation(
      async ({ command, args }: { command: string; args: string[] }) => {
        if (command !== 'docker')
          return {
            status: 0,
            stdout: args[1] === 'list' ? JSON.stringify(tasks) : '',
            stderr: '',
          };
        if (args[0] === 'cp' && args[1].endsWith(':/app/.')) {
          const container = args[1].slice(0, -':/app/.'.length);
          fs.writeFileSync(
            path.join(args[2], 'artifact.txt'),
            artifacts.get(container)!,
          );
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    );
  vi.spyOn(Date, 'now').mockReturnValue(1234);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
const run = () =>
  runTerminalBenchNativeCli([
    '--install-dir',
    root,
    '--data-dir',
    root,
    '--model',
    'example-model',
    '--num-tasks',
    String(tasks.length),
    '--n-concurrent',
    '2',
  ]);
function jobDirs() {
  return fs
    .readdirSync(path.join(root, 'jobs'))
    .map((n) => path.join(root, 'jobs', n))
    .filter((p) => fs.existsSync(path.join(p, 'result.json')));
}

test.each([
  ['report/one', 'report:one'],
  ['example', 'example'],
  ['Example', 'example'],
])(
  'keeps colliding task names in distinct workspaces and sessions: %s, %s',
  async (first, second) => {
    tasks = [first, second].map((task_name, i) => ({
      task_name,
      instruction: `Create fixture ${i}.`,
      docker_image: 'example/task:latest',
    }));
    await run();
    const requests = mocks.handle.mock.calls.map(
      ([request]) => request as GatewayChatRequest,
    );
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((r) => r.workspacePathOverride)).size).toBe(2);
    expect(new Set(requests.map((r) => r.sessionId)).size).toBe(2);
    expect(new Set(requests.map((r) => r.executionSessionId)).size).toBe(2);
    const [job] = jobDirs();
    for (const [i, request] of requests.entries()) {
      const workspace = request.workspacePathOverride!;
      const taskRoot = path.dirname(workspace);
      expect(path.dirname(taskRoot)).toBe(job);
      expect(
        fs.readFileSync(path.join(workspace, 'artifact.txt'), 'utf8'),
      ).toBe(tasks[i].instruction);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(taskRoot, 'agent-result.json'), 'utf8'),
        ).result,
      ).toBe(tasks[i].instruction);
      expect(
        JSON.parse(fs.readFileSync(path.join(taskRoot, 'summary.json'), 'utf8'))
          .taskName,
      ).toBe(tasks[i].task_name);
    }
    expect(
      JSON.parse(fs.readFileSync(path.join(job, 'result.json'), 'utf8')),
    ).toMatchObject({ trials: 2, errors: 0, mean: 1 });
  },
);

test.each(['.', '..', '---', '任務'])(
  'contains task output below its own job for name %s',
  async (task_name) => {
    tasks[0].task_name = task_name;
    await run();
    const [job] = jobDirs();
    const request = mocks.handle.mock.calls[0][0] as GatewayChatRequest;
    const taskRoot = path.dirname(request.workspacePathOverride!);
    expect(path.dirname(taskRoot)).toBe(job);
    expect(fs.existsSync(path.join(job, 'prompt.txt'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'jobs', 'prompt.txt'))).toBe(false);
  },
);

test.each([
  ['UPPER_name', 'UPPER_name'],
  ['.', '任務'],
])(
  'uses unique valid image names independently of task names: %s, %s',
  async (first, second) => {
    tasks = [first, second].map((task_name, i) => ({
      task_name,
      instruction: `Create fixture ${i}.`,
      environment_tar: 'fixture-archive',
    }));
    await run();
    const builds = mocks.command.mock.calls
      .map(([p]) => p as { args: string[] })
      .filter((p) => p.args[0] === 'build');
    const tags = builds.map((p) => p.args[p.args.indexOf('-t') + 1]);
    expect(tags).toHaveLength(2);
    expect(new Set(tags).size).toBe(2);
    for (const tag of tags)
      expect(tag).toMatch(/^hybridclaw-tb2-[a-z0-9]+(?:-[a-z0-9]+)*$/);
  },
);

test('preserves evidence from jobs started within the same clock tick', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  await run();
  const [first] = jobDirs();
  const saved = fs.readFileSync(path.join(first, 'result.json'), 'utf8');
  tasks[0].task_name = 'second';
  await run();
  expect(jobDirs()).toHaveLength(2);
  expect(fs.readFileSync(path.join(first, 'result.json'), 'utf8')).toBe(saved);
});

test('ordinary task names retain verifier results and saved artifacts', async () => {
  await run();
  const [job] = jobDirs();
  expect(
    JSON.parse(fs.readFileSync(path.join(job, 'result.json'), 'utf8')),
  ).toMatchObject({ trials: 1, errors: 0, mean: 1 });
  const request = mocks.handle.mock.calls[0][0] as GatewayChatRequest;
  expect(
    fs.readFileSync(
      path.join(request.workspacePathOverride!, 'artifact.txt'),
      'utf8',
    ),
  ).toBe(tasks[0].instruction);
});
