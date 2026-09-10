/**
 * User-owned Mac setup downloads only a selected immutable catalog artifact.
 * Configuration activates after local checks pass; serving never installs or
 * selects another model and has no cloud fallback.
 */

import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  detectMacHardware,
  estimateMacModels,
  GIB,
} from './local-model-catalog.js';
import { benchmarkMlx } from './mlx-benchmark.js';
import { connectMlxModel } from './mlx-connection.js';
import { installMlxModel } from './mlx-install.js';
import {
  mlxCredentials,
  mlxHealth,
  mlxHome,
  startMlxChild,
  stopMlxChild,
} from './mlx-runtime.js';

function privateWrite(file: string, content: string): void {
  fs.writeFileSync(`${file}.tmp`, content, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
async function setup(args: string[]) {
  const hardware = detectMacHardware();
  const estimate = estimateMacModels(hardware);
  if (args.includes('--json') && args.includes('--list')) {
    console.log(JSON.stringify({ hardware, ...estimate }));
    return;
  }
  console.log(
    `Local model setup · ${hardware.chip} · ${(hardware.memoryBytes / GIB).toFixed(0)} GiB unified memory`,
  );
  console.log(
    `Reserving ${(estimate.reservedBytes / GIB).toFixed(1)} GiB for macOS, browser and agent work. Figures below are estimates.`,
  );
  if (hardware.availableMemoryEstimateBytes !== undefined)
    console.log(
      `Currently available (estimated): ${(hardware.availableMemoryEstimateBytes / GIB).toFixed(1)} GiB; inference budget: ${(estimate.memoryLimitBytes / GIB).toFixed(1)} GiB.`,
    );
  const fitting = estimate.candidates.filter((candidate) => candidate.fits);
  console.log(
    'Current shortlist · Mac estimates include system and context memory; the post lists VRAM tiers.',
  );
  for (const candidate of estimate.candidates) {
    console.log(
      `${candidate.id === estimate.recommended ? 'Recommended: ' : ''}${candidate.label}\n` +
        `  ${candidate.id} · ${(candidate.weightBytes / GIB).toFixed(1)} GiB weights · ${candidate.fits ? `${candidate.contextWindow} token context · estimated ${(candidate.requiredBytes / GIB).toFixed(1)} GiB inference memory` : 'does not fit this setup budget'}\n  ${candidate.note}`,
    );
  }
  for (const entry of estimate.unavailable)
    console.log(
      `${entry.label} · listed at ${entry.listedMemoryGb} GB VRAM\n  Not installable here: ${entry.reason}\n  https://huggingface.co/${entry.sourceRepo}`,
    );
  if (args.includes('--list')) return;
  if (!estimate.supported)
    throw new Error(
      'Managed MLX requires Apple silicon and macOS 15 or later. Existing Ollama/llama.cpp endpoints remain available on other hardware.',
    );
  if (!fitting.length)
    throw new Error(
      'No catalog model fits with system headroom. Close other workloads or use an existing local endpoint.',
    );
  const modelIndex = args.indexOf('--model');
  let selectedId = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
  const yes = args.includes('--yes');
  if (!yes && !process.stdin.isTTY)
    throw new Error(
      'Use --list to preview, or --model <catalog-id> --yes for unattended setup.',
    );
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  const prompt = !yes
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  try {
    if (!selectedId)
      selectedId = prompt
        ? (await prompt.question(`Model [${estimate.recommended}]: `)).trim() ||
          estimate.recommended ||
          ''
        : estimate.recommended || '';
    const selected = fitting.find((candidate) => candidate.id === selectedId);
    if (!selected) {
      const unavailable = estimate.unavailable.find(
        (entry) => entry.id === selectedId,
      );
      throw new Error(
        unavailable?.reason || 'Choose a model ID that fits this Mac.',
      );
    }
    console.log(
      `Download: ${selected.repo}\nRevision: ${selected.revision}\nLicense: ${selected.license}\nThe installer also needs uv and Python 3.12. Tool checks run locally before activation.`,
    );
    if (
      prompt &&
      !/^y(es)?$/i.test(
        (await prompt.question('Download and test this model? [y/N]: ')).trim(),
      )
    )
      return;
    const report = await installMlxModel(selected.id, {
      signal: cancellation.signal,
      onProgress: (stage) => console.log(`Local setup: ${stage}…`),
    });
    console.log(
      `Local model configured: mac-mlx/${selected.id}\nChecks passed. First token: ${report.firstTokenMs} ms.\nStart with hybridclaw local serve, or Start Local Model in Labs.`,
    );
  } finally {
    prompt?.close();
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
  }
}

export async function handleMlxCommand(args: string[]): Promise<void> {
  const [command, ...options] = args;
  if (command === 'setup') {
    await setup(options);
    return;
  }
  const home = mlxHome();
  if (command === 'benchmark') {
    const report = await benchmarkMlx(home);
    privateWrite(
      path.join(home, 'benchmark.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === 'stop') {
    const { token, baseUrl } = mlxCredentials(home);
    const response = await fetch(`${baseUrl.slice(0, -3)}/control/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('The local model could not be stopped.');
    console.log('Local model unloading.');
    return;
  }
  if (command !== 'serve') throw new Error(`Unknown MLX command: ${command}`);
  if (
    options.includes('--if-configured') &&
    !fs.existsSync(path.join(home, 'installation.json'))
  )
    return;
  if (await mlxHealth(home)) {
    connectMlxModel({ home, route: 'cli.local.serve' });
    console.log('Local model is already running.');
    return;
  }
  let child: ChildProcess | undefined;
  let stopping = false;
  const cancellation = new AbortController();
  const stop = () => {
    stopping = true;
    cancellation.abort();
    if (child) void stopMlxChild(child);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    // Three bounded attempts (2026-09-09, phase-1 choice); persistent failures
    // need operator attention and must never initiate remote fallback.
    for (let attempt = 0; attempt < 3 && !stopping; attempt++) {
      try {
        child = await startMlxChild(home, cancellation.signal);
        if (stopping) {
          await stopMlxChild(child);
          return;
        }
        connectMlxModel({ home, route: 'cli.local.serve' });
        console.log('Local model ready. Ctrl-C unloads it.');
        const [code] =
          child.exitCode !== null
            ? [child.exitCode]
            : await once(child, 'exit');
        if (stopping || code === 0) return;
      } catch (error) {
        if (child) {
          await stopMlxChild(child);
          child = undefined;
        }
        if (attempt === 2) throw error;
      }
      if (!stopping) {
        console.log('Local inference stopped unexpectedly; retrying…');
        await delay(1000 * (attempt + 1));
      }
    }
    if (!stopping)
      throw new Error('Local inference failed repeatedly; it remains stopped.');
  } finally {
    if (child) await stopMlxChild(child);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}
