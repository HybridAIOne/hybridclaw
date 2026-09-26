/**
 * Fetch short-lived shell credentials after tool approval, never during chat.
 * Only the allowlisted CLI environment reaches the shell; this helper does
 * not expose credentials as tool output or mutate the agent environment.
 */
import {
  SHELL_RUNTIME_ENV_NAMES,
  SHELL_RUNTIME_ENV_PATH,
} from '../shared/shell-runtime-env.js';

export async function resolveShellRuntimeEnv(
  baseUrl: string,
  apiToken: string,
): Promise<Record<string, string>> {
  if (!baseUrl || !apiToken) return {};
  const response = await fetch(
    `${baseUrl.replace(/\/+$/, '')}${SHELL_RUNTIME_ENV_PATH}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
      redirect: 'error',
      // 2026-09-25 fix: bound optional credential handoff to 10s; no retries here.
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error('Unable to resolve shell credentials.');
  const body: unknown = await response.json().catch(() => {
    throw new Error('Invalid shell credential response.');
  });
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid shell credential response.');
  }
  const env: Record<string, string> = {};
  for (const name of SHELL_RUNTIME_ENV_NAMES) {
    const value = (body as Record<string, unknown>)[name];
    if (typeof value === 'string' && !value.includes('\0')) env[name] = value;
  }
  return env;
}
