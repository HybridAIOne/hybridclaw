import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, GATEWAY_BASE_URL } from '../config/config.js';

export interface GatewayPidState {
  pid: number;
  startedAt: string;
  cwd: string;
  command: string[];
}

export const GATEWAY_RUN_DIR = path.join(DATA_DIR, 'gateway');
export const GATEWAY_PID_PATH = path.join(GATEWAY_RUN_DIR, 'gateway.pid.json');
export const GATEWAY_LOG_PATH = path.join(GATEWAY_RUN_DIR, 'gateway.log');
export const GATEWAY_LOG_FILE_ENV = 'HYBRIDCLAW_GATEWAY_LOG_FILE';
export const GATEWAY_STDIO_TO_LOG_ENV = 'HYBRIDCLAW_GATEWAY_STDIO_TO_LOG';

export function ensureGatewayRunDir(): void {
  fs.mkdirSync(GATEWAY_RUN_DIR, { recursive: true });
}

export function writeGatewayPid(state: GatewayPidState): void {
  ensureGatewayRunDir();
  const tmp = `${GATEWAY_PID_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, GATEWAY_PID_PATH);
}

export function removeGatewayPidFile(): void {
  if (fs.existsSync(GATEWAY_PID_PATH)) fs.unlinkSync(GATEWAY_PID_PATH);
}

export function readGatewayPid(): GatewayPidState | null {
  try {
    const raw = fs.readFileSync(GATEWAY_PID_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GatewayPidState>;
    if (
      !parsed ||
      typeof parsed.pid !== 'number' ||
      !Number.isFinite(parsed.pid)
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      command: Array.isArray(parsed.command)
        ? parsed.command.map((item) => String(item))
        : [],
    };
  } catch {
    return null;
  }
}

export function isPidRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseGatewayBaseUrl(): URL | null {
  try {
    return new URL(GATEWAY_BASE_URL);
  } catch {
    return null;
  }
}

function isLocalGatewayHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1'
  );
}

function resolveGatewayListenPort(url: URL): number {
  if (url.port) {
    const parsed = Number.parseInt(url.port, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return url.protocol === 'https:' ? 443 : 80;
}

export function findGatewayPidByPort(): number | null {
  const parsed = parseGatewayBaseUrl();
  if (!parsed || !isLocalGatewayHost(parsed.hostname)) return null;
  const port = resolveGatewayListenPort(parsed);

  const result = spawnSync(
    'lsof',
    ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
    {
      encoding: 'utf-8',
    },
  );
  if (result.error) return null;
  const output = (result.stdout || '').trim();
  if (!output) return null;

  const firstPid = output
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .find((pid) => Number.isFinite(pid) && pid > 0);
  return firstPid && Number.isFinite(firstPid) ? firstPid : null;
}
