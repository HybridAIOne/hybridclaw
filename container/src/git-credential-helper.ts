/**
 * git credential helper that asks the HybridClaw gateway for GitHub
 * credentials. Wired into agent bash sessions via GIT_CONFIG_* env, scoped to
 * https://github.com. The token never touches git config, the environment, or
 * disk; git receives it on stdout for the single operation that asked.
 *
 * Usage (by git): node git-credential-helper.js get|store|erase
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const GIT_CREDENTIAL_HELPER_TIMEOUT_MS = 15_000;
export const GITHUB_CREDENTIAL_CONFIG_KEY =
  'credential.https://github.com.helper';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Compiled helper next to this module, or null when not built (e.g. tests). */
export function resolveGitCredentialHelperPath(): string | null {
  const candidate = fileURLToPath(
    new URL('./git-credential-helper.js', import.meta.url),
  );
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Adds the gateway-backed GitHub credential helper to a bash env via
 * GIT_CONFIG_COUNT/KEY/VALUE, appending after any entries already present.
 */
export function applyGitCredentialHelperEnv(
  env: Record<string, string>,
  params: { helperPath: string; nodePath: string },
): Record<string, string> {
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT || '0', 10);
  const index = Number.isInteger(existing) && existing > 0 ? existing : 0;
  env[`GIT_CONFIG_KEY_${index}`] = GITHUB_CREDENTIAL_CONFIG_KEY;
  env[`GIT_CONFIG_VALUE_${index}`] =
    `!${shellQuote(params.nodePath)} ${shellQuote(params.helperPath)}`;
  env.GIT_CONFIG_COUNT = String(index + 1);
  return env;
}

export function parseGitCredentialInput(input: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of input.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    fields[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return fields;
}

function hasUnsafeCredentialChars(value: string): boolean {
  return /[\0\r\n]/.test(value);
}

export async function runGitCredentialHelper(params: {
  operation: string | undefined;
  input: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<{ stdout: string; stderr: string }> {
  // store/erase are no-ops: credentials are minted per request by the gateway.
  if (params.operation !== 'get') return { stdout: '', stderr: '' };

  const request = parseGitCredentialInput(params.input);
  const protocol = String(request.protocol || '').toLowerCase();
  const host = String(request.host || '').toLowerCase();
  if (protocol !== 'https' || host !== 'github.com') {
    return { stdout: '', stderr: '' };
  }

  const gatewayUrl = String(params.env.HYBRIDCLAW_GATEWAY_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const gatewayToken = String(params.env.HYBRIDCLAW_GATEWAY_TOKEN || '').trim();
  if (!gatewayUrl) {
    return {
      stdout: '',
      stderr:
        'hybridclaw: GitHub credentials unavailable (gateway URL not configured).\n',
    };
  }

  const sessionId = String(params.env.HYBRIDCLAW_SESSION_ID || '').trim();
  const agentId = String(params.env.HYBRIDCLAW_AGENT_ID || '').trim();
  const fetchImpl = params.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${gatewayUrl}/api/git/credential`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {}),
      },
      body: JSON.stringify({
        protocol,
        host,
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {}),
      }),
      signal: AbortSignal.timeout(GIT_CREDENTIAL_HELPER_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      const message =
        typeof payload.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : `gateway returned HTTP ${response.status}`;
      return {
        stdout: '',
        stderr: `hybridclaw: GitHub credentials unavailable: ${message}\n`,
      };
    }
    const username =
      typeof payload.username === 'string' ? payload.username : '';
    const password =
      typeof payload.password === 'string' ? payload.password : '';
    if (
      !username ||
      !password ||
      hasUnsafeCredentialChars(username) ||
      hasUnsafeCredentialChars(password)
    ) {
      return {
        stdout: '',
        stderr:
          'hybridclaw: GitHub credentials unavailable: invalid gateway response.\n',
      };
    }
    return {
      stdout: `username=${username}\npassword=${password}\n`,
      stderr: '',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stdout: '',
      stderr: `hybridclaw: GitHub credentials unavailable: ${message}\n`,
    };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  const result = await runGitCredentialHelper({
    operation: process.argv[2],
    input: await readStdin(),
    env: process.env,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
}

const invokedPath = process.argv[1] || '';
if (
  invokedPath.endsWith('git-credential-helper.js') ||
  invokedPath.endsWith('git-credential-helper.ts')
) {
  main().catch(() => {
    // Never fail git's credential lookup hard; git falls through to the
    // next helper or reports missing credentials itself.
    process.exitCode = 0;
  });
}
