import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getCodexAuthStatus } from './auth/codex-auth.js';
import { getHybridAIAuthStatus } from './auth/hybridai-auth.js';
import { getWhatsAppAuthStatus } from './channels/whatsapp/auth.js';
import {
  CONTAINER_IMAGE,
  DATA_DIR,
  DB_PATH,
  DISCORD_TOKEN,
  EMAIL_PASSWORD,
  getConfigSnapshot,
  MSTEAMS_APP_ID,
  MSTEAMS_APP_PASSWORD,
  OPENROUTER_API_KEY,
} from './config/config.js';
import {
  CONFIG_VERSION,
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  isSecurityTrustAccepted,
  runtimeConfigPath,
} from './config/runtime-config.js';
import { gatewayHealth } from './gateway/gateway-client.js';
import {
  isPidRunning,
  readGatewayPid,
  removeGatewayPidFile,
} from './gateway/gateway-lifecycle.js';
import type {
  GatewayProviderHealthEntry,
  GatewayStatus,
} from './gateway/gateway-types.js';
import {
  containerImageExists,
  ensureContainerImageReady,
} from './infra/container-setup.js';
import { resolveInstallRoot } from './infra/install-root.js';
import {
  DATABASE_SCHEMA_VERSION,
  initDatabase,
  isDatabaseInitialized,
} from './memory/db.js';
import { resolveModelProvider } from './providers/factory.js';
import { checkAllBackends } from './providers/local-health.js';
import {
  summarizeInstructionIntegrity,
  syncRuntimeInstructionCopies,
  verifyInstructionIntegrity,
} from './security/instruction-integrity.js';
import { runtimeSecretsPath } from './security/runtime-secrets.js';

export interface DiagResult {
  category: string;
  label: string;
  severity: 'ok' | 'warn' | 'error';
  message: string;
  fix?: () => Promise<void>;
}

interface DoctorCheck {
  category: DoctorCategory;
  label: string;
  run: () => Promise<DiagResult[]>;
}

interface DoctorArgs {
  component: DoctorCategory | null;
  fix: boolean;
  json: boolean;
}

export interface DoctorFixOutcome {
  category: string;
  label: string;
  status: 'applied' | 'failed';
  message: string;
}

export interface DoctorReport {
  generatedAt: string;
  component: string | null;
  results: Array<DiagResult & { fixable: boolean }>;
  summary: {
    ok: number;
    warn: number;
    error: number;
    exitCode: number;
  };
  fixes: DoctorFixOutcome[];
}

type DoctorCategory =
  | 'runtime'
  | 'gateway'
  | 'config'
  | 'credentials'
  | 'database'
  | 'providers'
  | 'local-backends'
  | 'docker'
  | 'channels'
  | 'security'
  | 'disk';

const DOCTOR_CATEGORIES: DoctorCategory[] = [
  'runtime',
  'gateway',
  'config',
  'credentials',
  'database',
  'providers',
  'local-backends',
  'docker',
  'channels',
  'security',
  'disk',
];

const SEVERITY_ORDER: Record<DiagResult['severity'], number> = {
  ok: 0,
  warn: 1,
  error: 2,
};

function shortenHomePath(filePath: string): string {
  const homeDir = os.homedir();
  return filePath.startsWith(homeDir)
    ? `~${filePath.slice(homeDir.length)}`
    : filePath;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatMode(mode: number | null): string {
  if (mode == null) return 'unknown';
  return `0${(mode & 0o777).toString(8)}`;
}

function readUnixMode(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mode;
  } catch {
    return null;
  }
}

function isGroupOrWorldWritable(mode: number | null): boolean {
  return mode != null && (mode & 0o022) !== 0;
}

function isGroupOrWorldReadable(mode: number | null): boolean {
  return mode != null && (mode & 0o044) !== 0;
}

function findExistingPath(filePath: string): string {
  let current = path.resolve(filePath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return filePath;
    current = parent;
  }
  return current;
}

function readDiskFreeBytes(targetPath: string): number {
  const stat = fs.statfsSync(findExistingPath(targetPath));
  return Number(stat.bavail) * Number(stat.bsize);
}

function readDirSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  const stat = fs.statSync(dirPath);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    total += readDirSize(path.join(dirPath, entry.name));
  }
  return total;
}

function runVersionCommand(command: string): string | null {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf-8',
  });
  if (result.error || result.status !== 0) return null;
  const value = `${result.stdout || ''}`.trim();
  return value || null;
}

function severityFrom(
  values: DiagResult['severity'][],
): DiagResult['severity'] {
  let current: DiagResult['severity'] = 'ok';
  for (const value of values) {
    if (SEVERITY_ORDER[value] > SEVERITY_ORDER[current]) current = value;
  }
  return current;
}

function makeResult(
  category: DoctorCategory,
  label: string,
  severity: DiagResult['severity'],
  message: string,
  fix?: () => Promise<void>,
): DiagResult {
  return {
    category,
    label,
    severity,
    message,
    ...(fix ? { fix } : {}),
  };
}

function summarizeCounts(results: DiagResult[]): DoctorReport['summary'] {
  const summary = {
    ok: 0,
    warn: 0,
    error: 0,
    exitCode: 0,
  };
  for (const result of results) {
    summary[result.severity] += 1;
  }
  summary.exitCode = summary.error > 0 ? 1 : 0;
  return summary;
}

function normalizeComponent(
  raw: string | null | undefined,
): DoctorCategory | null {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (!value) return null;

  const aliasMap: Record<string, DoctorCategory> = {
    runtime: 'runtime',
    gateway: 'gateway',
    config: 'config',
    configuration: 'config',
    credentials: 'credentials',
    creds: 'credentials',
    secrets: 'credentials',
    db: 'database',
    database: 'database',
    provider: 'providers',
    providers: 'providers',
    local: 'local-backends',
    backend: 'local-backends',
    backends: 'local-backends',
    'local-backends': 'local-backends',
    localbackends: 'local-backends',
    docker: 'docker',
    container: 'docker',
    channels: 'channels',
    channel: 'channels',
    security: 'security',
    disk: 'disk',
    storage: 'disk',
  };
  return aliasMap[value] || null;
}

function parseDoctorArgs(args: string[]): DoctorArgs {
  let component: DoctorCategory | null = null;
  let fix = false;
  let json = false;

  for (const rawArg of args) {
    const arg = String(rawArg || '').trim();
    if (!arg) continue;
    if (arg === '--fix') {
      fix = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown doctor option: ${arg}`);
    }
    const normalized = normalizeComponent(arg);
    if (!normalized) {
      throw new Error(
        `Unknown doctor component: ${arg}. Expected one of ${DOCTOR_CATEGORIES.join(', ')}.`,
      );
    }
    if (component) {
      throw new Error('Doctor accepts at most one component filter.');
    }
    component = normalized;
  }

  return { component, fix, json };
}

async function checkRuntime(): Promise<DiagResult[]> {
  const nodeMajor = Number.parseInt(
    process.versions.node.split('.')[0] || '0',
    10,
  );
  const npmVersion = runVersionCommand('npm');
  const pnpmVersion = runVersionCommand('pnpm');
  const severity =
    nodeMajor < 22 ? 'error' : npmVersion || pnpmVersion ? 'ok' : 'warn';
  const messageParts = [`Node.js v${process.versions.node}`];
  messageParts.push(npmVersion ? `npm ${npmVersion}` : 'npm missing');
  messageParts.push(pnpmVersion ? `pnpm ${pnpmVersion}` : 'pnpm missing');
  return [makeResult('runtime', 'Runtime', severity, messageParts.join(', '))];
}

async function checkGateway(): Promise<DiagResult[]> {
  const pidState = readGatewayPid();
  const pidRunning = Boolean(pidState && isPidRunning(pidState.pid));
  let health: GatewayStatus | null = null;
  let apiError = '';

  try {
    health = await gatewayHealth();
  } catch (error) {
    apiError = error instanceof Error ? error.message : String(error);
  }

  if (health && pidRunning) {
    return [
      makeResult(
        'gateway',
        'Gateway',
        'ok',
        `PID ${pidState?.pid}, uptime ${formatDuration(health.uptime)}, ${health.sessions} session${health.sessions === 1 ? '' : 's'}`,
      ),
    ];
  }

  if (health && !pidRunning) {
    const fix = pidState ? async () => removeGatewayPidFile() : undefined;
    return [
      makeResult(
        'gateway',
        'Gateway',
        'warn',
        pidState
          ? 'Gateway reachable, but the local PID file is stale'
          : 'Gateway reachable, but no managed PID file is present',
        fix,
      ),
    ];
  }

  if (pidState && !pidRunning) {
    return [
      makeResult(
        'gateway',
        'Gateway',
        'warn',
        `Stale PID file for pid ${pidState.pid}; gateway API is unreachable`,
        async () => removeGatewayPidFile(),
      ),
    ];
  }

  if (pidRunning) {
    return [
      makeResult(
        'gateway',
        'Gateway',
        'error',
        `PID ${pidState?.pid} is running, but the gateway API is unreachable${apiError ? ` (${apiError})` : ''}`,
      ),
    ];
  }

  return [
    makeResult(
      'gateway',
      'Gateway',
      'warn',
      `Gateway is not running${apiError ? ` (${apiError})` : ''}`,
    ),
  ];
}

async function checkConfig(): Promise<DiagResult[]> {
  const filePath = runtimeConfigPath();
  const displayPath = shortenHomePath(filePath);

  if (!fs.existsSync(filePath)) {
    return [
      makeResult(
        'config',
        'Config',
        'error',
        `${displayPath} is missing`,
        async () => {
          ensureRuntimeConfigFile();
        },
      ),
    ];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch (error) {
    return [
      makeResult(
        'config',
        'Config',
        'error',
        `${displayPath} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      ),
    ];
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [
      makeResult(
        'config',
        'Config',
        'error',
        `${displayPath} must contain a top-level object`,
      ),
    ];
  }

  const config = getRuntimeConfig();
  const mode = readUnixMode(filePath);
  const writableByOthers = isGroupOrWorldWritable(mode);
  const missingFields = [
    config.hybridai.defaultModel.trim() ? null : 'hybridai.defaultModel',
    config.ops.dbPath.trim() ? null : 'ops.dbPath',
    config.container.image.trim() ? null : 'container.image',
  ].filter(Boolean) as string[];

  if (missingFields.length > 0) {
    return [
      makeResult(
        'config',
        'Config',
        'error',
        `${displayPath} missing required field${missingFields.length === 1 ? '' : 's'}: ${missingFields.join(', ')}`,
      ),
    ];
  }

  const version =
    typeof (raw as { version?: unknown }).version === 'number'
      ? (raw as { version: number }).version
      : null;
  const severity = writableByOthers ? 'warn' : 'ok';
  const message =
    version === CONFIG_VERSION
      ? `${displayPath} valid (v${CONFIG_VERSION})${writableByOthers ? `, permissions ${formatMode(mode)}` : ''}`
      : `${displayPath} valid${version == null ? '' : ` (v${version})`}${writableByOthers ? `, permissions ${formatMode(mode)}` : ''}`;

  return [
    makeResult(
      'config',
      'Config',
      severity,
      message,
      writableByOthers
        ? async () => {
            fs.chmodSync(filePath, 0o644);
          }
        : undefined,
    ),
  ];
}

async function checkCredentials(): Promise<DiagResult[]> {
  const filePath = runtimeSecretsPath();
  const displayPath = shortenHomePath(filePath);

  if (!fs.existsSync(filePath)) {
    const sharedEnvSecrets = [
      process.env.HYBRIDAI_API_KEY,
      process.env.OPENROUTER_API_KEY,
      process.env.DISCORD_TOKEN,
      process.env.EMAIL_PASSWORD,
      process.env.MSTEAMS_APP_PASSWORD,
    ].filter((value) => String(value || '').trim()).length;
    return [
      makeResult(
        'credentials',
        'Credentials',
        sharedEnvSecrets > 0 ? 'ok' : 'warn',
        sharedEnvSecrets > 0
          ? `${displayPath} not present; using environment-backed secrets`
          : `${displayPath} not present`,
      ),
    ];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
      string,
      unknown
    >;
  } catch (error) {
    return [
      makeResult(
        'credentials',
        'Credentials',
        'error',
        `${displayPath} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      ),
    ];
  }

  const mode = readUnixMode(filePath);
  const insecurePermissions = isGroupOrWorldReadable(mode);
  const keys = Object.keys(parsed).filter(
    (key) => typeof parsed[key] === 'string' && String(parsed[key]).trim(),
  );
  const severity =
    keys.length === 0 ? 'warn' : insecurePermissions ? 'warn' : 'ok';
  const details = [
    `${displayPath} has ${keys.length} stored secret${keys.length === 1 ? '' : 's'}`,
  ];
  if (insecurePermissions) details.push(`permissions ${formatMode(mode)}`);

  return [
    makeResult(
      'credentials',
      'Credentials',
      severity,
      details.join(', '),
      insecurePermissions
        ? async () => {
            fs.chmodSync(filePath, 0o600);
          }
        : undefined,
    ),
  ];
}

async function checkDatabase(): Promise<DiagResult[]> {
  const dbPath = DB_PATH;
  const displayPath = shortenHomePath(dbPath);

  if (!fs.existsSync(dbPath)) {
    return [
      makeResult(
        'database',
        'Database',
        'error',
        `Database missing at ${displayPath}`,
        async () => {
          initDatabase({ quiet: true, dbPath });
        },
      ),
    ];
  }

  const stat = fs.statSync(dbPath);
  const writable = (() => {
    try {
      fs.accessSync(dbPath, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();

  let schemaVersion = 0;
  let journalMode = '';
  const database = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    schemaVersion = Number(
      database.pragma('user_version', { simple: true }) || 0,
    );
    journalMode = String(
      database.pragma('journal_mode', { simple: true }) || '',
    );
  } finally {
    database.close();
  }

  const issues: DiagResult['severity'][] = [];
  if (schemaVersion !== DATABASE_SCHEMA_VERSION) issues.push('error');
  if (!writable) issues.push('error');
  const severity = issues.length > 0 ? severityFrom(issues) : 'ok';
  const extras = [];
  if (journalMode) extras.push(journalMode.toUpperCase());
  if (isDatabaseInitialized()) extras.push('attached');
  return [
    makeResult(
      'database',
      'Database',
      severity,
      severity === 'ok'
        ? `Schema v${schemaVersion}, ${formatBytes(stat.size)}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`
        : `Schema v${schemaVersion} at ${displayPath}${schemaVersion !== DATABASE_SCHEMA_VERSION ? `; expected v${DATABASE_SCHEMA_VERSION}` : ''}${!writable ? ', file is not writable' : ''}`,
      severity !== 'ok'
        ? async () => {
            initDatabase({ quiet: true, dbPath });
          }
        : undefined,
    ),
  ];
}

function fallbackProviderHealth(): Partial<
  Record<'hybridai' | 'codex' | 'openrouter', GatewayProviderHealthEntry>
> {
  const config = getRuntimeConfig();
  const codex = getCodexAuthStatus();
  const hybridai = getHybridAIAuthStatus();
  return {
    hybridai: {
      kind: 'remote',
      reachable: hybridai.authenticated,
      ...(hybridai.authenticated ? {} : { error: 'API key missing' }),
      modelCount: [config.hybridai.defaultModel, ...config.hybridai.models]
        .map((model) => model.trim())
        .filter(Boolean).length,
      detail: hybridai.authenticated
        ? `API key ready${hybridai.source ? ` via ${hybridai.source}` : ''}`
        : 'API key missing',
    },
    codex: {
      kind: 'remote',
      reachable: codex.authenticated && !codex.reloginRequired,
      ...(codex.authenticated && !codex.reloginRequired
        ? {}
        : {
            error: codex.reloginRequired
              ? 'Login required'
              : 'Not authenticated',
          }),
      modelCount: config.codex.models
        .map((model) => model.trim())
        .filter(Boolean).length,
      detail:
        codex.authenticated && !codex.reloginRequired
          ? `Authenticated${codex.source ? ` via ${codex.source}` : ''}`
          : codex.reloginRequired
            ? 'Login required'
            : 'Not authenticated',
    },
    ...(config.openrouter.enabled
      ? {
          openrouter: {
            kind: 'remote' as const,
            reachable: Boolean(String(OPENROUTER_API_KEY || '').trim()),
            ...(String(OPENROUTER_API_KEY || '').trim()
              ? {}
              : { error: 'API key missing' }),
            modelCount: config.openrouter.models
              .map((model) => model.trim())
              .filter(Boolean).length,
            detail: String(OPENROUTER_API_KEY || '').trim()
              ? 'API key ready'
              : 'API key missing',
          },
        }
      : {}),
  };
}

async function checkProviders(): Promise<DiagResult[]> {
  const config = getRuntimeConfig();
  const defaultProvider = resolveModelProvider(config.hybridai.defaultModel);
  let health = fallbackProviderHealth();
  try {
    const gateway = await gatewayHealth();
    if (gateway.providerHealth) {
      health = {
        ...health,
        ...gateway.providerHealth,
        ...(config.openrouter.enabled &&
        !('openrouter' in gateway.providerHealth)
          ? fallbackProviderHealth()
          : {}),
      };
    }
  } catch {
    // Fall back to local auth/config inspection when the gateway is down.
  }

  const segments: string[] = [];
  const severities: DiagResult['severity'][] = [];
  const pushProvider = (
    key: 'hybridai' | 'codex' | 'openrouter',
    label: string,
    active: boolean,
  ): void => {
    const entry = health[key];
    if (!entry && !active) return;
    if (!entry) {
      segments.push(`${label} unavailable`);
      severities.push(active ? 'error' : 'warn');
      return;
    }
    if (entry.reachable) {
      segments.push(
        `${label} ✓${typeof entry.modelCount === 'number' ? ` (${entry.modelCount} models)` : ''}`,
      );
      return;
    }
    segments.push(`${label} ${entry.error || entry.detail || 'unavailable'}`);
    severities.push(active ? 'error' : 'warn');
  };

  pushProvider('hybridai', 'HybridAI', defaultProvider === 'hybridai');
  pushProvider('codex', 'Codex', defaultProvider === 'openai-codex');
  if (config.openrouter.enabled || defaultProvider === 'openrouter') {
    pushProvider('openrouter', 'OpenRouter', defaultProvider === 'openrouter');
  }

  return [
    makeResult(
      'providers',
      'Providers',
      severityFrom(severities),
      segments.join('  ') || 'No remote providers configured',
    ),
  ];
}

async function checkLocalBackendsCategory(): Promise<DiagResult[]> {
  const config = getRuntimeConfig();
  const enabledBackends = Object.entries(config.local.backends)
    .filter(([, backend]) => backend.enabled)
    .map(([name]) => name as 'ollama' | 'lmstudio' | 'vllm');

  if (enabledBackends.length === 0) {
    return [
      makeResult(
        'local-backends',
        'Local backends',
        'ok',
        'No local backends enabled',
      ),
    ];
  }

  const defaultProvider = resolveModelProvider(config.hybridai.defaultModel);
  const health = await checkAllBackends();
  const segments: string[] = [];
  const severities: DiagResult['severity'][] = [];

  for (const backend of enabledBackends) {
    const status = health.get(backend);
    if (!status) {
      segments.push(`${backend} health unavailable`);
      severities.push(defaultProvider === backend ? 'error' : 'warn');
      continue;
    }
    if (status.reachable) {
      segments.push(
        `${backend === 'lmstudio' ? 'LM Studio' : backend === 'vllm' ? 'vLLM' : 'Ollama'} ✓${typeof status.modelCount === 'number' ? ` (${status.modelCount} models, ${status.latencyMs}ms)` : ` (${status.latencyMs}ms)`}`,
      );
      continue;
    }
    segments.push(
      `${backend === 'lmstudio' ? 'LM Studio' : backend === 'vllm' ? 'vLLM' : 'Ollama'} ${status.error || 'unreachable'}`,
    );
    severities.push(defaultProvider === backend ? 'error' : 'warn');
  }

  return [
    makeResult(
      'local-backends',
      'Local backends',
      severityFrom(severities),
      segments.join('  '),
    ),
  ];
}

async function checkDocker(): Promise<DiagResult[]> {
  const config = getRuntimeConfig();
  const dockerInfo = spawnSync('docker', ['info'], {
    encoding: 'utf-8',
  });
  const daemonReady = !dockerInfo.error && dockerInfo.status === 0;
  const imagePresent = daemonReady
    ? await containerImageExists(CONTAINER_IMAGE)
    : false;
  const freeBytes = readDiskFreeBytes(resolveInstallRoot());
  const activeSandbox = config.container.sandboxMode === 'container';

  if (!daemonReady) {
    return [
      makeResult(
        'docker',
        'Docker',
        activeSandbox ? 'error' : 'warn',
        dockerInfo.error
          ? `Docker unavailable (${dockerInfo.error.message})`
          : `Docker daemon not ready${dockerInfo.stderr ? ` (${dockerInfo.stderr.trim()})` : ''}`,
      ),
    ];
  }

  if (!imagePresent) {
    return [
      makeResult(
        'docker',
        'Docker',
        'warn',
        `Image ${CONTAINER_IMAGE} not found locally; run: npm run build:container`,
        async () => {
          await ensureContainerImageReady({
            commandName: 'hybridclaw doctor --fix',
            required: false,
            cwd: resolveInstallRoot(),
          });
        },
      ),
    ];
  }

  return [
    makeResult(
      'docker',
      'Docker',
      freeBytes < 100 * 1024 * 1024 ? 'error' : 'ok',
      `Daemon running, image ${CONTAINER_IMAGE} present, ${formatBytes(freeBytes)} free`,
    ),
  ];
}

async function checkChannels(): Promise<DiagResult[]> {
  const config = getConfigSnapshot();
  const segments: string[] = [];
  const severities: DiagResult['severity'][] = [];

  if (String(DISCORD_TOKEN || '').trim()) {
    segments.push('Discord configured');
  } else if (Object.keys(config.discord.guilds).length > 0) {
    segments.push('Discord token missing');
    severities.push('error');
  }

  if (config.msteams.enabled) {
    if (
      String(MSTEAMS_APP_ID || '').trim() &&
      String(MSTEAMS_APP_PASSWORD || '').trim()
    ) {
      segments.push('Teams configured');
    } else {
      segments.push('Teams credentials incomplete');
      severities.push('error');
    }
  }

  if (config.email.enabled) {
    if (
      config.email.address.trim() &&
      config.email.imapHost.trim() &&
      config.email.smtpHost.trim() &&
      String(EMAIL_PASSWORD || '').trim()
    ) {
      segments.push('Email polling ready');
    } else {
      segments.push('Email configuration incomplete');
      severities.push('error');
    }
  }

  const whatsapp = await getWhatsAppAuthStatus();
  const whatsappExpected =
    config.whatsapp.dmPolicy !== 'disabled' ||
    config.whatsapp.groupPolicy !== 'disabled';
  if (whatsapp.linked) {
    segments.push('WhatsApp linked');
  } else if (whatsappExpected) {
    segments.push('WhatsApp not linked');
    severities.push(config.whatsapp.dmPolicy === 'pairing' ? 'warn' : 'error');
  }

  return [
    makeResult(
      'channels',
      'Channels',
      severityFrom(severities),
      segments.join(', ') || 'No external channels configured',
    ),
  ];
}

function checkWritablePath(targetPath: string): boolean {
  const existing = findExistingPath(targetPath);
  try {
    fs.accessSync(existing, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function checkSecurity(): Promise<DiagResult[]> {
  const config = getRuntimeConfig();
  const trustAccepted = isSecurityTrustAccepted(config);
  const instructionIntegrity = verifyInstructionIntegrity();
  const auditDir = path.join(DATA_DIR, 'audit');
  const auditWritable = checkWritablePath(auditDir);
  const severity = severityFrom([
    ...(trustAccepted ? [] : ['error' as const]),
    ...(instructionIntegrity.ok ? [] : ['error' as const]),
    ...(auditWritable ? [] : ['error' as const]),
  ]);
  const messageParts = [];
  messageParts.push(
    trustAccepted ? 'Trust model accepted' : 'Trust model not accepted',
  );
  messageParts.push(
    instructionIntegrity.ok
      ? 'instruction integrity OK'
      : summarizeInstructionIntegrity(instructionIntegrity),
  );
  messageParts.push(
    auditWritable ? 'audit trail writable' : 'audit trail not writable',
  );

  return [
    makeResult(
      'security',
      'Security',
      severity,
      messageParts.join(', '),
      !instructionIntegrity.ok
        ? async () => {
            syncRuntimeInstructionCopies();
          }
        : undefined,
    ),
  ];
}

async function checkDisk(): Promise<DiagResult[]> {
  const freeBytes = readDiskFreeBytes(DATA_DIR);
  const dbSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  const auditSize = readDirSize(path.join(DATA_DIR, 'audit'));
  return [
    makeResult(
      'disk',
      'Disk',
      freeBytes >= 100 * 1024 * 1024 ? 'ok' : 'error',
      `${formatBytes(freeBytes)} free, DB ${formatBytes(dbSize)}, audit ${formatBytes(auditSize)}`,
    ),
  ];
}

function doctorChecks(): DoctorCheck[] {
  return [
    {
      category: 'runtime',
      label: 'Runtime',
      run: checkRuntime,
    },
    {
      category: 'gateway',
      label: 'Gateway',
      run: checkGateway,
    },
    {
      category: 'config',
      label: 'Config',
      run: checkConfig,
    },
    {
      category: 'credentials',
      label: 'Credentials',
      run: checkCredentials,
    },
    {
      category: 'database',
      label: 'Database',
      run: checkDatabase,
    },
    {
      category: 'providers',
      label: 'Providers',
      run: checkProviders,
    },
    {
      category: 'local-backends',
      label: 'Local backends',
      run: checkLocalBackendsCategory,
    },
    {
      category: 'docker',
      label: 'Docker',
      run: checkDocker,
    },
    {
      category: 'channels',
      label: 'Channels',
      run: checkChannels,
    },
    {
      category: 'security',
      label: 'Security',
      run: checkSecurity,
    },
    {
      category: 'disk',
      label: 'Disk',
      run: checkDisk,
    },
  ];
}

async function runChecks(checks: DoctorCheck[]): Promise<DiagResult[]> {
  const settled = await Promise.allSettled(checks.map((check) => check.run()));
  const results: DiagResult[] = [];

  settled.forEach((result, index) => {
    const check = checks[index];
    if (result.status === 'fulfilled') {
      results.push(...result.value);
      return;
    }
    const message =
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
    results.push(
      makeResult(
        check.category,
        check.label,
        'error',
        `Diagnostic failed: ${message}`,
      ),
    );
  });

  return results;
}

async function applyFixes(results: DiagResult[]): Promise<DoctorFixOutcome[]> {
  const fixes: DoctorFixOutcome[] = [];
  for (const result of results) {
    if (!result.fix || result.severity === 'ok') continue;
    try {
      await result.fix();
      fixes.push({
        category: result.category,
        label: result.label,
        status: 'applied',
        message: `Applied fix for ${result.label.toLowerCase()}`,
      });
    } catch (error) {
      fixes.push({
        category: result.category,
        label: result.label,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return fixes;
}

export async function runDoctor(args: DoctorArgs): Promise<DoctorReport> {
  const checks = doctorChecks().filter((check) =>
    args.component ? check.category === args.component : true,
  );
  let results = await runChecks(checks);
  const fixes = args.fix ? await applyFixes(results) : [];
  if (args.fix && fixes.some((fix) => fix.status === 'applied')) {
    results = await runChecks(checks);
  }

  return {
    generatedAt: new Date().toISOString(),
    component: args.component,
    results: results.map((result) => ({
      ...result,
      fixable: Boolean(result.fix),
      fix: undefined,
    })) as Array<DiagResult & { fixable: boolean }>,
    summary: summarizeCounts(results),
    fixes,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = ['HybridClaw Doctor', ''];
  const labelWidth = report.results.reduce(
    (max, result) => Math.max(max, result.label.length),
    0,
  );

  for (const result of report.results) {
    const symbol =
      result.severity === 'ok' ? '✓' : result.severity === 'warn' ? '⚠' : '✖';
    lines.push(
      `${symbol} ${result.label.padEnd(labelWidth)}  ${result.message}`,
    );
  }

  if (report.fixes.length > 0) {
    lines.push('');
    for (const fix of report.fixes) {
      const symbol = fix.status === 'applied' ? '✓' : '✖';
      lines.push(
        `${symbol} Fix ${fix.label.padEnd(labelWidth)}  ${fix.message}`,
      );
    }
  }

  lines.push('');
  lines.push(
    `${report.summary.ok} ok · ${report.summary.warn} warning${report.summary.warn === 1 ? '' : 's'} · ${report.summary.error} error${report.summary.error === 1 ? '' : 's'}`,
  );
  return lines.join('\n');
}

export async function runDoctorCli(argv: string[]): Promise<number> {
  const args = parseDoctorArgs(argv);
  const report = await runDoctor(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderDoctorReport(report));
  }
  return report.summary.exitCode;
}
