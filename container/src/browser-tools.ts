import { execFile, spawnSync } from 'child_process';
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

type BrowserRunner = {
  cmd: string;
  prefixArgs: string[];
};

type BrowserSession = {
  sessionKey: string;
  socketDir: string;
  createdAt: number;
  lastUsedAt: number;
};

const activeSessions = new Map<string, BrowserSession>();
let cachedRunner: BrowserRunner | null | undefined;

function normalizeSessionKey(sessionId: string): string {
  const normalized = String(sessionId || 'default')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 80);
  return normalized || 'default';
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
  const socketDir = path.join(BROWSER_SOCKET_ROOT, sessionKey);
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });

  const session: BrowserSession = {
    sessionKey,
    socketDir,
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
  if (options.cdpUrl && options.cdpUrl.trim()) {
    args.push('--cdp', options.cdpUrl.trim());
  }
  args.push('--json', command, ...commandArgs);

  try {
    const { stdout, stderr } = await execFileAsync(runner.cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        AGENT_BROWSER_SOCKET_DIR: session.socketDir,
        HOME: homeDir,
        XDG_CACHE_HOME: xdgCacheDir,
        NPM_CONFIG_CACHE: npmCacheDir,
        npm_config_cache: npmCacheDir,
        PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
      },
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
        return success({
          url: data.url || parsed.toString(),
          title: data.title || '',
          session_id: effectiveSessionId,
        });
      }

      case 'browser_snapshot': {
        const full = args.full === true;
        const commandArgs = full ? [] : ['-i', '-c'];
        const result = await runAgentBrowser(effectiveSessionId, 'snapshot', commandArgs, { timeoutMs: 45_000 });
        if (!result.success) return failure(result.error || 'snapshot failed');
        const data = (result.data || {}) as Record<string, unknown>;
        const rawSnapshot = String(data.snapshot || '');
        const truncated = truncateSnapshot(rawSnapshot);
        return success({
          snapshot: truncated.text,
          truncated: truncated.truncated,
          element_count:
            data.refs && typeof data.refs === 'object' ? Object.keys(data.refs as Record<string, unknown>).length : 0,
          url: data.url || '',
        });
      }

      case 'browser_click': {
        const ref = ensureRef(args.ref);
        const result = await runAgentBrowser(effectiveSessionId, 'click', [ref]);
        if (!result.success) return failure(result.error || `failed to click ${ref}`);
        return success({ clicked: ref });
      }

      case 'browser_type': {
        const ref = ensureRef(args.ref);
        const text = String(args.text || '');
        if (!text) return failure('text is required');
        const result = await runAgentBrowser(effectiveSessionId, 'fill', [ref, text]);
        if (!result.success) return failure(result.error || `failed to fill ${ref}`);
        return success({ element: ref, typed_chars: text.length });
      }

      case 'browser_press': {
        const key = String(args.key || '').trim();
        if (!key) return failure('key is required');
        const result = await runAgentBrowser(effectiveSessionId, 'press', [key]);
        if (!result.success) return failure(result.error || `failed to press ${key}`);
        return success({ key });
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
