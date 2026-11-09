import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { runTerminalBenchNativeCli } from '../eval-harness/src/terminal-bench-native.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  handle: vi.fn(),
  remove: vi.fn(),
  controller: new AbortController(),
}));
vi.mock('../src/agent/executor.js', () => ({ stopSessionExecution: vi.fn() }));
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
    removeContainer = mocks.remove;
    abort(reason: Error) {
      mocks.controller.abort(reason);
    }
  },
}));

function safePython(): string | undefined {
  const candidates = process.env.HYBRIDCLAW_TEST_PYTHON
    ? [process.env.HYBRIDCLAW_TEST_PYTHON]
    : ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11'];
  for (const command of candidates) {
    const probe = spawnSync(
      command,
      [
        '-c',
        'import sys,tarfile; assert hasattr(tarfile,"data_filter"); print(sys.executable)',
      ],
      { encoding: 'utf8' },
    );
    if (probe.status === 0) return probe.stdout.trim();
  }
}
const python = safePython();
const temporary = useTempDir('benchmark archive ');
useCleanMocks({ restoreAllMocks: true, unstubAllEnvs: true });
interface Member {
  name: string;
  contents?: string;
  kind?: 'symlink' | 'hardlink' | 'fifo';
  link?: string;
  mode?: number;
}
const safeMembers: Member[] = [
  { name: 'Dockerfile', contents: 'FROM scratch\n' },
  { name: 'bin/script.sh', contents: '#!/bin/sh\nexit 0\n', mode: 0o755 },
  { name: 'bin/privileged.sh', contents: '#!/bin/sh\nexit 0\n', mode: 0o6755 },
  { name: 'bin/link', kind: 'symlink', link: 'script.sh' },
  { name: 'bin/hard', kind: 'hardlink', link: 'bin/script.sh', mode: 0o755 },
];
const unsafe: Array<[string, Member[]]> = [
  ['parent path', [{ name: '../outside.txt', contents: 'Changed' }]],
  [
    'symlink escape',
    [
      { name: 'escape', kind: 'symlink', link: '..' },
      { name: 'escape/outside.txt', contents: 'Changed' },
    ],
  ],
  [
    'hardlink escape',
    [
      { name: 'hard', kind: 'hardlink', link: '../outside.txt' },
      { name: 'hard', contents: 'Changed' },
    ],
  ],
  [
    'symlink chain',
    [
      { name: 'alias', kind: 'symlink', link: '.' },
      { name: 'alias/escape', kind: 'symlink', link: '../outside-dir' },
      { name: 'alias/escape/target.txt', contents: 'Changed' },
    ],
  ],
  ['special file', [{ name: 'pipe', kind: 'fifo' }]],
];
function archive(members: Member[]): string {
  const script = `import base64,io,json,sys,tarfile
output=io.BytesIO()
with tarfile.open(fileobj=output,mode='w:gz') as tar:
 for value in json.load(sys.stdin):
  item=tarfile.TarInfo(value['name']);item.mode=value.get('mode',0o644)
  kind=value.get('kind')
  if kind:
   item.type={'symlink':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'fifo':tarfile.FIFOTYPE}[kind]
   item.linkname=value.get('link','');tar.addfile(item)
  else:
   data=value.get('contents','').encode();item.size=len(data);tar.addfile(item,io.BytesIO(data))
print(base64.b64encode(output.getvalue()).decode())`;
  const result = spawnSync(python!, ['-c', script], {
    input: JSON.stringify(members),
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
let root: string;
let suitePython: string;
let task: Record<string, string>;
let targets: string[];
let cancel: boolean;
beforeEach(async () => {
  root = temporary();
  targets = [];
  cancel = false;
  suitePython = path.join(
    root,
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  );
  fs.mkdirSync(path.dirname(suitePython), { recursive: true });
  if (python) fs.symlinkSync(python, suitePython);
  task = {
    task_name: 'fixture',
    instruction: 'Inspect the staged fixture.',
    docker_image: 'example/task:latest',
    test_sh: '#!/bin/sh\nexit 0',
  };
  mocks.controller = new AbortController();
  mocks.handle.mockReset().mockResolvedValue({ status: 'success' });
  mocks.remove.mockReset().mockResolvedValue(undefined);
  const actual = await vi.importActual<
    typeof import('../eval-harness/src/benchmark-command.js')
  >('../eval-harness/src/benchmark-command.js');
  mocks.command
    .mockReset()
    .mockImplementation(
      async (params: Parameters<typeof actual.benchmarkCommand>[0]) => {
        if (params.command === 'docker')
          return { status: 0, stdout: '', stderr: '' };
        if (params.args[1] === 'list')
          return { status: 0, stdout: JSON.stringify([task]), stderr: '' };
        const target = params.args.at(-1)!;
        targets.push(target);
        fs.writeFileSync(path.join(target, '..', 'outside.txt'), 'Original');
        fs.mkdirSync(path.join(target, '..', 'outside-dir'), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(target, '..', 'outside-dir', 'target.txt'),
          'Original',
        );
        if (cancel)
          mocks.controller.abort(new Error('Fixture extraction cancelled'));
        return actual.benchmarkCommand(params);
      },
    );
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
function configure(phase: string, payload: string) {
  if (phase === 'environment') {
    delete task.docker_image;
    task.environment_tar = payload;
  } else task.tests_tar = payload;
}
function run() {
  return runTerminalBenchNativeCli([
    '--install-dir',
    root,
    '--data-dir',
    root,
    '--model',
    'example-model',
  ]);
}
function result() {
  const jobs = path.join(root, 'jobs');
  const job = fs
    .readdirSync(jobs)
    .find((n) => fs.existsSync(path.join(jobs, n, 'result.json')))!;
  return JSON.parse(
    fs.readFileSync(path.join(jobs, job, 'result.json'), 'utf8'),
  );
}

describe.skipIf(!python || process.platform === 'win32')(
  'archive staging with a real safe-capable Python',
  () => {
    for (const phase of ['environment', 'verifier']) {
      test.each(unsafe)(
        `${phase} refuses %s without outside writes`,
        async (_, members) => {
          configure(phase, archive(members));
          await run();
          expect(targets).toHaveLength(1);
          const target = targets[0];
          expect(
            fs.readFileSync(path.join(target, '..', 'outside.txt'), 'utf8'),
          ).toBe('Original');
          expect(
            fs.readFileSync(
              path.join(target, '..', 'outside-dir', 'target.txt'),
              'utf8',
            ),
          ).toBe('Original');
          expect(fs.existsSync(path.join(target, 'pipe'))).toBe(false);
          expect(result()).toMatchObject({
            trials: 1,
            errors: 1,
            rewards: [{ finishedNaturally: false }],
          });
          const docker = mocks.command.mock.calls
            .map(([p]) => p)
            .filter((p) => p.command === 'docker');
          if (phase === 'environment') {
            expect(docker).toEqual([]);
            expect(mocks.handle).not.toHaveBeenCalled();
          } else expect(mocks.remove).toHaveBeenCalledOnce();
        },
      );

      test(`${phase} retains files, executable permission and contained links using suite Python`, async () => {
        configure(phase, archive(safeMembers));
        await run();
        expect(result()).toMatchObject({ errors: 0, mean: 1 });
        const target = targets[0];
        expect(fs.readFileSync(path.join(target, 'Dockerfile'), 'utf8')).toBe(
          'FROM scratch\n',
        );
        const script = path.join(target, 'bin/script.sh');
        expect(fs.statSync(script).mode & 0o7777).toBe(0o755);
        expect(
          fs.statSync(path.join(target, 'bin/privileged.sh')).mode & 0o7000,
        ).toBe(0);
        expect(fs.readlinkSync(path.join(target, 'bin/link'))).toBe(
          'script.sh',
        );
        expect(fs.statSync(path.join(target, 'bin/hard')).ino).toBe(
          fs.statSync(script).ino,
        );
        const extraction = mocks.command.mock.calls
          .map(([p]) => p)
          .find((p) => p.args[0] === '-c');
        expect(extraction.command).toBe(suitePython);
      });

      test(`${phase} refuses Python without extraction filters`, async () => {
        const site = path.join(root, 'legacy-python');
        fs.mkdirSync(site);
        fs.writeFileSync(
          path.join(site, 'sitecustomize.py'),
          'import tarfile\nif hasattr(tarfile,"data_filter"): del tarfile.data_filter\n',
        );
        vi.stubEnv('PYTHONPATH', site);
        configure(phase, archive([{ name: 'safe.txt', contents: 'Fixture' }]));
        await run();
        expect(result()).toMatchObject({ errors: 1 });
        expect(result().rewards[0].error).toMatch(
          /extraction.*filter|filter.*extraction/i,
        );
        expect(fs.existsSync(path.join(targets[0], 'safe.txt'))).toBe(false);
      });

      test(`${phase} extraction remains cancellable`, async () => {
        configure(phase, archive([{ name: 'safe.txt', contents: 'Fixture' }]));
        cancel = true;
        await expect(run()).rejects.toThrow(/cancelled/);
        expect(result().mean).toBeNull();
        expect(fs.existsSync(path.join(targets[0], 'safe.txt'))).toBe(false);
      });
    }

    test('dataset loading and extraction use the same configured interpreter', async () => {
      task.tests_tar = archive([{ name: 'safe.txt', contents: 'Fixture' }]);
      await run();
      expect(result()).toMatchObject({ errors: 0 });
      const commands = mocks.command.mock.calls.map(([p]) => p);
      const listing = commands.find((p) => p.args[1] === 'list');
      const extraction = commands.find((p) => p.args[0] === '-c');
      expect(extraction.command).toBe(listing.command);
      expect(extraction.command).toBe(suitePython);
    });

    test('empty archives do not invoke extraction', async () => {
      task.tests_tar = '  \n';
      await run();
      expect(targets).toEqual([]);
      expect(result()).toMatchObject({ errors: 0, mean: 1 });
    });
  },
);
