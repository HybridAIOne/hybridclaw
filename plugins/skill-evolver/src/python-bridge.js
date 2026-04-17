import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(__filename), '..');

const DEFAULT_CAPTURE_LIMIT_BYTES = 2_000_000;

function venvPythonPath() {
  return process.platform === 'win32'
    ? path.join(PLUGIN_ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(PLUGIN_ROOT, '.venv', 'bin', 'python');
}

function missingPluginVenvError(venv) {
  return new Error(
    `Skill Evolver plugin environment is missing: ${venv}\n` +
      'Run `hybridclaw plugin install ./plugins/skill-evolver --yes` to create the plugin virtual environment and install its pip dependencies.',
  );
}

function resolvePython() {
  const venv = venvPythonPath();
  if (fs.existsSync(venv)) return venv;
  throw missingPluginVenvError(venv);
}

function ensurePackageInstalled(python) {
  const result = spawnSync(
    python,
    ['-c', 'import skill_evolver, sys; sys.exit(0)'],
    { cwd: PLUGIN_ROOT, encoding: 'utf-8' },
  );
  if (result.status === 0) return;
  const install = spawnSync(
    python,
    ['-m', 'pip', 'install', '--no-deps', '-e', PLUGIN_ROOT],
    { cwd: PLUGIN_ROOT, encoding: 'utf-8' },
  );
  if (install.status !== 0) {
    throw new Error(
      `Failed to install hybridclaw-skill-evolver into plugin venv.\n${install.stderr || install.stdout}`,
    );
  }
}

function filteredEnv(extra = {}) {
  const allow = [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
  ];
  const env = {};
  for (const key of allow) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  return { ...env, ...extra };
}

function collectCapped(stream, collector) {
  stream.on('data', (chunk) => {
    if (collector.truncated) return;
    const remaining = collector.limit - collector.size;
    if (remaining <= 0) {
      collector.truncated = true;
      return;
    }
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), 'utf-8');
    if (buf.length <= remaining) {
      collector.chunks.push(buf);
      collector.size += buf.length;
    } else {
      collector.chunks.push(buf.slice(0, remaining));
      collector.size += remaining;
      collector.truncated = true;
    }
  });
}

function makeCollector(limit = DEFAULT_CAPTURE_LIMIT_BYTES) {
  return { chunks: [], size: 0, limit, truncated: false };
}

function collectorToString(collector) {
  return Buffer.concat(collector.chunks).toString('utf-8');
}

export async function runPython(args, options = {}) {
  const python = resolvePython();
  ensurePackageInstalled(python);

  const inherit = options.stdio === 'inherit';

  if (inherit) {
    return await new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'skill_evolver', ...args], {
        cwd: PLUGIN_ROOT,
        env: filteredEnv(options.env),
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code, stdout: '', stderr: '', inherited: true });
      });
    });
  }

  const stdoutCollector = makeCollector(options.stdoutLimitBytes);
  const stderrCollector = makeCollector(options.stderrLimitBytes);

  return await new Promise((resolve, reject) => {
    const child = spawn(python, ['-m', 'skill_evolver', ...args], {
      cwd: PLUGIN_ROOT,
      env: filteredEnv(options.env),
    });
    collectCapped(child.stdout, stdoutCollector);
    collectCapped(child.stderr, stderrCollector);

    if (typeof options.onStdoutChunk === 'function') {
      child.stdout.on('data', (chunk) => options.onStdoutChunk(String(chunk)));
    }
    if (typeof options.onStderrChunk === 'function') {
      child.stderr.on('data', (chunk) => options.onStderrChunk(String(chunk)));
    }

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout: collectorToString(stdoutCollector),
        stderr: collectorToString(stderrCollector),
        stdoutTruncated: stdoutCollector.truncated,
        stderrTruncated: stderrCollector.truncated,
      });
    });
  });
}

export function pluginRoot() {
  return PLUGIN_ROOT;
}

export function workspaceCacheDir() {
  return path.join(os.tmpdir(), 'hybridclaw-skill-evolver');
}
