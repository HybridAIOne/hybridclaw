import { execFile, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { lookup } from 'dns/promises';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { promisify } from 'util';

import type { ToolDefinition } from './types.js';

const execFileAsync = promisify(execFile);

const WORKSPACE_ROOT = '/workspace';
const BROWSER_SOCKET_ROOT = '/tmp/hybridclaw-browser';
const BROWSER_ARTIFACT_ROOT = path.join(WORKSPACE_ROOT, '.browser-artifacts');
const BROWSER_DEFAULT_TIMEOUT_MS = 45_000;
const BROWSER_MAX_SNAPSHOT_CHARS = 12_000;
const BROWSER_RUNTIME_ROOT = path.join(WORKSPACE_ROOT, '.hybridclaw-runtime');
const BROWSER_TMP_HOME = path.join(BROWSER_RUNTIME_ROOT, 'home');
const BROWSER_NPM_CACHE = path.join(BROWSER_RUNTIME_ROOT, 'npm-cache');
const BROWSER_XDG_CACHE = path.join(BROWSER_RUNTIME_ROOT, 'cache');
const BROWSER_PLAYWRIGHT_CACHE = path.join(BROWSER_RUNTIME_ROOT, 'ms-playwright');
const BROWSER_PROFILE_ROOT = path.join(BROWSER_RUNTIME_ROOT, 'browser-profiles');
const ENV_FALSEY = new Set(['0', 'false', 'no', 'off']);
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

type SnapshotMode = 'default' | 'interactive' | 'full';
type FrameTarget = {
  raw: string;
  isMain: boolean;
};
type BrowserModelContext = {
  baseUrl: string;
  apiKey: string;
  model: string;
  chatbotId: string;
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
  createdAt: number;
  lastUsedAt: number;
};

const activeSessions = new Map<string, BrowserSession>();
let cachedRunner: BrowserRunner | null | undefined;
let currentBrowserModelContext: BrowserModelContext = {
  baseUrl: '',
  apiKey: '',
  model: '',
  chatbotId: '',
};

export function setBrowserModelContext(
  baseUrl: string,
  apiKey: string,
  model: string,
  chatbotId: string,
): void {
  currentBrowserModelContext = {
    baseUrl: String(baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(apiKey || '').trim(),
    model: String(model || '').trim(),
    chatbotId: String(chatbotId || '').trim(),
  };
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

function resolveProfileRoot(): string {
  const configured = String(process.env.BROWSER_PROFILE_ROOT || '').trim();
  if (!configured) return ensureWritableDir(BROWSER_PROFILE_ROOT);
  const resolved = path.isAbsolute(configured) ? configured : path.resolve(WORKSPACE_ROOT, configured);
  return ensureWritableDir(resolved);
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

  const whichAgentBrowser = spawnSync('which', ['agent-browser'], { encoding: 'utf-8' });
  if (whichAgentBrowser.status === 0 && whichAgentBrowser.stdout.trim()) {
    cachedRunner = { cmd: whichAgentBrowser.stdout.trim(), prefixArgs: [] };
    return cachedRunner;
  }

  const whichNpx = spawnSync('which', ['npx'], { encoding: 'utf-8' });
  if (whichNpx.status === 0 && whichNpx.stdout.trim()) {
    cachedRunner = { cmd: whichNpx.stdout.trim(), prefixArgs: ['--yes', 'agent-browser'] };
    return cachedRunner;
  }

  cachedRunner = null;
  return cachedRunner;
}

function getSession(sessionId: string): BrowserSession {
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
  if (shouldPersistProfiles()) {
    try {
      profileDir = ensureWritableDir(path.join(resolveProfileRoot(), runtimeKey));
    } catch {
      // Fallback to ephemeral browser context if profile dir cannot be created.
      profileDir = undefined;
    }
  }

  const stateName = shouldPersistSessionState() ? deriveStableId(sessionKey, 48) : undefined;

  const session: BrowserSession = {
    sessionKey,
    socketDir,
    profileDir,
    stateName,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  activeSessions.set(sessionKey, session);
  return session;
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
  const imageDefault = '/ms-playwright';
  if (fs.existsSync(imageDefault)) {
    return imageDefault;
  }
  return ensureWritableDir(BROWSER_PLAYWRIGHT_CACHE);
}

function removeSession(sessionId: string): void {
  const sessionKey = normalizeSessionKey(sessionId);
  const session = activeSessions.get(sessionKey);
  if (!session) return;
  activeSessions.delete(sessionKey);
  try {
    fs.rmSync(session.socketDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 0) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0];
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    return net.isIP(mapped) === 4 ? isPrivateIpv4(mapped) : false;
  }
  return false;
}

function isPrivateIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = hostname.trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (net.isIP(host) > 0) return isPrivateIp(host);
  try {
    const resolved = await lookup(host, { all: true, verbatim: true });
    if (resolved.length === 0) return false;
    return resolved.some((entry) => isPrivateIp(entry.address));
  } catch {
    // If DNS cannot be resolved here, do not hard-block.
    return false;
  }
}

async function assertNavigationUrl(raw: unknown): Promise<URL> {
  const input = String(raw || '').trim();
  if (!input) {
    throw new Error('url is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (parsed.protocol === 'about:' && parsed.href === 'about:blank') {
    return parsed;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  const allowPrivate = String(process.env.BROWSER_ALLOW_PRIVATE_NETWORK || '').toLowerCase() === 'true';
  if (!allowPrivate && (await isPrivateHost(parsed.hostname))) {
    throw new Error(
      `Navigation blocked by SSRF guard: private or loopback host (${parsed.hostname}). ` +
        'Set BROWSER_ALLOW_PRIVATE_NETWORK=true to override.',
    );
  }
  return parsed;
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

function resolveOutputPath(rawPath: unknown, extension: 'png' | 'pdf'): string {
  fs.mkdirSync(BROWSER_ARTIFACT_ROOT, { recursive: true });

  const fallbackName = `browser-${Date.now()}.${extension}`;
  const requested = String(rawPath || '').trim();
  if (!requested) {
    return path.join(BROWSER_ARTIFACT_ROOT, fallbackName);
  }

  if (path.isAbsolute(requested)) {
    throw new Error('Absolute output paths are not allowed. Use a relative path.');
  }
  const normalized = requested.replace(/\\/g, '/');
  const clean = path.posix.normalize(normalized);
  if (clean === '..' || clean.startsWith('../')) {
    throw new Error('Output path escapes browser artifacts directory.');
  }

  const withExt = clean.endsWith(`.${extension}`) ? clean : `${clean}.${extension}`;
  const resolved = path.resolve(BROWSER_ARTIFACT_ROOT, withExt);
  const root = path.resolve(BROWSER_ARTIFACT_ROOT);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Output path escapes browser artifacts directory.');
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function createTempScreenshotPath(prefix: string): string {
  fs.mkdirSync(BROWSER_ARTIFACT_ROOT, { recursive: true });
  const nonce = Math.random().toString(36).slice(2, 10);
  return path.join(BROWSER_ARTIFACT_ROOT, `${prefix}-${Date.now()}-${nonce}.png`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeSnapshotMode(rawMode: unknown): SnapshotMode {
  if (rawMode == null || String(rawMode).trim() === '') return 'default';
  const mode = String(rawMode).trim().toLowerCase();
  if (mode === 'default' || mode === 'interactive' || mode === 'full') return mode;
  throw new Error('mode must be one of "default", "interactive", or "full"');
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

async function applyFrameTarget(sessionId: string, target: FrameTarget | null): Promise<void> {
  if (!target) return;
  const commandArgs = target.isMain ? ['main'] : [target.raw];
  const frameResult = await runAgentBrowser(sessionId, 'frame', commandArgs);
  if (!frameResult.success) {
    throw new Error(frameResult.error || `failed to switch to frame "${target.raw}"`);
  }
}

async function runBrowserEval(
  sessionId: string,
  script: string,
  timeoutMs = 30_000,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const response = await runAgentBrowser(sessionId, 'eval', [script], { timeoutMs });
  if (!response.success) {
    return { success: false, error: response.error || 'browser eval failed' };
  }
  const data = asRecord(response.data);
  return { success: true, result: data ? data.result : undefined };
}

function normalizeFrameMetadata(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const frames: Record<string, unknown>[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    if (!entry) continue;
    const index = typeof entry.index === 'number' && Number.isFinite(entry.index) ? entry.index : null;
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
    const width = typeof entry.width === 'number' && Number.isFinite(entry.width) ? entry.width : null;
    const height = typeof entry.height === 'number' && Number.isFinite(entry.height) ? entry.height : null;
    images.push({ src, alt, width, height });
  }
  return images;
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
    const type = typeof entry.resourceType === 'string' ? entry.resourceType : null;
    const timestamp = typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp) ? entry.timestamp : null;
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

function normalizePerformanceRequests(raw: unknown, filter?: string): Record<string, unknown>[] {
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
    const duration = typeof entry.duration === 'number' && Number.isFinite(entry.duration) ? entry.duration : null;
    const transferSize =
      typeof entry.transfer_size === 'number' && Number.isFinite(entry.transfer_size) ? entry.transfer_size : null;
    const startTime = typeof entry.start_time === 'number' && Number.isFinite(entry.start_time) ? entry.start_time : null;
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

function buildBotDetectionWarning(titleValue: unknown): Record<string, unknown> | null {
  const title = String(titleValue || '').trim();
  if (!title) return null;
  const lower = title.toLowerCase();
  const matched = BOT_DETECTION_PATTERNS.find((pattern) => lower.includes(pattern));
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

function extractVisionTextContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.trim()) chunks.push(part.trim());
      continue;
    }
    const obj = asRecord(part);
    if (!obj) continue;
    const text = typeof obj.text === 'string' ? obj.text : '';
    if (text.trim()) chunks.push(text.trim());
  }
  return chunks.join('\n').trim();
}

async function callVisionModel(question: string, imageBase64: string): Promise<{ model: string; analysis: string }> {
  const apiKey = currentBrowserModelContext.apiKey;
  const baseUrl = currentBrowserModelContext.baseUrl;
  const model = currentBrowserModelContext.model;
  const chatbotId = currentBrowserModelContext.chatbotId;
  if (!apiKey) {
    throw new Error('browser_vision is not configured: missing active request API key context.');
  }
  if (!baseUrl) {
    throw new Error('browser_vision is not configured: missing active request base URL context.');
  }
  if (!model) {
    throw new Error('browser_vision is not configured: missing active request model context.');
  }
  if (!chatbotId) {
    throw new Error('browser_vision is not configured: missing active request chatbot_id context.');
  }
  const endpoint = `${baseUrl}/v1/chat/completions`;
  const payload = {
    model,
    chatbot_id: chatbotId,
    enable_rag: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
        ],
      },
    ],
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    const details = bodyText.length > 600 ? `${bodyText.slice(0, 600)}...` : bodyText;
    throw new Error(`vision API request failed (${response.status}): ${details}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error('vision API returned a non-JSON response');
  }

  const record = asRecord(parsed);
  const choices = record?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('vision API response did not include choices');
  }
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const analysis = extractVisionTextContent(message?.content);
  if (!analysis) {
    throw new Error('vision API returned an empty analysis');
  }

  return { model, analysis };
}

async function runAgentBrowser(
  sessionId: string,
  command: string,
  commandArgs: string[] = [],
  options: { timeoutMs?: number; cdpUrl?: string } = {},
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

  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS, 180_000));
  const session = getSession(sessionId);
  const homeDir = resolveWritableHome();
  const npmCacheDir = ensureWritableDir(BROWSER_NPM_CACHE);
  const xdgCacheDir = ensureWritableDir(BROWSER_XDG_CACHE);
  const playwrightBrowsersPath = resolvePlaywrightBrowsersPath();
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
  };
  if (session.stateName) {
    browserEnv.AGENT_BROWSER_SESSION_NAME = session.stateName;
  }
  if (!cdpUrl && session.profileDir) {
    browserEnv.AGENT_BROWSER_PROFILE = session.profileDir;
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

    let parsed: any;
    try {
      parsed = JSON.parse(output);
    } catch {
      return { success: true, data: { raw: output } };
    }

    if (parsed && typeof parsed === 'object' && parsed.success === false) {
      return { success: false, error: String(parsed.error || 'browser command failed') };
    }
    if (parsed && typeof parsed === 'object' && 'data' in parsed) {
      return { success: true, data: parsed.data };
    }
    return { success: true, data: parsed };
  } catch (err: any) {
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    const stdout = typeof err?.stdout === 'string' ? err.stdout.trim() : '';
    const timeoutHint =
      err?.code === 'ETIMEDOUT' || /timed out/i.test(String(err?.message || '')) ? ` (timeout ${timeoutMs}ms)` : '';
    const msg = stderr || stdout || String(err?.message || err);
    return { success: false, error: `browser command failed${timeoutHint}: ${msg}` };
  }
}

function success(payload: Record<string, unknown>): string {
  return JSON.stringify({ success: true, ...payload }, null, 2);
}

function failure(message: string): string {
  return JSON.stringify({ success: false, error: message }, null, 2);
}

export async function executeBrowserTool(name: string, args: Record<string, unknown>, sessionId: string): Promise<string> {
  try {
    const effectiveSessionId = normalizeSessionKey(sessionId || 'default');
    switch (name) {
      case 'browser_navigate': {
        const parsed = await assertNavigationUrl(args.url);
        const result = await runAgentBrowser(effectiveSessionId, 'open', [parsed.toString()], { timeoutMs: 60_000 });
        if (!result.success) return failure(result.error || 'navigation failed');
        const data = (result.data || {}) as Record<string, unknown>;
        const title = String(data.title || '');
        const botWarning = buildBotDetectionWarning(title);
        // Best-effort priming so browser_network has request listeners active quickly.
        await runAgentBrowser(effectiveSessionId, 'network', ['requests']).catch(() => undefined);
        return success({
          url: data.url || parsed.toString(),
          title,
          session_id: effectiveSessionId,
          ...(botWarning ? { bot_detection_warning: botWarning } : {}),
        });
      }

      case 'browser_snapshot': {
        const mode = normalizeSnapshotMode(args.mode);
        const full = args.full === true;
        let commandArgs: string[];
        if (mode === 'interactive') commandArgs = ['-i'];
        else if (mode === 'full') commandArgs = [];
        else commandArgs = full ? [] : ['-i', '-c'];

        const result = await runAgentBrowser(effectiveSessionId, 'snapshot', commandArgs, { timeoutMs: 45_000 });
        if (!result.success) return failure(result.error || 'snapshot failed');
        const data = (result.data || {}) as Record<string, unknown>;
        const rawSnapshot = String(data.snapshot || '');
        const truncated = truncateSnapshot(rawSnapshot);
        const frameEval = await runBrowserEval(effectiveSessionId, EXTRACT_IFRAMES_SCRIPT, 15_000);
        const frames = frameEval.success ? normalizeFrameMetadata(frameEval.result) : [];
        return success({
          snapshot: truncated.text,
          truncated: truncated.truncated,
          element_count:
            data.refs && typeof data.refs === 'object' ? Object.keys(data.refs as Record<string, unknown>).length : 0,
          url: data.url || data.origin || '',
          mode,
          ...(frames.length > 0 ? { frames, frame_count: frames.length } : {}),
        });
      }

      case 'browser_click': {
        const ref = ensureRef(args.ref);
        const frame = parseOptionalFrame(args.frame);
        await applyFrameTarget(effectiveSessionId, frame);
        const result = await runAgentBrowser(effectiveSessionId, 'click', [ref]);
        if (!result.success) return failure(result.error || `failed to click ${ref}`);
        return success({
          clicked: ref,
          ...(frame ? { frame: frame.raw } : {}),
        });
      }

      case 'browser_type': {
        const ref = ensureRef(args.ref);
        const text = String(args.text || '');
        if (!text) return failure('text is required');
        const frame = parseOptionalFrame(args.frame);
        await applyFrameTarget(effectiveSessionId, frame);
        const result = await runAgentBrowser(effectiveSessionId, 'fill', [ref, text]);
        if (!result.success) return failure(result.error || `failed to fill ${ref}`);
        return success({
          element: ref,
          typed_chars: text.length,
          ...(frame ? { frame: frame.raw } : {}),
        });
      }

      case 'browser_press': {
        const key = String(args.key || '').trim();
        if (!key) return failure('key is required');
        const frame = parseOptionalFrame(args.frame);
        await applyFrameTarget(effectiveSessionId, frame);
        const result = await runAgentBrowser(effectiveSessionId, 'press', [key]);
        if (!result.success) return failure(result.error || `failed to press ${key}`);
        return success({
          key,
          ...(frame ? { frame: frame.raw } : {}),
        });
      }

      case 'browser_scroll': {
        const direction = String(args.direction || '').trim().toLowerCase();
        if (direction !== 'up' && direction !== 'down') {
          return failure('direction must be "up" or "down"');
        }
        const pixelsRaw = Number(args.pixels);
        const pixels = Number.isFinite(pixelsRaw) && pixelsRaw > 0 ? Math.floor(pixelsRaw) : 800;
        const result = await runAgentBrowser(effectiveSessionId, 'scroll', [direction, String(pixels)]);
        if (!result.success) return failure(result.error || `failed to scroll ${direction}`);
        return success({ direction, pixels });
      }

      case 'browser_back': {
        const result = await runAgentBrowser(effectiveSessionId, 'back', []);
        if (!result.success) return failure(result.error || 'failed to navigate back');
        const data = (result.data || {}) as Record<string, unknown>;
        return success({ url: data.url || '' });
      }

      case 'browser_screenshot': {
        const outPath = resolveOutputPath(args.path, 'png');
        const fullPage = args.fullPage === true;
        const commandArgs = fullPage ? ['--full', outPath] : [outPath];
        const result = await runAgentBrowser(effectiveSessionId, 'screenshot', commandArgs, { timeoutMs: 60_000 });
        if (!result.success) return failure(result.error || 'failed to capture screenshot');
        return success({
          path: path.relative(WORKSPACE_ROOT, outPath),
          full_page: fullPage,
        });
      }

      case 'browser_pdf': {
        const outPath = resolveOutputPath(args.path, 'pdf');
        const result = await runAgentBrowser(effectiveSessionId, 'pdf', [outPath], { timeoutMs: 60_000 });
        if (!result.success) return failure(result.error || 'failed to generate pdf');
        return success({ path: path.relative(WORKSPACE_ROOT, outPath) });
      }

      case 'browser_vision': {
        const question = String(args.question || '').trim();
        if (!question) return failure('question is required');

        const tempPath = createTempScreenshotPath('browser-vision');
        try {
          const screenshotResult = await runAgentBrowser(effectiveSessionId, 'screenshot', [tempPath], {
            timeoutMs: 60_000,
          });
          if (!screenshotResult.success) {
            return failure(screenshotResult.error || 'failed to capture screenshot for vision analysis');
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
        const evalResult = await runBrowserEval(effectiveSessionId, EXTRACT_IMAGES_SCRIPT, 20_000);
        if (!evalResult.success) return failure(evalResult.error || 'failed to extract images');
        const images = normalizeImageList(evalResult.result);
        return success({ count: images.length, images });
      }

      case 'browser_console': {
        const clear = args.clear === true;
        const commandArgs = clear ? ['--clear'] : [];
        const result = await runAgentBrowser(effectiveSessionId, 'console', commandArgs, { timeoutMs: 20_000 });
        if (!result.success) return failure(result.error || 'failed to read console logs');
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
              typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp) ? entry.timestamp : null;
            if (!text) return null;
            return { level, text, timestamp };
          })
          .filter((item): item is { level: string; text: string; timestamp: number | null } => item !== null);
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
          const clearRequestsResult = await runAgentBrowser(effectiveSessionId, 'network', ['requests', '--clear'], {
            timeoutMs: 20_000,
          });
          if (!clearRequestsResult.success) {
            return failure(clearRequestsResult.error || 'failed to clear network request history');
          }
          await runBrowserEval(effectiveSessionId, CLEAR_NETWORK_TIMINGS_SCRIPT, 10_000).catch(() => undefined);
          return success({ cleared: true, count: 0, requests: [] });
        }

        const networkArgs = ['requests'];
        if (filter) networkArgs.push('--filter', filter);
        const trackedResult = await runAgentBrowser(effectiveSessionId, 'network', networkArgs, { timeoutMs: 20_000 });
        const trackedData = asRecord(trackedResult.data);
        const trackedRequests = trackedResult.success ? normalizeTrackedRequests(trackedData?.requests) : [];

        const timingsEval = await runBrowserEval(effectiveSessionId, NETWORK_TIMINGS_SCRIPT, 20_000);
        const perfRequests = timingsEval.success ? normalizePerformanceRequests(timingsEval.result, filter) : [];

        if (!trackedResult.success && !timingsEval.success) {
          return failure(trackedResult.error || timingsEval.error || 'failed to read network requests');
        }

        const dedupe = new Set<string>();
        const requests = [...trackedRequests, ...perfRequests].filter((entry) => {
          const url = typeof entry.url === 'string' ? entry.url : '';
          const method = typeof entry.method === 'string' ? entry.method : '';
          const type = typeof entry.type === 'string' ? entry.type : '';
          const key = `${method}|${type}|${url}`;
          if (!url || dedupe.has(key)) return false;
          dedupe.add(key);
          return true;
        });

        return success({
          count: requests.length,
          requests,
          ...(filter ? { filter } : {}),
        });
      }

      case 'browser_close': {
        const result = await runAgentBrowser(effectiveSessionId, 'close', []);
        removeSession(effectiveSessionId);
        if (!result.success) {
          return success({
            closed: true,
            warning: result.error || 'session close returned non-success',
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
      name: 'browser_navigate',
      description:
        'Navigate to an HTTP/HTTPS URL in a browser session. Private/loopback hosts are blocked by default (SSRF guard).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open (http:// or https://)' },
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
        'Return an accessibility-tree snapshot of the current page with element refs usable by browser_click/browser_type.',
      parameters: {
        type: 'object',
        properties: {
          full: { type: 'boolean', description: 'If true, request fuller snapshot output (default: false).' },
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
      description: 'Click an element by snapshot ref (example: "@e5").',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element reference from browser_snapshot.' },
          frame: {
            type: 'string',
            description: 'Optional frame selector. Use "main" to target the main document again.',
          },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input element by snapshot ref (clears then fills).',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element reference from browser_snapshot.' },
          text: { type: 'string', description: 'Text to type.' },
          frame: {
            type: 'string',
            description: 'Optional frame selector. Use "main" to target the main document again.',
          },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press',
      description: 'Press a keyboard key in the active page (Enter, Tab, Escape, etc.).',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Keyboard key name.' },
          frame: {
            type: 'string',
            description: 'Optional frame selector. Use "main" to target the main document again.',
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
          direction: { type: 'string', description: 'Scroll direction: "up" or "down".' },
          pixels: { type: 'number', description: 'Optional pixel amount (default: 800).' },
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
          path: { type: 'string', description: 'Optional relative output path under .browser-artifacts.' },
          fullPage: { type: 'boolean', description: 'Capture full page when true.' },
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
        'Save the current page as PDF. Output path is constrained under /workspace/.browser-artifacts for safety.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional relative output path under .browser-artifacts.' },
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
        'Capture a screenshot and analyze it with a vision model using the provided question.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Question to ask about the current page screenshot.' },
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
      description: 'Return console messages captured from the current page; optionally clear them.',
      parameters: {
        type: 'object',
        properties: {
          clear: { type: 'boolean', description: 'When true, clear stored console messages before returning.' },
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
          filter: { type: 'string', description: 'Optional URL substring filter.' },
          clear: { type: 'boolean', description: 'When true, clear recorded network request history first.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: 'Close the current browser session and release associated resources.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];
