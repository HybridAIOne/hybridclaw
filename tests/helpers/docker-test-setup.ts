import { execSync } from 'node:child_process';
import net from 'node:net';

/**
 * Shared helpers for Docker-based e2e tests.
 *
 * Current call sites pass hardcoded literals only. Functions accept
 * arbitrary strings — callers must ensure args are shell-safe.
 */

export const CONTAINER_PREFIX = 'hc-e2e';

/**
 * Remove any stale containers from previous test runs that match the
 * given suite prefix (e.g. 'gw', 'agent').
 */
export function cleanupStaleContainers(suitePrefix: string): void {
  try {
    const ids = execSync(
      `docker ps -a --filter name=^${CONTAINER_PREFIX}-${suitePrefix} -q`,
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    if (ids) {
      execSync(`docker rm -f ${ids.split('\n').join(' ')}`, {
        stdio: 'pipe',
        timeout: 15_000,
      });
    }
  } catch (err) {
    console.warn(`[cleanup] Failed to remove stale ${suitePrefix} containers:`, err);
  }
}

/**
 * Find an available TCP port. Tries the preferred port first, falls back
 * to an OS-assigned ephemeral port on EADDRINUSE.
 *
 * Note: there is a TOCTOU race between releasing the port here and Docker
 * binding it. This is acceptable for tests — a collision is extremely
 * unlikely in practice.
 */
export async function getAvailablePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && preferred) {
        // Fall back to OS-assigned port
        const fallback = net.createServer();
        fallback.on('error', reject);
        fallback.listen(0, '127.0.0.1', () => {
          const addr = fallback.address() as net.AddressInfo;
          fallback.close(() => resolve(addr.port));
        });
      } else {
        reject(err);
      }
    });
    server.listen(preferred ?? 0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
  });
}

/**
 * Poll a URL until the response satisfies a condition or the timeout expires.
 * By default checks for `{ status: 'ok' }`. Polls every 500ms with a 2s
 * per-request timeout.
 */
export async function waitForHealth(
  url: string,
  timeoutMs: number,
  predicate?: (body: Record<string, unknown>) => boolean,
): Promise<void> {
  const check = predicate ?? ((b: Record<string, unknown>) => b.status === 'ok');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        if (check(body)) return;
      }
    } catch (err) {
      // Network errors (ECONNREFUSED, AbortError) are expected during startup.
      if (err instanceof TypeError || err instanceof SyntaxError) {
        console.warn(`[health] Unexpected error polling ${url}:`, (err as Error).message);
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Health check at ${url} did not pass within ${timeoutMs}ms`);
}

/**
 * Execute a command inside a running Docker container.
 */
export function dockerExec(
  containerName: string,
  cmd: string,
  timeoutMs = 10_000,
): string {
  // Double-quote the sh -c argument so single quotes work inside commands.
  // Only double quotes are escaped — does not protect against $() or backticks.
  const escaped = cmd.replace(/"/g, '\\"');
  return execSync(`docker exec ${containerName} sh -c "${escaped}"`, {
    encoding: 'utf-8',
    timeout: timeoutMs,
  }).trim();
}

interface StartContainerOpts {
  image: string;
  name: string;
  port?: { host: number; container: number };
  env?: Record<string, string>;
  entrypoint?: string[];
}

interface StartContainerResult {
  name: string;
  port: number | undefined;
  exec: (cmd: string, timeoutMs?: number) => string;
  cleanup: () => void;
}

/**
 * Start a named Docker container with optional port mapping, env vars,
 * and entrypoint override.
 */
export function startContainer(opts: StartContainerOpts): StartContainerResult {
  const parts = ['docker run -d', `--name ${opts.name}`];

  if (opts.port) {
    parts.push(`-p ${opts.port.host}:${opts.port.container}`);
  }

  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      parts.push(`-e ${key}=${value}`);
    }
  }

  if (opts.entrypoint) {
    parts.push(`--entrypoint ${opts.entrypoint[0]}`);
  }

  parts.push(opts.image);

  if (opts.entrypoint && opts.entrypoint.length > 1) {
    parts.push(...opts.entrypoint.slice(1));
  }

  execSync(parts.join(' '), { stdio: 'pipe', timeout: 15_000 });

  return {
    name: opts.name,
    port: opts.port?.host,
    exec: (cmd: string, timeoutMs?: number) =>
      dockerExec(opts.name, cmd, timeoutMs),
    cleanup: () => removeContainer(opts.name),
  };
}

/**
 * Best-effort removal of a named container.
 */
export function removeContainer(name: string): void {
  try {
    execSync(`docker rm -f ${name}`, { stdio: 'pipe', timeout: 15_000 });
  } catch (err) {
    console.warn(`[cleanup] Failed to remove container ${name}:`, err);
  }
}
