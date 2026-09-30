/**
 * Pass existing model credentials only through the benchmark child environment.
 * No secrets, endpoint URLs or raw per-item responses are written to this checkout.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolveModelRuntimeCredentials } from '../../src/providers/factory.ts';
import { readStoredRuntimeSecret } from '../../src/security/runtime-secrets.ts';

const [python, ...args] = process.argv.slice(2);
if (!python)
  throw new Error('Provide Python executable and benchmark arguments');
const engine = args[args.indexOf('--engine') + 1];
const env = { ...process.env };
if (engine === 'jev') {
  env.JEVBENCH_JEV_KEY =
    readStoredRuntimeSecret('JEV_API_KEY') || process.env.JEV_API_KEY;
  if (!env.JEVBENCH_JEV_KEY) throw new Error('JEV credential unavailable');
} else if (engine === 'gemma') {
  const credentials = await resolveModelRuntimeCredentials({
    model: 'haigpu2/google/gemma-4-e4b-it',
  });
  env.JEVBENCH_GEMMA_URL = credentials.baseUrl;
  // Upstream requires a key even for an unauthenticated configured endpoint.
  env.JEVBENCH_GEMMA_KEY = credentials.apiKey || 'not-required';
  env.JEVBENCH_GEMMA_MODEL = (credentials.model || '').replace(/^vllm\//, '');
  if (!env.JEVBENCH_GEMMA_KEY || !env.JEVBENCH_GEMMA_MODEL)
    throw new Error('Gemma configuration unavailable');
} else throw new Error('Expected jev or gemma engine');
const child = spawn(python, ['eval-harness/jevbench/run.py', ...args], {
  env,
  stdio: 'inherit',
});
const [code] = await once(child, 'exit');
process.exitCode = code ?? 1;
