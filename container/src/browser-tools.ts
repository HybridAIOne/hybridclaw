import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseOptionalBoolean } from '../shared/boolean-utils.js';
import { assertBrowserNavigationUrl } from '../shared/browser-navigation.js';
import { BROWSER_PROFILE_CHROMIUM_ARGS } from '../shared/browser-profile.js';
import { callAuxiliaryModel } from './providers/auxiliary.js';
import {
  DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
  resolveMediaPath,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
  WORKSPACE_ROOT,
  WORKSPACE_ROOT_DISPLAY,
} from './runtime-paths.js';
import {
  TASK_MODEL_KEYS,
  type TaskModelPolicies,
  type ToolDefinition,
} from './types.js';

const execFileAsync = promisify(execFile);

const BROWSER_SOCKET_ROOT = '/tmp/hybridclaw-browser';
const BROWSER_ARTIFACT_ROOT = path.join(WORKSPACE_ROOT, '.browser-artifacts');
const BROWSER_DOWNLOAD_ROOT = path.join(BROWSER_ARTIFACT_ROOT, 'downloads');
const BROWSER_DEFAULT_TIMEOUT_MS = 45_000;
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const BROWSER_MAX_SNAPSHOT_CHARS = 12_000;
const BROWSER_RUNTIME_ROOT = path.join(WORKSPACE_ROOT, '.hybridclaw-runtime');
const BROWSER_TMP_HOME = path.join(BROWSER_RUNTIME_ROOT, 'home');
const BROWSER_NPM_CACHE = path.join(BROWSER_RUNTIME_ROOT, 'npm-cache');
const BROWSER_XDG_CACHE = path.join(BROWSER_RUNTIME_ROOT, 'cache');
const BROWSER_PLAYWRIGHT_CACHE = path.join(
  BROWSER_RUNTIME_ROOT,
  'ms-playwright',
);
const BROWSER_PROFILE_ROOT = path.join(
  BROWSER_RUNTIME_ROOT,
  'browser-profiles',
);
const ENV_FALSEY = new Set(['0', 'false', 'no', 'off']);
const SNAPSHOT_CURSOR_FLAGS = ['-C'] as const;
const BOT_DETECTION_PATTERNS = [
  'access denied',
  'blocked',
  'bot detected',
  'captcha',
  'cloudflare',
  'checking your browser',
  'just a moment',
  'verification required',
];

const EXTRACT_IMAGES_SCRIPT = `(() => {
  const images = Array.from(document.images || []);
  return images
    .map((img) => ({
      src: String(img.currentSrc || img.src || ''),
      alt: String(img.alt || ''),
      width: Number(img.naturalWidth || img.width || 0),
      height: Number(img.naturalHeight || img.height || 0),
    }))
    .filter((img) => img.src && !img.src.startsWith('data:'));
})()`;

const EXTRACT_IFRAMES_SCRIPT = `(() => {
  const frames = Array.from(document.querySelectorAll('iframe, frame'));
  return frames.map((frame, index) => ({
    index,
    id: frame.id || null,
    name: frame.getAttribute('name') || null,
    title: frame.getAttribute('title') || null,
    src: frame.getAttribute('src') || '',
  }));
})()`;

const EXTRACT_TEXT_PREVIEW_SCRIPT = `(() => {
  const bodyText = document.body ? String(document.body.innerText || '') : '';
  const normalized = bodyText
    .replace(/\\r/g, '')
    .replace(/[ \\t]+\\n/g, '\\n')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
  const previewLimit = 6000;
  return {
    text_length: normalized.length,
    preview: normalized.slice(0, previewLimit),
    preview_truncated: normalized.length > previewLimit,
    has_noscript: Boolean(document.querySelector('noscript')),
    root_shell: Boolean(document.querySelector('div#root:empty, div#app:empty, div#__next:empty')),
    ready_state: String(document.readyState || ''),
  };
})()`;

const NETWORK_TIMINGS_SCRIPT = `(() => {
  const entries = performance.getEntriesByType('resource');
  return entries
    .map((entry) => ({
      url: String(entry.name || ''),
      type: String(entry.initiatorType || 'other'),
      duration: Math.round(Number(entry.duration || 0) * 100) / 100,
      transfer_size: typeof entry.transferSize === 'number' ? entry.transferSize : null,
      start_time: Math.round(Number(entry.startTime || 0) * 100) / 100,
    }))
    .filter((entry) => entry.url);
})()`;

const CLEAR_NETWORK_TIMINGS_SCRIPT = `(() => {
  performance.clearResourceTimings();
  return true;
})()`;

const FIND_FILE_INPUT_SELECTORS_SCRIPT = `(() => {
  const selectors = [];
  const seen = new Set();
  const esc = (value) => {
    const text = String(value || '');
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
      return CSS.escape(text);
    }
    return text.replace(/["\\\\]/g, '\\\\$&');
  };
  const push = (selector) => {
    const normalized = String(selector || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    selectors.push(normalized);
  };
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  for (const input of inputs) {
    const id = input.getAttribute('id');
    if (id) push(\`#\${esc(id)}\`);

    const name = input.getAttribute('name');
    if (name) push(\`input[type="file"][name="\${esc(name)}"]\`);

    const accept = input.getAttribute('accept');
    if (accept) push(\`input[type="file"][accept="\${esc(accept)}"]\`);

    const form = input.closest('form');
    const formId = form ? form.getAttribute('id') : null;
    if (formId) {
      if (name) {
        push(\`#\${esc(formId)} input[type="file"][name="\${esc(name)}"]\`);
      }
      push(\`#\${esc(formId)} input[type="file"]\`);
    }
  }
  push('input[type="file"]');
  return selectors.slice(0, 10);
})()`;

const TWO_FACTOR_SELECTOR_HINTS_SCRIPT = `(() => {
  const selectors = [
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
  ];
  return selectors.filter((selector) => document.querySelector(selector));
})()`;

type SnapshotMode = 'default' | 'interactive' | 'full';
type FrameTarget = {
  raw: string;
  isMain: boolean;
};
type UploadTarget = {
  raw: string;
  source: 'ref' | 'selector';
};
type ClickTarget = {
  raw: string;
  source: 'ref' | 'selector' | 'text' | 'coordinate';
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
};
type BrowserModelContext = {
  provider:
    | 'hybridai'
    | 'openai-codex'
    | 'anthropic'
    | 'openrouter'
    | 'mistral'
    | 'huggingface'
    | 'ollama'
    | 'lmstudio'
    | 'llamacpp'
    | 'vllm';
  providerMethod?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
  requestHeaders: Record<string, string>;
  maxTokens?: number;
  debugModelResponses?: boolean;
};

type BrowserRunner = {
  cmd: string;
  prefixArgs: string[];
};

type BrowserSession = {
  sessionKey: string;
  socketDir: string;
  profileDir?: string;
  stateName?: string;
  headed: boolean;
  createdAt: number;
  lastUsedAt: number;
};

type BrowserVisionContext = BrowserModelContext & {
  isLocal?: boolean;
  contextWindow?: number;
  thinkingFormat?: 'qwen';
};

const activeSessions = new Map<string, BrowserSession>();
let cachedRunner: BrowserRunner | null | undefined;
let currentBrowserModelContext: BrowserModelContext = {
  provider: 'hybridai',
  baseUrl: '',
  apiKey: '',
  model: '',
  chatbotId: '',
  requestHeaders: {},
};
let currentBrowserTaskModels: TaskModelPolicies | undefined;
let gatewayBaseUrl = '';
let gatewayApiToken = '';
const suspendedSessionByBrowserSession = new Map<string, string>();

export function setBrowserGatewayContext(
  baseUrl?: string,
  apiToken?: string,
): void {
  gatewayBaseUrl = String(baseUrl || '').trim();
  gatewayApiToken = String(apiToken || '').trim();
}

function cloneTaskModelPolicies(
  taskModels?: TaskModelPolicies,
): TaskModelPolicies | undefined {
  const cloned: TaskModelPolicies = {};
  for (const key of TASK_MODEL_KEYS) {
    const taskModel = taskModels?.[key];
    if (!taskModel) continue;
    cloned[key] = {
      ...taskModel,
      requestHeaders: taskModel.requestHeaders
        ? { ...taskModel.requestHeaders }
        : undefined,
    };
  }
  return Object.keys(cloned).length > 0 ? cloned : undefined;
}

export function setBrowserModelContext(
  provider:
    | 'hybridai'
    | 'openai-codex'
    | 'anthropic'
    | 'openrouter'
    | 'mistral'
    | 'huggingface'
    | 'ollama'
    | 'lmstudio'
    | 'llamacpp'
    | 'vllm'
    | undefined,
  providerMethod: string | undefined,
  baseUrl: string,
  apiKey: string,
  model: string,
  chatbotId: string,
  requestHeaders?: Record<string, string>,
  maxTokens?: number,
  debugModelResponses = false,
): void {
  currentBrowserModelContext = {
    provider: provider || 'hybridai',
    providerMethod,
    baseUrl: String(baseUrl || '')
      .trim()
      .replace(/\/+$/, ''),
    apiKey: String(apiKey || '').trim(),
    model: String(model || '').trim(),
    chatbotId: String(chatbotId || '').trim(),
    requestHeaders: { ...(requestHeaders || {}) },
    maxTokens:
      typeof maxTokens === 'number' &&
      Number.isFinite(maxTokens) &&
      maxTokens > 0
        ? Math.floor(maxTokens)
        : undefined,
    debugModelResponses,
  };
}

export function setBrowserTaskModelPolicies(
  taskModels?: TaskModelPolicies,
): void {
  currentBrowserTaskModels = cloneTaskModelPolicies(taskModels);
}

function normalizeSessionKey(sessionId: string): string {
  const normalized = String(sessionId || 'default')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 80);
  return normalized || 'default';
}

function envFlagEnabled(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return defaultValue;
  return !ENV_FALSEY.has(raw.trim().toLowerCase());
}

function deriveStableId(raw: string, maxLength = 40): string {
  const base =
    String(raw || 'default')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'default';
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 10);
  const headLength = Math.max(1, maxLength - hash.length - 1);
  return `${base.slice(0, headLength)}_${hash}`;
}

function shouldPersistProfiles(): boolean {
  return envFlagEnabled('BROWSER_PERSIST_PROFILE', true);
}

function shouldPersistSessionState(): boolean {
  return envFlagEnabled('BROWSER_PERSIST_SESSION_STATE', true);
}

function shouldLaunchHeaded(): boolean {
  return (
    envFlagEnabled('BROWSER_HEADFUL', false) ||
    envFlagEnabled('BROWSER_HEADED', false) ||
    envFlagEnabled('AGENT_BROWSER_HEADED', false)
  );
}

function resolveProfileRoot(): string {
  const configured = String(process.env.BROWSER_PROFILE_ROOT || '').trim();
  if (!configured) return ensureWritableDir(BROWSER_PROFILE_ROOT);
  const resolved = path.isAbsolute(configured)
    ? configured
    : path.resolve(WORKSPACE_ROOT, configured);
  return ensureWritableDir(resolved);
}

/**
 * Return the shared (pre-authenticated) profile directory when the gateway
 * has mounted one.  All sessions reuse this single profile so that manual
 * logins performed via `hybridclaw browser login` are available to the agent
 * without per-session isolation overhead.
 *
 * When `BROWSER_SHARED_PROFILE_DIR` is unset the function returns
 * `undefined` and the regular per-session profile logic applies.
 */
function resolveSharedProfileDir(): string | undefined {
  const dir = String(process.env.BROWSER_SHARED_PROFILE_DIR || '').trim();
  if (!dir) return undefined;
  const resolved = path.isAbsolute(dir)
    ? dir
    : path.resolve(WORKSPACE_ROOT, dir);
  try {
    return ensureWritableDir(resolved);
  } catch (err) {
    process.stderr.write(
      `[browser-tools] Warning: shared profile dir ${resolved} is not writable, falling back to per-session profile: ${err}\n`,
    );
    return undefined;
  }
}

function resolveCdpUrl(explicit?: string): string | undefined {
  const direct = String(explicit || '').trim();
  if (direct) return direct;
  const configured = String(process.env.BROWSER_CDP_URL || '').trim();
  return configured || undefined;
}

function resolveRunner(): BrowserRunner | null {
  if (cachedRunner !== undefined) {
    return cachedRunner;
  }

  const configured = String(process.env.AGENT_BROWSER_BIN || '').trim();
  if (configured) {
    cachedRunner = { cmd: configured, prefixArgs: [] };
    return cachedRunner;
  }

  const localBin = '/app/node_modules/.bin/agent-browser';
  if (fs.existsSync(localBin)) {
    cachedRunner = { cmd: localBin, prefixArgs: [] };
    return cachedRunner;
  }

  const whichAgentBrowser = spawnSync('which', ['agent-browser'], {
    encoding: 'utf-8',
  });
  if (whichAgentBrowser.status === 0 && whichAgentBrowser.stdout.trim()) {
    cachedRunner = { cmd: whichAgentBrowser.stdout.trim(), prefixArgs: [] };
    return cachedRunner;
  }

  const whichNpx = spawnSync('which', ['npx'], { encoding: 'utf-8' });
  if (whichNpx.status === 0 && whichNpx.stdout.trim()) {
    cachedRunner = {
      cmd: whichNpx.stdout.trim(),
      prefixArgs: ['--yes', 'agent-browser'],
    };
    return cachedRunner;
  }

  cachedRunner = null;
  return cachedRunner;
}

function resolveHeadedBrowserExecutable(): string | undefined {
  const configured = String(
    process.env.AGENT_BROWSER_EXECUTABLE_PATH || '',
  ).trim();
  if (configured) return configured;

  const chromeBin = String(process.env.CHROME_BIN || '').trim();
  if (chromeBin) return chromeBin;

  if (process.platform === 'darwin') {
    const googleChrome =
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return fs.existsSync(googleChrome) ? googleChrome : undefined;
  }

  if (process.platform === 'linux') {
    for (const name of ['google-chrome', 'google-chrome-stable']) {
      const result = spawnSync('which', [name], { encoding: 'utf-8' });
      if (result.status === 0 && result.stdout.trim()) {
        return result.stdout.trim();
      }
    }
  }

  return undefined;
}

function resolveBrowserLaunchArgs(session: BrowserSession): string | undefined {
  const configured = String(process.env.AGENT_BROWSER_ARGS || '').trim();
  if (!session.headed) return configured || undefined;

  const configuredArgs = configured
    ? configured
        .split(/[,\n]/)
        .map((arg) => arg.trim())
        .filter(Boolean)
    : [];
  const merged = [...configuredArgs];
  const existing = new Set(merged);
  for (const arg of BROWSER_PROFILE_CHROMIUM_ARGS) {
    if (!existing.has(arg)) merged.push(arg);
  }
  return merged.length > 0 ? merged.join('\n') : undefined;
}

function getSession(
  sessionId: string,
  options: { headed?: boolean } = {},
): BrowserSession {
  const sessionKey = normalizeSessionKey(sessionId);
  const existing = activeSessions.get(sessionKey);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  fs.mkdirSync(BROWSER_SOCKET_ROOT, { recursive: true, mode: 0o700 });
  const runtimeKey = deriveStableId(sessionKey, 32);
  const socketDir = path.join(BROWSER_SOCKET_ROOT, runtimeKey);
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });

  let profileDir: string | undefined;
  // Prefer the shared pre-authenticated profile mounted by the gateway so
  // manual `hybridclaw browser login` sessions are visible to automation.
  const sharedDir = resolveSharedProfileDir();
  if (sharedDir) {
    profileDir = sharedDir;
  } else if (shouldPersistProfiles()) {
    try {
      profileDir = ensureWritableDir(
        path.join(resolveProfileRoot(), runtimeKey),
      );
    } catch {
      // Fallback to ephemeral browser context if profile dir cannot be created.
      profileDir = undefined;
    }
  }

  const stateName = shouldPersistSessionState()
    ? deriveStableId(sessionKey, 48)
    : undefined;

  const session: BrowserSession = {
    sessionKey,
    socketDir,
    profileDir,
    stateName,
    headed: options.headed ?? shouldLaunchHeaded(),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  activeSessions.set(sessionKey, session);
  return session;
}

async function prepareSessionMode(
  sessionId: string,
  options: { headed?: boolean } = {},
): Promise<void> {
  if (options.headed == null) return;
  const sessionKey = normalizeSessionKey(sessionId);
  const existing = activeSessions.get(sessionKey);
  if (!existing || existing.headed === options.headed) return;
  await closeSession(sessionKey);
}

function ensureWritableDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  return dirPath;
}

function resolveWritableHome(): string {
  const currentHome = String(process.env.HOME || '').trim();
  if (currentHome) {
    try {
      fs.mkdirSync(currentHome, { recursive: true });
      fs.accessSync(currentHome, fs.constants.W_OK);
      return currentHome;
    } catch {
      // Fall through to tmp home.
    }
  }
  return ensureWritableDir(BROWSER_TMP_HOME);
}

function resolvePlaywrightBrowsersPath(): string {
  const configured = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '').trim();
  if (configured) {
    return configured;
  }

  const homeDir = os.homedir();
  const candidates = [
    '/ms-playwright',
    homeDir ? path.join(homeDir, 'Library', 'Caches', 'ms-playwright') : '',
    homeDir ? path.join(homeDir, '.cache', 'ms-playwright') : '',
    homeDir ? path.join(homeDir, 'AppData', 'Local', 'ms-playwright') : '',
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (normalized && fs.existsSync(normalized)) {
      return normalized;
    }
  }
  return BROWSER_PLAYWRIGHT_CACHE;
}

function removeSessionResources(session: BrowserSession): void {
  activeSessions.delete(session.sessionKey);
  try {
    fs.rmSync(session.socketDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
}

function readSessionPid(session: BrowserSession): number | null {
  const pidPath = path.join(session.socketDir, 'default.pid');
  try {
    const raw = fs.readFileSync(pidPath, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessRunning(pid);
}

async function terminateProcess(pid: number | null): Promise<void> {
  if (!pid || !isProcessRunning(pid)) return;

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ESRCH')) {
      throw err;
    }
    return;
  }

  if (await waitForProcessExit(pid, 1_500)) return;

  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ESRCH')) {
      throw err;
    }
    return;
  }

  await waitForProcessExit(pid, 500);
}

async function terminateSessionProcess(session: BrowserSession): Promise<void> {
  await terminateProcess(readSessionPid(session));
}

async function closeSession(
  sessionId: string,
  options: { createIfMissing?: boolean } = {},
): Promise<string | null> {
  const sessionKey = normalizeSessionKey(sessionId);
  const session = options.createIfMissing
    ? getSession(sessionKey)
    : activeSessions.get(sessionKey);
  if (!session) return null;
  const pidBeforeClose = readSessionPid(session);

  const result = await runAgentBrowser(session.sessionKey, 'close', [], {
    timeoutMs: BROWSER_CLOSE_TIMEOUT_MS,
  });
  if (result.success) {
    let warning: string | null = null;
    try {
      await terminateProcess(pidBeforeClose);
    } catch (err) {
      warning =
        err instanceof Error && err.message
          ? `daemon termination failed: ${err.message}`
          : 'daemon termination failed';
    } finally {
      removeSessionResources(session);
    }
    return warning;
  }

  try {
    await terminateSessionProcess(session);
  } catch {
    // Best effort fallback. The warning below preserves the original error.
  } finally {
    removeSessionResources(session);
  }

  return result.error || 'session close returned non-success';
}

export async function cleanupAllBrowserSessions(): Promise<void> {
  const sessions = Array.from(activeSessions.values());
  for (const session of sessions) {
    await closeSession(session.sessionKey);
  }
}

function truncateSnapshot(text: string): { text: string; truncated: boolean } {
  if (text.length <= BROWSER_MAX_SNAPSHOT_CHARS) {
    return { text, truncated: false };
  }
  return {
    text:
      text.slice(0, BROWSER_MAX_SNAPSHOT_CHARS) +
      `\n\n[Snapshot truncated at ${BROWSER_MAX_SNAPSHOT_CHARS} chars]`,
    truncated: true,
  };
}

function ensureRef(raw: unknown): string {
  const ref = String(raw || '').trim();
  if (!ref) throw new Error('ref is required');
  return ref.startsWith('@') ? ref : `@${ref}`;
}

function resolveClickTarget(args: Record<string, unknown>): ClickTarget {
  const ref = String(args.ref || '').trim();
  const text = String(args.text || '').trim();
  const selector = String(args.selector || '').trim();
  const button = parseMouseButton(args.button);
  const coordinate = parseViewportCoordinates(args.x, args.y);

  if (ref) {
    const refCoordinate = parseViewportRef(ref);
    if (refCoordinate) {
      return {
        raw: ref.startsWith('@') ? ref : `@${ref}`,
        source: 'coordinate',
        x: refCoordinate.x,
        y: refCoordinate.y,
        button,
      };
    }
    return {
      raw: ref.startsWith('@') ? ref : `@${ref}`,
      source: 'ref',
    };
  }
  if (text) return { raw: text, source: 'text' };
  if (selector) return { raw: selector, source: 'selector' };
  if (coordinate) {
    return {
      raw: `${coordinate.x},${coordinate.y}`,
      source: 'coordinate',
      x: coordinate.x,
      y: coordinate.y,
      button,
    };
  }
  throw new Error('ref is required (or provide text, selector, or x/y)');
}

function parseMouseButton(raw: unknown): 'left' | 'right' | 'middle' {
  const button = String(raw || 'left')
    .trim()
    .toLowerCase();
  if (button === 'left' || button === 'right' || button === 'middle') {
    return button;
  }
  throw new Error('button must be one of "left", "right", or "middle"');
}

function parseViewportCoordinates(
  rawX: unknown,
  rawY: unknown,
): { x: number; y: number } | null {
  if (rawX == null && rawY == null) return null;
  const x = Number(rawX);
  const y = Number(rawY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('x and y must both be finite viewport coordinates');
  }
  if (x < 0 || y < 0) {
    throw new Error('x and y must be non-negative viewport coordinates');
  }
  return { x: Math.round(x), y: Math.round(y) };
}

function parseViewportRef(rawRef: string): { x: number; y: number } | null {
  const match = rawRef.match(/^@?viewport-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  return {
    x: Math.round(Number(match[1])),
    y: Math.round(Number(match[2])),
  };
}

function resolveUploadTarget(args: Record<string, unknown>): UploadTarget {
  const selector = String(args.selector || args.target || '').trim();
  if (selector) return { raw: selector, source: 'selector' };

  const ref = String(args.ref || '').trim();
  if (!ref) {
    throw new Error('ref is required (or provide selector)');
  }
  return {
    raw: ref.startsWith('@') ? ref : `@${ref}`,
    source: 'ref',
  };
}

function normalizeUploadPath(rawPath: string): string | null {
  return resolveWorkspacePath(rawPath) || resolveMediaPath(rawPath);
}

function resolveUploadPaths(args: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const addPath = (value: unknown): void => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) candidates.push(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (trimmed) candidates.push(trimmed);
      }
    }
  };

  addPath(args.path);
  addPath(args.file);
  addPath(args.files);
  addPath(args.paths);

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const normalized = normalizeUploadPath(raw);
    if (!normalized) {
      throw new Error(
        `invalid upload path "${raw}" (must stay within ${WORKSPACE_ROOT_DISPLAY} or ${DISCORD_MEDIA_CACHE_ROOT_DISPLAY})`,
      );
    }
    if (!fs.existsSync(normalized)) {
      throw new Error(`upload file not found: ${normalized}`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  if (deduped.length === 0) {
    throw new Error('path is required (or provide files/paths)');
  }
  return deduped;
}

function resolveOutputPath(rawPath: unknown, extension: 'png' | 'pdf'): string {
  fs.mkdirSync(BROWSER_ARTIFACT_ROOT, { recursive: true });

  const fallbackName = `browser-${Date.now()}.${extension}`;
  const requested = String(rawPath || '').trim();
  if (!requested) {
    return path.join(BROWSER_ARTIFACT_ROOT, fallbackName);
  }

  if (path.isAbsolute(requested)) {
    throw new Error(
      'Absolute output paths are not allowed. Use a relative path.',
    );
  }
  const normalized = requested.replace(/\\/g, '/');
  const clean = path.posix.normalize(normalized);
  if (clean === '..' || clean.startsWith('../')) {
    throw new Error('Output path escapes browser artifacts directory.');
  }

  const withExt = clean.endsWith(`.${extension}`)
    ? clean
    : `${clean}.${extension}`;
  const resolved = path.resolve(BROWSER_ARTIFACT_ROOT, withExt);
  const root = path.resolve(BROWSER_ARTIFACT_ROOT);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Output path escapes browser artifacts directory.');
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function resolveDownloadOutputPath(rawPath: unknown): string {
  fs.mkdirSync(BROWSER_DOWNLOAD_ROOT, { recursive: true });

  const fallbackName = `browser-download-${Date.now()}`;
  const requested = String(rawPath || '').trim() || fallbackName;
  if (path.isAbsolute(requested)) {
    throw new Error(
      'Absolute download paths are not allowed. Use a relative path.',
    );
  }
  const normalized = requested.replace(/\\/g, '/');
  const clean = path.posix.normalize(normalized);
  if (clean === '..' || clean.startsWith('../')) {
    throw new Error('Download path escapes browser downloads directory.');
  }

  const resolved = path.resolve(BROWSER_DOWNLOAD_ROOT, clean);
  const root = path.resolve(BROWSER_DOWNLOAD_ROOT);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Download path escapes browser downloads directory.');
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function createTempScreenshotPath(prefix: string): string {
  fs.mkdirSync(BROWSER_ARTIFACT_ROOT, { recursive: true });
  const nonce = Math.random().toString(36).slice(2, 10);
  return path.join(
    BROWSER_ARTIFACT_ROOT,
    `${prefix}-${Date.now()}-${nonce}.png`,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveGatewayInteractiveEscalationUrl(): string | null {
  const base = gatewayBaseUrl.replace(/\/+$/, '');
  return base ? `${base}/api/interactive-escalations` : null;
}

function assertGatewayInteractiveEscalationConfigured(): void {
  if (!resolveGatewayInteractiveEscalationUrl()) {
    throw new Error(
      'gatewayBaseUrl is not configured; cannot park browser interaction.',
    );
  }
}

function safeUrlHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

async function callGatewayInteractiveEscalation(
  pathSuffix: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const baseUrl = resolveGatewayInteractiveEscalationUrl();
  if (!baseUrl) {
    throw new Error(
      'gatewayBaseUrl is not configured; cannot park browser interaction.',
    );
  }
  const url = `${baseUrl}${pathSuffix}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (gatewayApiToken) {
    headers.Authorization = `Bearer ${gatewayApiToken}`;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(text) as unknown);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message =
      typeof parsed?.error === 'string'
        ? parsed.error
        : text || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed || { raw: text };
}

async function createGatewayInteractiveEscalation(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return callGatewayInteractiveEscalation('', payload);
}

async function consumeGatewayInteractiveEscalation(
  sessionId: string,
): Promise<Record<string, unknown>> {
  return callGatewayInteractiveEscalation('/consume', { sessionId });
}

function normalizeSnapshotMode(rawMode: unknown): SnapshotMode {
  if (rawMode == null || String(rawMode).trim() === '') return 'default';
  const mode = String(rawMode).trim().toLowerCase();
  if (mode === 'default' || mode === 'interactive' || mode === 'full')
    return mode;
  throw new Error('mode must be one of "default", "interactive", or "full"');
}

function buildSnapshotCommandArgs(mode: SnapshotMode, full: boolean): string[] {
  if (mode === 'interactive') return ['-i', ...SNAPSHOT_CURSOR_FLAGS];
  if (mode === 'full' || full) return [...SNAPSHOT_CURSOR_FLAGS];
  return ['-i', '-c', ...SNAPSHOT_CURSOR_FLAGS];
}

function buildElementClickResultScript(extraFields = ''): string {
  return `
  const resolveClickableTarget = (start) => {
    let current = start;
    while (current) {
      const tag = String(current.tagName || '').toLowerCase();
      const role =
        typeof current.getAttribute === 'function'
          ? String(current.getAttribute('role') || '').toLowerCase()
          : '';
      const tabIndexValue =
        typeof current.tabIndex === 'number' && Number.isFinite(current.tabIndex)
          ? current.tabIndex
          : typeof current.getAttribute === 'function'
              ? Number.parseInt(String(current.getAttribute('tabindex') || ''), 10)
              : Number.NaN;
      const style =
        typeof window.getComputedStyle === 'function'
          ? window.getComputedStyle(current)
          : null;
      const cursor = style && typeof style.cursor === 'string'
        ? style.cursor.toLowerCase()
        : '';
      const isNativeInteractive =
        tag === 'a' ||
        tag === 'button' ||
        tag === 'input' ||
        tag === 'select' ||
        tag === 'textarea' ||
        tag === 'summary' ||
        tag === 'label';
      const isSemanticInteractive = role === 'button' || role === 'link';
      const isFocusable =
        Number.isFinite(tabIndexValue) && Number(tabIndexValue) >= 0;
      if (
        isNativeInteractive ||
        isSemanticInteractive ||
        cursor === 'pointer' ||
        isFocusable ||
        typeof current.onclick === 'function'
      ) {
        return current;
      }
      current = current.parentElement || null;
    }
    return start;
  };
  const clickTarget = resolveClickableTarget(element);
  if (typeof clickTarget.scrollIntoView === 'function') {
    clickTarget.scrollIntoView({ block: 'center', inline: 'center' });
  }
  if (typeof clickTarget.click === 'function') {
    clickTarget.click();
  } else {
    clickTarget.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      }),
    );
  }
  const preview =
    String(
      ('innerText' in clickTarget ? clickTarget.innerText : clickTarget.textContent) ||
        (typeof clickTarget.getAttribute === 'function'
          ? clickTarget.getAttribute('alt') ||
            clickTarget.getAttribute('title') ||
            clickTarget.getAttribute('aria-label')
          : '') ||
        '',
    )
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 200);
  return {
    ok: true,
    tag: String(clickTarget.tagName || '').toLowerCase(),${extraFields}
    text: preview,
  };`;
}

function buildSelectorClickScript(selector: string): string {
  return `(() => {
  const selector = ${JSON.stringify(selector)};
  let element;
  try {
    element = document.querySelector(selector);
  } catch (error) {
    return {
      ok: false,
      error: 'invalid selector: ' + String(error && error.message ? error.message : error),
    };
  }
  if (!element) {
    return {
      ok: false,
      error: 'no element matches selector "' + selector + '"',
    };
  }
${buildElementClickResultScript()}
})()`;
}

function buildTextClickScript(text: string, exact: boolean): string {
  return `(() => {
  const query = ${JSON.stringify(text)};
  const exact = ${JSON.stringify(exact)};
  const normalize = (value) =>
    String(value || '')
      .replace(/\\s+/g, ' ')
      .trim()
      .toLowerCase();
  const needle = normalize(query);
  if (!needle) {
    return { ok: false, error: 'text is required' };
  }
  const isVisible = (element) => {
    if (!element || typeof element.getBoundingClientRect !== 'function') {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (!style || style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const findMatch = (matchMode) => {
    if (!document.body) return null;
    const kindPriority = {
      'aria-label': 0,
      text: 1,
      alt: 2,
      title: 3,
    };
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
    );
    let current = walker.currentNode;
    let bestMatch = null;
    while (current) {
      const element = current;
      const tag = String(element.tagName || '').toLowerCase();
      if (
        tag !== 'script' &&
        tag !== 'style' &&
        tag !== 'noscript' &&
        isVisible(element)
      ) {
        const candidateValues = [
          { kind: 'aria-label', value: element.getAttribute('aria-label') || '' },
          {
            kind: 'text',
            value:
              ('innerText' in element ? element.innerText : element.textContent) ||
              '',
          },
          { kind: 'alt', value: element.getAttribute('alt') || '' },
          { kind: 'title', value: element.getAttribute('title') || '' },
        ];
        for (const entry of candidateValues) {
          const normalized = normalize(entry.value);
          if (!normalized) continue;
          const matches =
            matchMode === 'exact'
              ? normalized === needle
              : normalized.includes(needle);
          if (!matches) continue;
          const rect = element.getBoundingClientRect();
          const area = Math.round(rect.width * rect.height);
          const candidate = {
            element,
            matchedKind: entry.kind,
            textLength: normalized.length,
            area,
            kindRank:
              kindPriority[entry.kind] !== undefined
                ? kindPriority[entry.kind]
                : Number.MAX_SAFE_INTEGER,
          };
          if (
            !bestMatch ||
            candidate.textLength < bestMatch.textLength ||
            (candidate.textLength === bestMatch.textLength &&
              candidate.area < bestMatch.area) ||
            (candidate.textLength === bestMatch.textLength &&
              candidate.area === bestMatch.area &&
              candidate.kindRank < bestMatch.kindRank)
          ) {
            bestMatch = candidate;
          }
        }
      }
      current = walker.nextNode();
    }
    return bestMatch;
  };
  const match = findMatch('exact') || (!exact ? findMatch('substring') : null);
  if (!match) {
    return {
      ok: false,
      error: 'no visible element matches text "' + query + '"',
    };
  }
  const element = match.element;
${buildElementClickResultScript('\n    matched_kind: match.matchedKind,')}
})()`;
}

function parseOptionalFrame(raw: unknown): FrameTarget | null {
  if (raw == null) return null;
  const frame = String(raw).trim();
  if (!frame) throw new Error('frame must be a non-empty string when provided');
  return {
    raw: frame,
    isMain: frame.toLowerCase() === 'main',
  };
}

async function applyFrameTarget(
  sessionId: string,
  target: FrameTarget | null,
): Promise<void> {
  if (!target) return;
  const commandArgs = target.isMain ? ['main'] : [target.raw];
  const frameResult = await runAgentBrowser(sessionId, 'frame', commandArgs);
  if (!frameResult.success) {
    throw new Error(
      frameResult.error || `failed to switch to frame "${target.raw}"`,
    );
  }
}

async function runBrowserEval(
  sessionId: string,
  script: string,
  timeoutMs = 30_000,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const response = await runAgentBrowser(sessionId, 'eval', [script], {
    timeoutMs,
  });
  if (!response.success) {
    return { success: false, error: response.error || 'browser eval failed' };
  }
  const data = asRecord(response.data);
  return { success: true, result: data ? data.result : undefined };
}

async function collectClickDownloadResult(
  downloadPromise: Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
  }> | null,
  downloadPath: string,
): Promise<
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; error: string }
> {
  if (!downloadPromise) return { ok: true, fields: {} };
  const download = await downloadPromise;
  if (!download.success) {
    return {
      ok: false,
      error: download.error || 'click completed but no download was captured',
    };
  }

  const downloadData = asRecord(download.data);
  const savedPath =
    typeof downloadData?.path === 'string' ? downloadData.path : downloadPath;
  const relativeDownloadPath = toWorkspaceRelativePath(savedPath);
  if (!relativeDownloadPath) {
    return { ok: false, error: 'failed to normalize download artifact path' };
  }
  const suggestedFilename =
    typeof downloadData?.filename === 'string'
      ? downloadData.filename
      : typeof downloadData?.suggestedFilename === 'string'
        ? downloadData.suggestedFilename
        : undefined;
  return {
    ok: true,
    fields: {
      download_path: relativeDownloadPath,
      ...(suggestedFilename ? { suggested_filename: suggestedFilename } : {}),
      ...(typeof downloadData?.url === 'string'
        ? { download_url: downloadData.url }
        : {}),
    },
  };
}

function normalizeFrameMetadata(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const frames: Record<string, unknown>[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    if (!entry) continue;
    const index =
      typeof entry.index === 'number' && Number.isFinite(entry.index)
        ? entry.index
        : null;
    const id = typeof entry.id === 'string' ? entry.id : null;
    const name = typeof entry.name === 'string' ? entry.name : null;
    const title = typeof entry.title === 'string' ? entry.title : null;
    const src = typeof entry.src === 'string' ? entry.src : '';
    if (!id && !name && !title && !src) continue;
    frames.push({ index, id, name, title, src });
  }
  return frames;
}

function normalizeImageList(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const images: Record<string, unknown>[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    if (!entry) continue;
    const src = typeof entry.src === 'string' ? entry.src : '';
    if (!src || src.startsWith('data:')) continue;
    const alt = typeof entry.alt === 'string' ? entry.alt : '';
    const width =
      typeof entry.width === 'number' && Number.isFinite(entry.width)
        ? entry.width
        : null;
    const height =
      typeof entry.height === 'number' && Number.isFinite(entry.height)
        ? entry.height
        : null;
    images.push({ src, alt, width, height });
  }
  return images;
}

function normalizeStringList(raw: unknown, max = 10): string[] {
  if (!Array.isArray(raw)) return [];
  const values: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
    if (values.length >= max) break;
  }
  return values;
}

function isUploadTypeMismatchError(message: string): boolean {
  const normalized = String(message || '').toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('setinputfiles') ||
    normalized.includes('not an htmlinputelement')
  );
}

function normalizeTrackedRequests(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const requests: Record<string, unknown>[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    if (!entry) continue;
    const url = typeof entry.url === 'string' ? entry.url : '';
    if (!url) continue;
    const method = typeof entry.method === 'string' ? entry.method : null;
    const type =
      typeof entry.resourceType === 'string' ? entry.resourceType : null;
    const timestamp =
      typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)
        ? entry.timestamp
        : null;
    requests.push({
      url,
      method,
      type,
      status: null,
      duration: null,
      timestamp,
      source: 'agent-browser',
    });
  }
  return requests;
}

function normalizePerformanceRequests(
  raw: unknown,
  filter?: string,
): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const loweredFilter = (filter || '').toLowerCase();
  const requests: Record<string, unknown>[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    if (!entry) continue;
    const url = typeof entry.url === 'string' ? entry.url : '';
    if (!url) continue;
    if (loweredFilter && !url.toLowerCase().includes(loweredFilter)) continue;
    const type = typeof entry.type === 'string' ? entry.type : null;
    const duration =
      typeof entry.duration === 'number' && Number.isFinite(entry.duration)
        ? entry.duration
        : null;
    const transferSize =
      typeof entry.transfer_size === 'number' &&
      Number.isFinite(entry.transfer_size)
        ? entry.transfer_size
        : null;
    const startTime =
      typeof entry.start_time === 'number' && Number.isFinite(entry.start_time)
        ? entry.start_time
        : null;
    requests.push({
      url,
      method: 'GET',
      type,
      status: null,
      duration,
      transfer_size: transferSize,
      start_time: startTime,
      source: 'performance',
    });
  }
  return requests;
}

function buildBotDetectionWarning(
  titleValue: unknown,
): Record<string, unknown> | null {
  const title = String(titleValue || '').trim();
  if (!title) return null;
  const lower = title.toLowerCase();
  const matched = BOT_DETECTION_PATTERNS.find((pattern) =>
    lower.includes(pattern),
  );
  if (!matched) return null;
  const hintOverride = String(process.env.BROWSER_STEALTH_HINT || '').trim();
  const hint =
    hintOverride ||
    'Possible anti-bot page detected. Retry with a persisted profile, slower interaction pacing, and manual verification if prompted.';
  return {
    detected: true,
    title,
    matched_pattern: matched,
    hint,
  };
}

function buildReadExtractionHint(params: {
  contentLength: number;
  hasNoscript: boolean;
  rootShell: boolean;
}): string {
  const base =
    'For content extraction, call browser_snapshot with {"mode":"full"} next. For long or lazy-loaded pages, run browser_scroll then browser_snapshot again.';
  if (params.hasNoscript || params.rootShell || params.contentLength < 200) {
    return `${base} This page currently looks dynamic/app-shell-like; do not conclude "inaccessible" before snapshot attempts.`;
  }
  return `${base} Avoid browser_pdf for text extraction; PDF export is for artifact output.`;
}

async function callVisionModel(
  question: string,
  imageBase64: string,
): Promise<{ model: string; analysis: string }> {
  const fallbackContext: BrowserVisionContext = {
    ...currentBrowserModelContext,
  };
  const vision = await callAuxiliaryModel({
    task: 'vision',
    taskModels: currentBrowserTaskModels,
    fallbackContext,
    question,
    imageDataUrl: `data:image/png;base64,${imageBase64}`,
    toolName: 'browser_vision',
    missingContextSource: 'active request',
  });
  return {
    model: vision.model,
    analysis: vision.analysis,
  };
}

async function runAgentBrowser(
  sessionId: string,
  command: string,
  commandArgs: string[] = [],
  options: { timeoutMs?: number; cdpUrl?: string; headed?: boolean } = {},
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const runner = resolveRunner();
  if (!runner) {
    return {
      success: false,
      error:
        'agent-browser is not available in this container. Install it (global or /app/node_modules/.bin) ' +
        'or set AGENT_BROWSER_BIN.',
    };
  }

  const timeoutMs = Math.max(
    1_000,
    Math.min(options.timeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS, 180_000),
  );
  await prepareSessionMode(sessionId, { headed: options.headed });
  const session = getSession(sessionId, { headed: options.headed });
  const homeDir = resolveWritableHome();
  const npmCacheDir = ensureWritableDir(BROWSER_NPM_CACHE);
  const xdgCacheDir = ensureWritableDir(BROWSER_XDG_CACHE);
  const playwrightBrowsersPath = ensureWritableDir(
    resolvePlaywrightBrowsersPath(),
  );
  const downloadPath = ensureWritableDir(BROWSER_DOWNLOAD_ROOT);
  const args = [...runner.prefixArgs];
  const cdpUrl = resolveCdpUrl(options.cdpUrl);
  if (cdpUrl) {
    args.push('--cdp', cdpUrl);
  }
  args.push('--json', command, ...commandArgs);

  const browserEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_BROWSER_SOCKET_DIR: session.socketDir,
    AGENT_BROWSER_SESSION: 'default',
    HOME: homeDir,
    XDG_CACHE_HOME: xdgCacheDir,
    NPM_CONFIG_CACHE: npmCacheDir,
    npm_config_cache: npmCacheDir,
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
    AGENT_BROWSER_DOWNLOAD_PATH: downloadPath,
    AGENT_BROWSER_HEADED: session.headed ? '1' : '0',
  };
  if (session.stateName) {
    browserEnv.AGENT_BROWSER_SESSION_NAME = session.stateName;
  }
  if (!cdpUrl && session.profileDir) {
    browserEnv.AGENT_BROWSER_PROFILE = session.profileDir;
  }
  const launchArgs = resolveBrowserLaunchArgs(session);
  if (launchArgs) {
    browserEnv.AGENT_BROWSER_ARGS = launchArgs;
  } else {
    delete browserEnv.AGENT_BROWSER_ARGS;
  }
  if (session.headed && !cdpUrl) {
    const executablePath = resolveHeadedBrowserExecutable();
    if (!executablePath) {
      return {
        success: false,
        error:
          'Headful browser control requires Google Chrome. Install Google Chrome or set CHROME_BIN/AGENT_BROWSER_EXECUTABLE_PATH to a Chrome executable. Refusing to fall back to Playwright Chrome for Testing because it is unstable for headed macOS launches.',
      };
    }
    browserEnv.AGENT_BROWSER_EXECUTABLE_PATH = executablePath;
  }

  try {
    const { stdout, stderr } = await execFileAsync(runner.cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: browserEnv,
    });

    const output = String(stdout || '').trim();
    if (!output) {
      if (stderr?.trim()) {
        return { success: false, error: stderr.trim() };
      }
      return { success: true, data: {} };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return { success: true, data: { raw: output } };
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const parsedRecord = parsed as Record<string, unknown>;
      if (parsedRecord.success === false) {
        return {
          success: false,
          error: String(parsedRecord.error || 'browser command failed'),
        };
      }
      if ('data' in parsedRecord) {
        return { success: true, data: parsedRecord.data };
      }
    }
    return { success: true, data: parsed };
  } catch (err: unknown) {
    const errorRecord = err as {
      stderr?: unknown;
      stdout?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const stderr =
      typeof errorRecord.stderr === 'string' ? errorRecord.stderr.trim() : '';
    const stdout =
      typeof errorRecord.stdout === 'string' ? errorRecord.stdout.trim() : '';
    const timeoutHint =
      errorRecord.code === 'ETIMEDOUT' ||
      /timed out/i.test(String(errorRecord.message || ''))
        ? ` (timeout ${timeoutMs}ms)`
        : '';
    const msg = stderr || stdout || String(errorRecord.message || err);
    return {
      success: false,
      error: `browser command failed${timeoutHint}: ${msg}`,
    };
  }
}

function success(payload: Record<string, unknown>): string {
  return JSON.stringify({ success: true, ...payload }, null, 2);
}

function failure(message: string): string {
  return JSON.stringify({ success: false, error: message }, null, 2);
}

export async function executeBrowserTool(
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<string> {
  try {
    const effectiveSessionId = normalizeSessionKey(sessionId || 'default');
    switch (name) {
      case 'browser_navigate': {
        const parsed = await assertBrowserNavigationUrl(args.url);
        const headed = parseOptionalBoolean(args.headed ?? args.headful);
        const result = await runAgentBrowser(
          effectiveSessionId,
          'open',
          [parsed.toString()],
          { timeoutMs: 60_000, headed },
        );
        if (!result.success)
          return failure(result.error || 'navigation failed');
        const data = (result.data || {}) as Record<string, unknown>;
        const title = String(data.title || '');
        const botWarning = buildBotDetectionWarning(title);
        const textEval = await runBrowserEval(
          effectiveSessionId,
          EXTRACT_TEXT_PREVIEW_SCRIPT,
          20_000,
        );
        const textData = textEval.success ? asRecord(textEval.result) : null;
        const contentPreview =
          typeof textData?.preview === 'string' ? textData.preview : '';
        const contentLength =
          typeof textData?.text_length === 'number' &&
          Number.isFinite(textData.text_length)
            ? Math.max(0, Math.floor(textData.text_length))
            : 0;
        const contentPreviewTruncated = textData?.preview_truncated === true;
        const hasNoscript = textData?.has_noscript === true;
        const rootShell = textData?.root_shell === true;
        const readyState =
          typeof textData?.ready_state === 'string' ? textData.ready_state : '';
        const extractionHint = buildReadExtractionHint({
          contentLength,
          hasNoscript,
          rootShell,
        });
        // Best-effort priming so browser_network has request listeners active quickly.
        await runAgentBrowser(effectiveSessionId, 'network', [
          'requests',
        ]).catch(() => undefined);
        return success({
          url: data.url || parsed.toString(),
          title,
          session_id: effectiveSessionId,
          content_text_length: contentLength,
          ...(contentPreview ? { content_preview: contentPreview } : {}),
          ...(contentPreview
            ? { content_preview_truncated: contentPreviewTruncated }
            : {}),
          ...(readyState ? { ready_state: readyState } : {}),
          ...(hasNoscript ? { has_noscript: true } : {}),
          ...(rootShell ? { root_shell: true } : {}),
          read_extraction_hint: extractionHint,
          headed: getSession(effectiveSessionId).headed,
          ...(botWarning ? { bot_detection_warning: botWarning } : {}),
        });
      }

      case 'browser_snapshot': {
        const mode = normalizeSnapshotMode(args.mode);
        const full = args.full === true;
        const commandArgs = buildSnapshotCommandArgs(mode, full);

        const result = await runAgentBrowser(
          effectiveSessionId,
          'snapshot',
          commandArgs,
          { timeoutMs: 45_000 },
        );
        if (!result.success) return failure(result.error || 'snapshot failed');
        const data = (result.data || {}) as Record<string, unknown>;
        const rawSnapshot = String(data.snapshot || '');
        const truncated = truncateSnapshot(rawSnapshot);
        const frameEval = await runBrowserEval(
          effectiveSessionId,
          EXTRACT_IFRAMES_SCRIPT,
          15_000,
        );
        const frames = frameEval.success
          ? normalizeFrameMetadata(frameEval.result)
          : [];
        const twoFactorSelectorEval = await runBrowserEval(
          effectiveSessionId,
          TWO_FACTOR_SELECTOR_HINTS_SCRIPT,
          10_000,
        );
        const twoFactorSelectors = Array.isArray(twoFactorSelectorEval.result)
          ? twoFactorSelectorEval.result.filter(
              (selector): selector is string => typeof selector === 'string',
            )
          : [];
        const twoFactorTextSignal =
          /\b(verification code|one[- ]time code|two[- ]factor|2fa|multi[- ]factor|authenticator|sms|text message|recovery code|backup code|scan.+code|qr)\b/i.test(
            rawSnapshot,
          );
        return success({
          snapshot: truncated.text,
          truncated: truncated.truncated,
          element_count:
            data.refs && typeof data.refs === 'object'
              ? Object.keys(data.refs as Record<string, unknown>).length
              : 0,
          url: data.url || data.origin || '',
          mode,
          ...(frames.length > 0 ? { frames, frame_count: frames.length } : {}),
          ...(twoFactorSelectors.length > 0 || twoFactorTextSignal
            ? {
                two_factor_detection: {
                  detected: true,
                  selectors: twoFactorSelectors,
                  text_signal: twoFactorTextSignal,
                },
              }
            : {}),
        });
      }

      case 'browser_click': {
        const target = resolveClickTarget(args);
        const frame = parseOptionalFrame(args.frame);
        const waitForDownload = args.waitForDownload === true;
        const downloadPath = waitForDownload
          ? resolveDownloadOutputPath(args.downloadPath || args.path)
          : '';
        await applyFrameTarget(effectiveSessionId, frame);
        if (target.source === 'coordinate') {
          if (waitForDownload) {
            return failure(
              'waitForDownload requires a snapshot ref or CSS selector target; coordinate clicks cannot be captured as downloads by this browser runtime',
            );
          }
          if (
            typeof target.x !== 'number' ||
            typeof target.y !== 'number' ||
            !Number.isFinite(target.x) ||
            !Number.isFinite(target.y)
          ) {
            return failure('x and y must both be finite viewport coordinates');
          }
          const move = await runAgentBrowser(effectiveSessionId, 'mouse', [
            'move',
            String(target.x),
            String(target.y),
          ]);
          if (!move.success) {
            return failure(
              move.error ||
                `failed to move mouse to viewport coordinate ${target.x},${target.y}`,
            );
          }
          const down = await runAgentBrowser(effectiveSessionId, 'mouse', [
            'down',
            target.button || 'left',
          ]);
          if (!down.success) {
            return failure(down.error || 'failed to press mouse button');
          }
          const up = await runAgentBrowser(effectiveSessionId, 'mouse', [
            'up',
            target.button || 'left',
          ]);
          if (!up.success) {
            return failure(up.error || 'failed to release mouse button');
          }
          return success({
            clicked: target.raw,
            x: target.x,
            y: target.y,
            button: target.button || 'left',
            ...(frame ? { frame: frame.raw } : {}),
          });
        }
        if (target.source === 'ref') {
          if (waitForDownload) {
            const result = await runAgentBrowser(
              effectiveSessionId,
              'download',
              [target.raw, downloadPath],
              { timeoutMs: 120_000 },
            );
            const downloadResult = await collectClickDownloadResult(
              Promise.resolve(result),
              downloadPath,
            );
            if (!downloadResult.ok) return failure(downloadResult.error);
            return success({
              clicked: target.raw,
              ref: target.raw,
              ...downloadResult.fields,
              ...(frame ? { frame: frame.raw } : {}),
            });
          }
          const result = await runAgentBrowser(effectiveSessionId, 'click', [
            target.raw,
          ]);
          if (!result.success)
            return failure(result.error || `failed to click ${target.raw}`);
          return success({
            clicked: target.raw,
            ref: target.raw,
            ...(frame ? { frame: frame.raw } : {}),
          });
        }

        if (target.source === 'selector' && waitForDownload) {
          const result = await runAgentBrowser(
            effectiveSessionId,
            'download',
            [target.raw, downloadPath],
            { timeoutMs: 120_000 },
          );
          const downloadResult = await collectClickDownloadResult(
            Promise.resolve(result),
            downloadPath,
          );
          if (!downloadResult.ok) return failure(downloadResult.error);
          return success({
            clicked: target.raw,
            selector: target.raw,
            ...downloadResult.fields,
            ...(frame ? { frame: frame.raw } : {}),
          });
        }
        if (target.source === 'text' && waitForDownload) {
          return failure(
            'waitForDownload requires a snapshot ref or CSS selector target; visible-text clicks cannot be captured as downloads by this browser runtime',
          );
        }

        const clickEval = await runBrowserEval(
          effectiveSessionId,
          target.source === 'selector'
            ? buildSelectorClickScript(target.raw)
            : buildTextClickScript(target.raw, args.exact === true),
          30_000,
        );
        if (!clickEval.success) {
          return failure(
            clickEval.error ||
              `failed to click ${target.source} "${target.raw}"`,
          );
        }
        const clickData = asRecord(clickEval.result);
        if (clickData?.ok !== true) {
          const error =
            typeof clickData?.error === 'string'
              ? clickData.error
              : `failed to click ${target.source} "${target.raw}"`;
          return failure(error);
        }
        return success({
          clicked: target.raw,
          ...(target.source === 'selector'
            ? { selector: target.raw }
            : { text: target.raw, exact: args.exact === true }),
          ...(typeof clickData.tag === 'string' ? { tag: clickData.tag } : {}),
          ...(typeof clickData.text === 'string'
            ? { matched_text: clickData.text }
            : {}),
          ...(typeof clickData.matched_kind === 'string'
            ? { matched_kind: clickData.matched_kind }
            : {}),
          ...(frame ? { frame: frame.raw } : {}),
        });
      }

      case 'browser_type': {
        const selector = String(args.selector || '').trim();
        const ref = selector ? '' : ensureRef(args.ref);
        const target = selector || ref;
        const text = String(args.text || '');
        if (!text) return failure('text is required');
        const frame = parseOptionalFrame(args.frame);
        await applyFrameTarget(effectiveSessionId, frame);
        const result = await runAgentBrowser(effectiveSessionId, 'fill', [
          target,
          text,
        ]);
        if (!result.success)
          return failure(result.error || `failed to fill ${target}`);
        return success({
          ...(selector ? { selector } : { element: ref }),
          typed_chars: text.length,
          ...(frame ? { frame: frame.raw } : {}),
        });
      }

      case 'browser_upload': {
        const target = resolveUploadTarget(args);
        const filePaths = resolveUploadPaths(args);
        const frame = parseOptionalFrame(args.frame);
        await applyFrameTarget(effectiveSessionId, frame);
        const result = await runAgentBrowser(effectiveSessionId, 'upload', [
          target.raw,
          ...filePaths,
        ]);
        if (
          !result.success &&
          target.source === 'ref' &&
          isUploadTypeMismatchError(result.error || '')
        ) {
          const selectorEval = await runBrowserEval(
            effectiveSessionId,
            FIND_FILE_INPUT_SELECTORS_SCRIPT,
            15_000,
          );
          const selectors = selectorEval.success
            ? normalizeStringList(selectorEval.result, 10)
            : [];
          for (const selector of selectors) {
            const retry = await runAgentBrowser(effectiveSessionId, 'upload', [
              selector,
              ...filePaths,
            ]);
            if (!retry.success) continue;
            return success({
              element: target.raw,
              selector,
              target: selector,
              uploaded_count: filePaths.length,
              files: filePaths,
              fallback_from_ref: true,
              ...(frame ? { frame: frame.raw } : {}),
            });
          }
        }
        if (!result.success) {
          return failure(result.error || `failed to upload via ${target.raw}`);
        }
        return success({
          target: target.raw,
          ...(target.source === 'ref'
            ? { element: target.raw }
            : { selector: target.raw }),
          uploaded_count: filePaths.length,
          files: filePaths,
          ...(frame ? { frame: frame.raw } : {}),
        });
      }

      case 'browser_press': {
        const key = String(args.key || '').trim();
        if (!key) return failure('key is required');
        const frame = parseOptionalFrame(args.frame);
        await applyFrameTarget(effectiveSessionId, frame);
        const result = await runAgentBrowser(effectiveSessionId, 'press', [
          key,
        ]);
        if (!result.success)
          return failure(result.error || `failed to press ${key}`);
        return success({
          key,
          ...(frame ? { frame: frame.raw } : {}),
        });
      }

      case 'browser_scroll': {
        const direction = String(args.direction || '')
          .trim()
          .toLowerCase();
        if (direction !== 'up' && direction !== 'down') {
          return failure('direction must be "up" or "down"');
        }
        const pixelsRaw = Number(args.pixels);
        const pixels =
          Number.isFinite(pixelsRaw) && pixelsRaw > 0
            ? Math.floor(pixelsRaw)
            : 800;
        const result = await runAgentBrowser(effectiveSessionId, 'scroll', [
          direction,
          String(pixels),
        ]);
        if (!result.success)
          return failure(result.error || `failed to scroll ${direction}`);
        return success({ direction, pixels });
      }

      case 'browser_back': {
        const result = await runAgentBrowser(effectiveSessionId, 'back', []);
        if (!result.success)
          return failure(result.error || 'failed to navigate back');
        const data = (result.data || {}) as Record<string, unknown>;
        return success({ url: data.url || '' });
      }

      case 'browser_screenshot': {
        const outPath = resolveOutputPath(args.path, 'png');
        const fullPage = args.fullPage === true;
        const commandArgs = fullPage ? ['--full', outPath] : [outPath];
        const result = await runAgentBrowser(
          effectiveSessionId,
          'screenshot',
          commandArgs,
          { timeoutMs: 60_000 },
        );
        if (!result.success)
          return failure(result.error || 'failed to capture screenshot');
        const relativePath = toWorkspaceRelativePath(outPath);
        if (!relativePath) {
          return failure('failed to normalize screenshot artifact path');
        }
        return success({
          path: relativePath,
          image_url: relativePath,
          full_page: fullPage,
        });
      }

      case 'browser_pdf': {
        const outPath = resolveOutputPath(args.path, 'pdf');
        const result = await runAgentBrowser(
          effectiveSessionId,
          'pdf',
          [outPath],
          { timeoutMs: 60_000 },
        );
        if (!result.success)
          return failure(result.error || 'failed to generate pdf');
        const relativePath = toWorkspaceRelativePath(outPath);
        if (!relativePath) {
          return failure('failed to normalize pdf artifact path');
        }
        return success({ path: relativePath });
      }

      case 'browser_vision': {
        const question = String(args.question || '').trim();
        if (!question) return failure('question is required');

        const tempPath = createTempScreenshotPath('browser-vision');
        try {
          const screenshotResult = await runAgentBrowser(
            effectiveSessionId,
            'screenshot',
            [tempPath],
            {
              timeoutMs: 60_000,
            },
          );
          if (!screenshotResult.success) {
            return failure(
              screenshotResult.error ||
                'failed to capture screenshot for vision analysis',
            );
          }

          const imageBuffer = await fs.promises.readFile(tempPath);
          const base64 = imageBuffer.toString('base64');
          const vision = await callVisionModel(question, base64);
          return success({
            model: vision.model,
            analysis: vision.analysis,
          });
        } finally {
          await fs.promises.unlink(tempPath).catch(() => undefined);
        }
      }

      case 'browser_get_images': {
        const evalResult = await runBrowserEval(
          effectiveSessionId,
          EXTRACT_IMAGES_SCRIPT,
          20_000,
        );
        if (!evalResult.success)
          return failure(evalResult.error || 'failed to extract images');
        const images = normalizeImageList(evalResult.result);
        return success({ count: images.length, images });
      }

      case 'browser_console': {
        const clear = args.clear === true;
        const commandArgs = clear ? ['--clear'] : [];
        const result = await runAgentBrowser(
          effectiveSessionId,
          'console',
          commandArgs,
          { timeoutMs: 20_000 },
        );
        if (!result.success)
          return failure(result.error || 'failed to read console logs');
        const data = asRecord(result.data) || {};
        if (clear) {
          return success({ cleared: true, count: 0, messages: [] });
        }
        const rawMessages = Array.isArray(data.messages) ? data.messages : [];
        const messages = rawMessages
          .map((item) => {
            const entry = asRecord(item);
            if (!entry) return null;
            const text = typeof entry.text === 'string' ? entry.text : '';
            const level = typeof entry.type === 'string' ? entry.type : 'log';
            const timestamp =
              typeof entry.timestamp === 'number' &&
              Number.isFinite(entry.timestamp)
                ? entry.timestamp
                : null;
            if (!text) return null;
            return { level, text, timestamp };
          })
          .filter(
            (
              item,
            ): item is {
              level: string;
              text: string;
              timestamp: number | null;
            } => item !== null,
          );
        return success({
          messages,
          count: messages.length,
          url: data.origin || '',
        });
      }

      case 'browser_network': {
        const clear = args.clear === true;
        const filter = String(args.filter || '').trim();
        if (clear) {
          const clearRequestsResult = await runAgentBrowser(
            effectiveSessionId,
            'network',
            ['requests', '--clear'],
            {
              timeoutMs: 20_000,
            },
          );
          if (!clearRequestsResult.success) {
            return failure(
              clearRequestsResult.error ||
                'failed to clear network request history',
            );
          }
          await runBrowserEval(
            effectiveSessionId,
            CLEAR_NETWORK_TIMINGS_SCRIPT,
            10_000,
          ).catch(() => undefined);
          return success({ cleared: true, count: 0, requests: [] });
        }

        const networkArgs = ['requests'];
        if (filter) networkArgs.push('--filter', filter);
        const trackedResult = await runAgentBrowser(
          effectiveSessionId,
          'network',
          networkArgs,
          { timeoutMs: 20_000 },
        );
        const trackedData = asRecord(trackedResult.data);
        const trackedRequests = trackedResult.success
          ? normalizeTrackedRequests(trackedData?.requests)
          : [];

        const timingsEval = await runBrowserEval(
          effectiveSessionId,
          NETWORK_TIMINGS_SCRIPT,
          20_000,
        );
        const perfRequests = timingsEval.success
          ? normalizePerformanceRequests(timingsEval.result, filter)
          : [];

        if (!trackedResult.success && !timingsEval.success) {
          return failure(
            trackedResult.error ||
              timingsEval.error ||
              'failed to read network requests',
          );
        }

        const dedupe = new Set<string>();
        const requests = [...trackedRequests, ...perfRequests].filter(
          (entry) => {
            const url = typeof entry.url === 'string' ? entry.url : '';
            const method = typeof entry.method === 'string' ? entry.method : '';
            const type = typeof entry.type === 'string' ? entry.type : '';
            const key = `${method}|${type}|${url}`;
            if (!url || dedupe.has(key)) return false;
            dedupe.add(key);
            return true;
          },
        );

        return success({
          count: requests.length,
          requests,
          ...(filter ? { filter } : {}),
        });
      }

      case 'browser_await_two_factor': {
        assertGatewayInteractiveEscalationConfigured();
        const modality = String(args.modality || 'totp').trim();
        const prompt =
          String(args.prompt || '').trim() ||
          `A ${modality} challenge needs operator input.`;
        const skillId = String(args.skillId || '').trim();
        const userId = String(args.userId || '').trim();
        const targetChannel = String(args.escalationChannel || '').trim();
        const targetRecipient = String(args.escalationRecipient || '').trim();
        const ttlMs =
          typeof args.ttlMs === 'number' && Number.isFinite(args.ttlMs)
            ? args.ttlMs
            : null;

        const [textEval, selectorEval] = await Promise.all([
          runBrowserEval(
            effectiveSessionId,
            EXTRACT_TEXT_PREVIEW_SCRIPT,
            15_000,
          ),
          runBrowserEval(
            effectiveSessionId,
            TWO_FACTOR_SELECTOR_HINTS_SCRIPT,
            15_000,
          ),
        ]);
        const screenshotPath = createTempScreenshotPath('two-factor');
        const [snapshotResult, screenshotResult] = await Promise.all([
          runAgentBrowser(effectiveSessionId, 'snapshot', [], {
            timeoutMs: 30_000,
          }),
          runAgentBrowser(effectiveSessionId, 'screenshot', [screenshotPath], {
            timeoutMs: 60_000,
          }),
        ]);
        const screenshotRef = screenshotResult.success
          ? toWorkspaceRelativePath(screenshotPath)
          : null;
        const textData = asRecord(textEval.success ? textEval.result : null);
        const snapshotData = asRecord(
          snapshotResult.success ? snapshotResult.data : null,
        );
        const url =
          String(snapshotData?.url || snapshotData?.origin || '').trim() ||
          'about:blank';
        const title = String(snapshotData?.title || '').trim();
        const selectors = Array.isArray(selectorEval.result)
          ? selectorEval.result.filter(
              (selector): selector is string => typeof selector === 'string',
            )
          : [];

        const gatewayResult = await createGatewayInteractiveEscalation({
          prompt,
          modality,
          ...(userId ? { userId } : {}),
          ...(skillId ? { skillId } : {}),
          ...(ttlMs ? { ttlMs } : {}),
          ...(targetChannel && targetRecipient
            ? {
                escalationTarget: {
                  channel: targetChannel,
                  recipient: targetRecipient,
                },
              }
            : {}),
          frameSnapshot: {
            url,
            title,
            browserSessionKey: effectiveSessionId,
            screenshotRef,
          },
          context: {
            host: safeUrlHost(url),
            pageTitle: title || null,
            url,
            screenshotRef,
          },
        });
        const gatewaySession = asRecord(gatewayResult.session);
        const suspendedSessionId = String(
          gatewaySession?.sessionId || '',
        ).trim();
        if (suspendedSessionId) {
          suspendedSessionByBrowserSession.set(
            effectiveSessionId,
            suspendedSessionId,
          );
        }
        return success({
          parked: true,
          modality,
          detected_selectors: selectors,
          text_preview: String(textData?.preview || '').slice(0, 1000),
          screenshot: screenshotRef,
          interaction: gatewayResult,
        });
      }

      case 'browser_resume_interaction': {
        const ref = ensureRef(args.ref);
        const sessionId = String(
          args.sessionId ||
            suspendedSessionByBrowserSession.get(effectiveSessionId) ||
            effectiveSessionId,
        ).trim();
        const frame = parseOptionalFrame(args.frame);
        await applyFrameTarget(effectiveSessionId, frame);
        const gatewayResult =
          await consumeGatewayInteractiveEscalation(sessionId);
        const response = asRecord(gatewayResult.response);
        const kind = String(response?.kind || '').trim();
        if (kind === 'code') {
          const value = String(response?.value || '').trim();
          if (!value) {
            return failure('operator code response was empty');
          }
          const result = await runAgentBrowser(effectiveSessionId, 'fill', [
            ref,
            value,
          ]);
          if (!result.success) {
            return failure(result.error || `failed to fill ${ref}`);
          }
          return success({
            resumed: true,
            response_kind: 'code',
            code_injected: true,
            element: ref,
            ...(frame ? { frame: frame.raw } : {}),
          });
        }
        if (kind === 'approved' || kind === 'scanned') {
          return success({
            resumed: true,
            response_kind: kind,
            operator_completed_challenge: true,
          });
        }
        return success({
          resumed: false,
          response_kind: kind || 'unknown',
        });
      }

      case 'browser_close': {
        const warning = await closeSession(effectiveSessionId, {
          createIfMissing: true,
        });
        if (warning) {
          return success({
            closed: true,
            warning,
          });
        }
        return success({ closed: true });
      }

      default:
        return failure(`Unknown browser tool: ${name}`);
    }
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
}

export const BROWSER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'browser_await_two_factor',
      description:
        'Park the active browser session when a human must complete a 2FA or interactive challenge. Captures page context and screenshot, then asks the gateway to create a durable suspended session. Use this instead of trying to solve TOTP, push, QR, SMS, or recovery-code challenges automatically.',
      parameters: {
        type: 'object',
        properties: {
          modality: {
            type: 'string',
            enum: ['totp', 'push', 'qr', 'sms', 'recovery_code'],
            description: 'Challenge type.',
          },
          prompt: {
            type: 'string',
            description: 'Operator-facing prompt explaining what is needed.',
          },
          skillId: {
            type: 'string',
            description: 'Optional skill id that reached the waypoint.',
          },
          userId: {
            type: 'string',
            description: 'Optional operator id for the response.',
          },
          escalationChannel: {
            type: 'string',
            description: 'Optional F8 target channel for operator routing.',
          },
          escalationRecipient: {
            type: 'string',
            description: 'Optional F8 target recipient for operator routing.',
          },
          ttlMs: {
            type: 'number',
            description:
              'Optional timeout in milliseconds. Defaults to the gateway F14 timeout.',
          },
        },
        required: ['modality', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_resume_interaction',
      description:
        'Resume a browser session after the operator responds to browser_await_two_factor. If the response is a code, this consumes it from the gateway and injects it directly into the target element without returning the cleartext in the tool result.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description:
              'Element reference for the 2FA/code input from browser_snapshot.',
          },
          sessionId: {
            type: 'string',
            description:
              'Optional suspended session id. Defaults to the current browser session.',
          },
          frame: {
            type: 'string',
            description:
              'Optional frame selector. Use "main" to target the main document again.',
          },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description:
        'Navigate to a URL in a full browser session with JavaScript execution and dynamic rendering. Use for SPAs (React/Vue/Angular/Svelte), auth/login flows, dashboards/web apps (Notion, Google Docs, Airtable, Jira, etc.), interaction tasks (click/type/submit/scroll), bot/captcha/consent flows, or when web_fetch returns escalation hints (javascript_required, spa_shell_only, empty_extraction, boilerplate_only, bot_blocked). Prefer web_fetch instead for static docs/articles/wikis, direct API JSON/XML/text endpoints, and simple read-only retrieval. If the user asks for a visible/headed/headful browser window, pass headed=true; the setting persists for the browser session and may require a local display. Important: browser_navigate opens the page but does not replace content extraction; for read/summarize tasks call browser_snapshot with mode="full" next. Browser usage is typically ~10-100x slower/more expensive than web_fetch. Private/loopback hosts are blocked by default (SSRF guard).',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to open (http:// or https://)',
          },
          headed: {
            type: 'boolean',
            description:
              'Use a visible browser window when the user explicitly requests headful/headed browser control.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description:
        'Return an accessibility-tree snapshot of the current page with element refs usable by browser_click/browser_type. Use this to actually read page content after browser_navigate; for extraction tasks prefer mode="full" and repeat after browser_scroll on long/lazy-loaded pages.',
      parameters: {
        type: 'object',
        properties: {
          full: {
            type: 'boolean',
            description:
              'If true, request fuller snapshot output (default: false).',
          },
          mode: {
            type: 'string',
            enum: ['default', 'interactive', 'full'],
            description:
              'Snapshot mode. "default" keeps legacy behavior, "interactive" returns interactive refs only, "full" requests full tree.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description:
        'Click an element by snapshot ref (example: "@e5"), visible text, CSS selector, or exact viewport coordinates with x/y. Use the fallback chain ref -> text -> selector -> coordinates. Use x/y only when snapshot refs and visible text are not viable, especially for cross-origin iframe content.',
      parameters: {
        type: 'object',
        properties: {
          x: {
            type: 'number',
            description:
              'Fallback viewport x coordinate to click. Provide together with y for a real mouse click at that point when refs/text are not viable.',
          },
          y: {
            type: 'number',
            description:
              'Fallback viewport y coordinate to click. Provide together with x for a real mouse click at that point when refs/text are not viable.',
          },
          button: {
            type: 'string',
            enum: ['left', 'right', 'middle'],
            description:
              'Mouse button for coordinate clicks. Defaults to left.',
          },
          waitForDownload: {
            type: 'boolean',
            description:
              'When true, start a browser download listener before clicking and return the saved download_path.',
          },
          downloadPath: {
            type: 'string',
            description:
              'Optional filename or subpath under .browser-artifacts/downloads for waitForDownload clicks, for example "invoice.pdf".',
          },
          ref: {
            type: 'string',
            description:
              'Preferred element reference from browser_snapshot. Legacy @viewport-X-Y coordinate refs are accepted.',
          },
          selector: {
            type: 'string',
            description:
              'Optional CSS selector fallback when no snapshot ref or visible text target is available.',
          },
          text: {
            type: 'string',
            description:
              'Optional visible-text fallback when no snapshot ref is available.',
          },
          exact: {
            type: 'boolean',
            description:
              'When using text, require an exact match instead of substring matching.',
          },
          frame: {
            type: 'string',
            description:
              'Optional frame selector. Use "main" to target the main document again.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description:
        'Type text into an input element by snapshot ref or CSS selector (clears then fills). Provide either ref or selector.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description:
              'Element reference from browser_snapshot. Required when selector is omitted.',
          },
          selector: {
            type: 'string',
            description:
              'CSS selector fallback when a stable snapshot ref is unavailable. Required when ref is omitted.',
          },
          text: { type: 'string', description: 'Text to type.' },
          frame: {
            type: 'string',
            description:
              'Optional frame selector. Use "main" to target the main document again.',
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_secret_type',
      description:
        'Inject a stored secret into a browser element without exposing the secret text to the model. Use only for login/API credential fields after navigating to the target host.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Element reference from browser_snapshot.',
          },
          selector: {
            type: 'string',
            description:
              'CSS selector for policy allowlists and elements without stable refs.',
          },
          secretName: {
            type: 'string',
            description: 'Stored secret name to inject.',
          },
          skillName: {
            type: 'string',
            description:
              'Optional skill name for secret resolution policy and audit.',
          },
          frame: {
            type: 'string',
            description:
              'Optional frame selector. Use "main" to target the main document again.',
          },
        },
        required: ['secretName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_upload',
      description:
        'Upload one or more local files to a file input. Prefer a snapshot ref (for example "@e12"); if that ref points to a wrapper (like a span/button), provide selector for the underlying input[type=file].',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description:
              'Optional element reference from browser_snapshot (for example "@e12").',
          },
          selector: {
            type: 'string',
            description:
              'Optional CSS selector for the actual file input (for example input[type="file"]).',
          },
          path: {
            type: 'string',
            description:
              'Primary local file path to upload (relative to /workspace or absolute /discord-media-cache path).',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional additional local file paths for multi-file inputs.',
          },
          frame: {
            type: 'string',
            description:
              'Optional frame selector. Use "main" to target the main document again.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press',
      description:
        'Press a keyboard key in the active page (Enter, Tab, Escape, etc.).',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Keyboard key name.' },
          frame: {
            type: 'string',
            description:
              'Optional frame selector. Use "main" to target the main document again.',
          },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll the current page up or down.',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            description: 'Scroll direction: "up" or "down".',
          },
          pixels: {
            type: 'number',
            description: 'Optional pixel amount (default: 800).',
          },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_back',
      description: 'Navigate back in browser history.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description:
        'Capture a screenshot. Output path is constrained under /workspace/.browser-artifacts for safety.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Optional filename or subpath relative to .browser-artifacts, for example "shot.png". Do not include a .browser-artifacts/ prefix.',
          },
          fullPage: {
            type: 'boolean',
            description: 'Capture full page when true.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_pdf',
      description:
        'Save the current page as PDF artifact. Output path is constrained under /workspace/.browser-artifacts for safety. Use for export/sharing only, not for text extraction or summarization.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Optional relative output path under .browser-artifacts.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_vision',
      description:
        'Capture the current browser page screenshot and analyze it with a vision model. Use only for active browser-tab/page tasks, not for Discord-uploaded files.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'Question to ask about the current page screenshot.',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_images',
      description: 'Extract image URLs and alt text from the current page.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_console',
      description:
        'Return console messages captured from the current page; optionally clear them.',
      parameters: {
        type: 'object',
        properties: {
          clear: {
            type: 'boolean',
            description:
              'When true, clear stored console messages before returning.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_network',
      description:
        'Return recorded network requests and resource timings from the current page; optionally clear them.',
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            description: 'Optional URL substring filter.',
          },
          clear: {
            type: 'boolean',
            description:
              'When true, clear recorded network request history first.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description:
        'Close the current browser session and release associated resources.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];
