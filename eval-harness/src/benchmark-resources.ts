/**
 * Benchmark admission protects shared engine capacity, including VM backing disk.
 * This harness guard owns only its probe and run lock; it never prunes Docker or
 * restarts services. Estimates and polling cannot enforce a disk write quota.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDiskFreeBytes } from '../../src/doctor/utils.js';
import { parseMacAvailableMemory } from '../../src/inference/local-model-catalog.js';
import { benchmarkCommand } from './benchmark-command.js';

const GIB = 1024 ** 3;
// 2026-10-30, Codex: conservative harness estimates after shared-disk exhaustion;
// task-specific profiling and filesystem quotas remain operator responsibilities.
export const DEFAULT_BENCHMARK_BUDGET = {
  memoryGiB: 2,
  swapGiB: 1,
  diskGiB: 8,
  artifactGiB: 1,
};
const MEMORY_RESERVE = 2 * GIB;
const DISK_RESERVE = 20 * GIB;
const MAX_SWAP_USED = 2 * GIB;
// XNU exports dispatch pressure levels, not its internal enum. Retained swap
// alone is not a current-pressure signal on macOS.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c
const MAC_PRESSURE_NORMAL = 1;
const MAC_PRESSURE_LEVELS = new Set([MAC_PRESSURE_NORMAL, 2, 4]);
const POLL_MS = 5_000;
const PROBE_TIMEOUT_MS = 10_000;
export const BENCHMARK_PROBE_IMAGE = 'busybox:1.37';

export interface BenchmarkBudget {
  memoryGiB: number;
  swapGiB: number;
  diskGiB: number;
  artifactGiB: number;
}

export interface BenchmarkSnapshot {
  hostMemoryAvailable: number;
  hostSwapUsed: number;
  hostMemoryPressureLevel?: number;
  hostDiskFree: number;
  engineMemoryAvailable: number;
  engineSwapFree: number;
  engineSwapUsed: number;
  engineDiskFree: number;
}

export function parseMacMemoryPressure(output: string): number {
  const level = Number(output.trim());
  if (!MAC_PRESSURE_LEVELS.has(level))
    throw new Error('Missing or invalid macOS memory-pressure metric');
  return level;
}

export function parseEngineResources(
  output: string,
): Pick<
  BenchmarkSnapshot,
  | 'engineMemoryAvailable'
  | 'engineSwapFree'
  | 'engineSwapUsed'
  | 'engineDiskFree'
> {
  const read = (key: string): number => {
    const match = output.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm'));
    if (!match) throw new Error(`Missing engine resource metric: ${key}`);
    return Number(match[1]) * 1024;
  };
  const diskLine = output.trim().split('\n').at(-1)?.trim().split(/\s+/);
  const diskFree = Number(diskLine?.[3]) * 1024;
  if (!Number.isFinite(diskFree) || diskFree < 0)
    throw new Error('Missing engine disk metric');
  const swapFree = read('SwapFree');
  return {
    engineMemoryAvailable: read('MemAvailable'),
    engineSwapFree: swapFree,
    engineSwapUsed: read('SwapTotal') - swapFree,
    engineDiskFree: diskFree,
  };
}

export function assertBenchmarkCapacity(
  snapshot: BenchmarkSnapshot,
  budget: BenchmarkBudget,
  slots: number,
  remainingTasks: number,
): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Invalid benchmark resource metric: ${name}`);
  }
  const memoryDemand = slots * budget.memoryGiB * GIB;
  const swapDemand = slots * budget.swapGiB * GIB;
  // Host agents need RAM too; retained snapshots accumulate across the whole run.
  const hostMemoryDemand = memoryDemand + slots * GIB;
  const diskDemand =
    remainingTasks * (budget.diskGiB + budget.artifactGiB) * GIB + swapDemand;
  const requirements = {
    hostMemoryAvailable: MEMORY_RESERVE + hostMemoryDemand,
    engineMemoryAvailable: MEMORY_RESERVE + memoryDemand,
    hostDiskFree: DISK_RESERVE + diskDemand,
    engineDiskFree: DISK_RESERVE + diskDemand,
    engineSwapFree: swapDemand,
  };
  for (const [key, required] of Object.entries(requirements)) {
    const available = snapshot[key as keyof typeof requirements];
    if (available < required) {
      throw new Error(
        `Benchmark resource admission refused: ${key} ${(available / GIB).toFixed(2)} GiB available, ${(required / GIB).toFixed(2)} GiB required. Reduce concurrency/task count or free capacity.`,
      );
    }
  }
  const pressure = snapshot.hostMemoryPressureLevel;
  if (pressure !== undefined) {
    if (!MAC_PRESSURE_LEVELS.has(pressure))
      throw new Error('Invalid macOS memory-pressure metric');
    if (pressure !== MAC_PRESSURE_NORMAL)
      throw new Error(
        'Benchmark resource admission refused: macOS reports elevated memory pressure.',
      );
  }
  if (
    (pressure === undefined && snapshot.hostSwapUsed > MAX_SWAP_USED) ||
    snapshot.engineSwapUsed > MAX_SWAP_USED
  )
    throw new Error(
      'Benchmark resource admission refused: existing swap pressure exceeds 2 GiB.',
    );
}

export class BenchmarkResources {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly probeName = `hybridclaw-benchmark-probe-${randomUUID()}`;
  private lockPath?: string;
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<void> = Promise.resolve();
  private checking = false;
  private engineId?: string;
  private failure?: Error;
  private probeStarted = false;

  constructor(
    private readonly paths: string[],
    readonly budget: BenchmarkBudget,
    private readonly record: (snapshot: BenchmarkSnapshot) => void,
  ) {}

  private async docker(args: string[]): Promise<string> {
    const result = await benchmarkCommand({
      command: 'docker',
      args,
      timeout: PROBE_TIMEOUT_MS,
    });
    return result.stdout;
  }

  private async hostResources() {
    let memoryAvailable = os.freemem();
    let swapUsed: number;
    let memoryPressure: number | undefined;
    if (os.platform() === 'darwin') {
      const vm = await benchmarkCommand({
        command: '/usr/bin/vm_stat',
        args: [],
        timeout: PROBE_TIMEOUT_MS,
      });
      const parsedMemory = parseMacAvailableMemory(vm.stdout);
      if (parsedMemory === undefined)
        throw new Error('Missing host memory metric');
      memoryAvailable = parsedMemory;
      const swap = await benchmarkCommand({
        command: '/usr/sbin/sysctl',
        args: ['vm.swapusage'],
        timeout: PROBE_TIMEOUT_MS,
      });
      const match = swap.stdout.match(/used = ([\d.]+)M/);
      if (!match) throw new Error('Missing host swap metric');
      swapUsed = Number(match[1]) * 1024 ** 2;
      const pressure = await benchmarkCommand({
        command: '/usr/sbin/sysctl',
        args: ['-n', 'kern.memorystatus_vm_pressure_level'],
        timeout: PROBE_TIMEOUT_MS,
      });
      memoryPressure = parseMacMemoryPressure(pressure.stdout);
    } else if (os.platform() === 'linux') {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const read = (name: string) => {
        const match = meminfo.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'));
        if (!match) throw new Error(`Missing host resource metric: ${name}`);
        return Number(match[1]) * 1024;
      };
      memoryAvailable = read('MemAvailable');
      swapUsed = read('SwapTotal') - read('SwapFree');
    } else {
      throw new Error(
        'Benchmark resource monitoring supports macOS and Linux hosts.',
      );
    }
    const diskPaths = [...this.paths, os.tmpdir(), os.homedir()];
    if (os.platform() === 'darwin') {
      const orbData = path.join(
        os.homedir(),
        'Library/Group Containers/HUAQ24HBR6.dev.orbstack/data',
      );
      if (fs.existsSync(orbData)) diskPaths.push(fs.realpathSync(orbData));
    }
    const disks = diskPaths.map((target) => {
      const free = readDiskFreeBytes(target);
      if (free === null)
        throw new Error(`Cannot measure benchmark disk capacity: ${target}`);
      return free;
    });
    return {
      hostMemoryAvailable: memoryAvailable,
      hostSwapUsed: swapUsed,
      ...(memoryPressure !== undefined
        ? { hostMemoryPressureLevel: memoryPressure }
        : {}),
      hostDiskFree: Math.min(...disks),
    };
  }

  async start(slots: number, tasks: number): Promise<void> {
    this.signal.throwIfAborted();
    const host = await this.hostResources();
    // Refuse host pressure before even creating the small, cached probe container.
    assertBenchmarkCapacity(
      {
        ...host,
        engineMemoryAvailable: Number.MAX_SAFE_INTEGER,
        engineSwapFree: Number.MAX_SAFE_INTEGER,
        engineSwapUsed: 0,
        engineDiskFree: Number.MAX_SAFE_INTEGER,
      },
      this.budget,
      slots,
      tasks,
    );
    const info = JSON.parse(
      await this.docker(['info', '--format', '{{json .}}']),
    ) as { ID?: string; MemoryLimit?: boolean; SwapLimit?: boolean };
    if (!info.ID || !info.MemoryLimit || !info.SwapLimit)
      throw new Error(
        'Benchmark requires a healthy Docker engine with memory and swap limits.',
      );
    this.engineId = info.ID;
    const key = createHash('sha256').update(info.ID).digest('hex').slice(0, 16);
    const lockPath = path.join(os.tmpdir(), `hybridclaw-benchmark-${key}.lock`);
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error(
        `Another benchmark owns this Docker engine. Lock: ${lockPath}. If its process has exited, remove this lock manually.`,
      );
    }
    this.lockPath = lockPath;
    try {
      // Never pull a probe image during admission: missing cache fails closed.
      try {
        await this.docker(['image', 'inspect', BENCHMARK_PROBE_IMAGE]);
      } catch {
        throw new Error(
          `Benchmark probe is unavailable. Cache it before running: docker pull ${BENCHMARK_PROBE_IMAGE}`,
        );
      }
      this.signal.throwIfAborted();
      this.probeStarted = true;
      await this.docker([
        'run',
        '-d',
        '--rm',
        '--pull=never',
        '--name',
        this.probeName,
        '--network=none',
        '--read-only',
        '--memory=32m',
        '--memory-swap=32m',
        '--pids-limit=16',
        '--entrypoint=sh',
        BENCHMARK_PROBE_IMAGE,
        '-c',
        'while :; do sleep 3600; done',
      ]);
      await this.check(slots, tasks);
      this.timer = setInterval(() => {
        if (!this.checking) void this.check(0, 0).catch(() => {});
      }, POLL_MS);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  abort(error: Error): void {
    this.failure ??= error;
    this.controller.abort(this.failure);
  }

  check(slots: number, tasks: number): Promise<void> {
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        if (this.failure) throw this.failure;
        this.checking = true;
        try {
          const engineId = (
            await this.docker(['info', '--format', '{{.ID}}'])
          ).trim();
          if (engineId !== this.engineId)
            throw new Error('Docker engine changed during benchmark');
          const host = await this.hostResources();
          const output = await this.docker([
            'exec',
            this.probeName,
            'sh',
            '-c',
            'cat /proc/meminfo; df -Pk /',
          ]);
          const snapshot = { ...host, ...parseEngineResources(output) };
          this.record(snapshot);
          assertBenchmarkCapacity(snapshot, this.budget, slots, tasks);
        } catch (error) {
          this.abort(
            new Error(
              `Benchmark infrastructure stopped: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          throw this.failure;
        } finally {
          this.checking = false;
        }
      });
    return this.pending;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.pending.catch(() => {});
    if (this.probeStarted) {
      await benchmarkCommand({
        command: 'docker',
        args: ['rm', '-f', this.probeName],
        timeout: PROBE_TIMEOUT_MS,
        allowFailure: true,
      });
      this.probeStarted = false;
    }
    if (this.lockPath) {
      fs.unlinkSync(this.lockPath);
      this.lockPath = undefined;
    }
  }
}
