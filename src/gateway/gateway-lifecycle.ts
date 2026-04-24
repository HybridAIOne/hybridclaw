import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config/config.js';

export interface GatewayPidState {
  pid: number;
  startedAt: string;
  cwd: string;
  command: string[];
}

export const GATEWAY_RUN_DIR = path.join(DATA_DIR, 'gateway');
export const GATEWAY_PID_PATH = path.join(GATEWAY_RUN_DIR, 'gateway.pid.json');
export const GATEWAY_LOG_PATH = path.join(GATEWAY_RUN_DIR, 'gateway.log');
export const GATEWAY_MODEL_RESPONSE_DEBUG_PATH = path.join(
  GATEWAY_RUN_DIR,
  'model-responses.log',
);
export const GATEWAY_LOG_FILE_ENV = 'HYBRIDCLAW_GATEWAY_LOG_FILE';
export const GATEWAY_LOG_REQUESTS_ENV = 'HYBRIDCLAW_LOG_REQUESTS';
export const GATEWAY_DEBUG_MODEL_RESPONSES_ENV =
  'HYBRIDCLAW_DEBUG_MODEL_RESPONSES';
export const GATEWAY_SYSTEM_PROMPT_MODE_ENV = 'HYBRIDCLAW_SYSTEM_PROMPT_MODE';
export const GATEWAY_SYSTEM_PROMPT_PARTS_ENV = 'HYBRIDCLAW_SYSTEM_PROMPT_PARTS';
export const GATEWAY_SYSTEM_PROMPT_EXCLUDE_PARTS_ENV =
  'HYBRIDCLAW_SYSTEM_PROMPT_EXCLUDE_PARTS';
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
