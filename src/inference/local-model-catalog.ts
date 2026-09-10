/**
 * Mac model admission estimates include weights, cache and system headroom.
 * This catalog is distinct from provider discovery: a fitting model is a
 * candidate for a local smoke test, never a claim of benchmark quality.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import type { MacModelArtifact } from './local-model-shortlist.js';
import { LOCAL_MODEL_SHORTLIST } from './local-model-shortlist.js';

export const GIB = 1024 ** 3;
export interface MacHardware {
  platform: string;
  arch: string;
  release: string;
  chip: string;
  memoryBytes: number;
  availableMemoryEstimateBytes?: number;
}
export const MAC_MODEL_CATALOG = LOCAL_MODEL_SHORTLIST.flatMap((entry) =>
  entry.installation
    ? [
        {
          id: entry.id,
          label: entry.label,
          note: entry.note,
          sourceRepo: entry.sourceRepo,
          listedMemoryGb: entry.listedMemoryGb,
          ...entry.installation,
        },
      ]
    : [],
);

export function detectMacHardware(): MacHardware {
  const hardware: MacHardware = {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    chip: os.cpus()[0]?.model || 'unknown',
    memoryBytes: os.totalmem(),
  };
  if (hardware.platform === 'darwin') {
    try {
      hardware.availableMemoryEstimateBytes = parseMacAvailableMemory(
        execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000 }),
      );
    } catch {
      /* Total-memory admission still applies when VM stats are unavailable. */
    }
  }
  return hardware;
}

export function parseMacAvailableMemory(
  statistics: string,
): number | undefined {
  const pageSize = Number(statistics.match(/page size of (\d+) bytes/)?.[1]);
  const free = statistics.match(/^Pages free:\s+(\d+)/m)?.[1];
  const inactive = statistics.match(/^Pages inactive:\s+(\d+)/m)?.[1];
  if (!pageSize || free === undefined || inactive === undefined)
    return undefined;
  // Darwin's vm_statistics.h includes speculative pages in free_count already.
  // Inactive pages are potentially reclaimable, not a guarantee of free RAM.
  return (Number(free) + Number(inactive)) * pageSize;
}

export function estimateMacModels(hardware: MacHardware) {
  const supported =
    hardware.platform === 'darwin' &&
    hardware.arch === 'arm64' &&
    Number.parseInt(hardware.release, 10) >= 24;
  // 2026-09-09, Codex conservative defaults: reserve >=4 GiB or 25% for
  // macOS/agent/browser; prefill and allocator reserve is 1 GiB. Tune by benchmark.
  const reservedBytes = Math.max(4 * GIB, hardware.memoryBytes * 0.25);
  const memoryLimitBytes = Math.max(
    0,
    Math.floor(
      Math.min(
        hardware.memoryBytes - reservedBytes,
        hardware.availableMemoryEstimateBytes === undefined
          ? Infinity
          : hardware.availableMemoryEstimateBytes - GIB,
      ),
    ),
  );
  const candidates = MAC_MODEL_CATALOG.map((model) => {
    const contextWindow =
      [40960, 32768, 16384, 8192, 4096, 2048].find(
        (context) =>
          context <= model.maxContextWindow &&
          model.weightBytes * 1.1 +
            GIB +
            2 * estimateMacModelCacheBytes(model, context) <=
            memoryLimitBytes,
      ) || 0;
    const requiredBytes = Math.ceil(
      model.weightBytes * 1.1 +
        GIB +
        2 * estimateMacModelCacheBytes(model, contextWindow || 2048),
    );
    return {
      ...model,
      contextWindow,
      requiredBytes,
      fits: supported && contextWindow > 0,
      maxTokens: Math.min(2048, Math.floor(contextWindow / 4)),
      cacheBytes: contextWindow
        ? estimateMacModelCacheBytes(model, contextWindow)
        : 0,
    };
  });
  return {
    supported,
    reservedBytes,
    memoryLimitBytes,
    candidates,
    unavailable: LOCAL_MODEL_SHORTLIST.filter(
      (entry) => !entry.installation,
    ).map((entry) => ({
      id: entry.id,
      label: entry.label,
      sourceRepo: entry.sourceRepo,
      listedMemoryGb: entry.listedMemoryGb,
      reason: entry.unavailableReason,
      ...entry.inspectedArtifact,
    })),
    recommended:
      candidates.filter((candidate) => candidate.fits).at(-1)?.id || null,
  };
}

export function estimateMacModelCacheBytes(
  model: MacModelArtifact,
  contextWindow: number,
): number {
  return Math.ceil(
    contextWindow * model.kvBytesPerToken + model.fixedCacheBytes,
  );
}
