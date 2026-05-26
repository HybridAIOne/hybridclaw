import { Buffer } from 'node:buffer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { assertBrowserNavigationUrl } from '../../container/shared/browser-navigation.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { buildCuaMacResults } from '../doctor/checks/cua-mac.js';
import {
  assertSecretResolveAllowed,
  recordSecretResolved,
  recordSecretUnsafeEscaped,
} from '../gateway/gateway-secret-injection.js';
import {
  isSecretHandle,
  unsafeEscapeSecretHandle,
} from '../security/secret-handles.js';
import { hardenSecretRef, type SecretRef } from '../security/secret-refs.js';
import { normalizeScrollDelta } from './playwright-utils.js';
import type {
  BrowserEvaluateFunction,
  BrowserFillInput,
  BrowserProvider,
  BrowserProviderCapabilities,
  BrowserSession,
  BrowserSessionMeteringContext,
  BrowserTwoFactorCodeFillResult,
  BrowserTwoFactorState,
  BrowserWaypointEvent,
  BrowserWaypointOptions,
  ClickOptions,
  HistoryNavigationOptions,
  NavigateOptions,
  ScreenshotOptions,
  ScrollOptions,
  SessionOptions,
  WaitOptions,
} from './provider.js';
import { DEFAULT_BROWSER_PROVIDER_CAPABILITIES } from './provider.js';

export const MAC_CUA_BROWSERS = {
  safari: 'com.apple.Safari',
  chrome: 'com.google.Chrome',
  firefox: 'org.mozilla.firefox',
  brave: 'com.brave.Browser',
  arc: 'company.thebrowser.Browser',
} as const;

export type MacCuaBrowserName = keyof typeof MAC_CUA_BROWSERS;
export type MacCuaScreenshotMode = 'som' | 'vision' | 'ax';

export interface MacCuaEnvironmentState {
  cursorX: number;
  cursorY: number;
  frontmostBundleId: string;
  activeSpaceId?: string | number | null;
}

export type MacCuaTarget =
  | { kind: 'ax'; elementIndex: number; windowId?: string | number }
  | { kind: 'point'; x: number; y: number }
  | { kind: 'query'; query: string };

export interface MacCuaResolvedTarget {
  target: MacCuaTarget;
  pixelFallback?: {
    reason: string;
  };
}

export interface MacCuaScreenshotResult {
  dataBase64: string;
  mimeType?: string;
}

export interface MacCuaDriver {
  startBrowserSession(params: {
    bundleId: string;
    backgroundSafe: true;
  }): Promise<{ sessionId: string; windowId?: string | number }>;
  stopBrowserSession(sessionId: string): Promise<void>;
  keyChord(
    sessionId: string,
    params: { key: string; modifiers: string[] },
  ): Promise<void>;
  pressKey(sessionId: string, key: string): Promise<void>;
  typeTextChars(
    sessionId: string,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<void>;
  click(sessionId: string, target: MacCuaTarget): Promise<void>;
  setValue(
    sessionId: string,
    target: MacCuaTarget,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<void>;
  scroll(
    sessionId: string,
    params: { target?: MacCuaTarget; deltaX: number; deltaY: number },
  ): Promise<void>;
  screenshot(
    sessionId: string,
    opts: ScreenshotOptions & { mode: MacCuaScreenshotMode },
  ): Promise<MacCuaScreenshotResult>;
  waitForElement(
    sessionId: string,
    target: MacCuaTarget,
    opts?: WaitOptions,
  ): Promise<void>;
  resolveTarget(
    sessionId: string,
    target: MacCuaTarget,
  ): Promise<MacCuaResolvedTarget>;
  getAddressBarValue(sessionId: string): Promise<string | null>;
  getCurrentUrl(sessionId: string): Promise<string | null>;
  detectTwoFactorWaypoint?(
    sessionId: string,
  ): Promise<{ detected: boolean; signals?: string[]; selectors?: string[] }>;
  fillTwoFactorInput?(
    sessionId: string,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<boolean>;
  focusTwoFactorInput?(sessionId: string): Promise<boolean>;
  getEnvironmentState(): Promise<MacCuaEnvironmentState>;
}

export interface MacCuaProviderOptions {
  browser?: MacCuaBrowserName;
  driver?: MacCuaDriver;
  driverCommand?: string;
  driverArgs?: string[];
  screenshotMode?: MacCuaScreenshotMode;
  allowPrivateNetwork?: boolean;
  audit?: typeof recordAuditEvent;
  driverTimeoutMs?: number;
}

type ActiveMacCuaSession = {
  sessionId: string;
  metering: BrowserSessionMeteringContext | undefined;
  runId: string;
};

const SHELL_INJECTION_PATTERNS = [
  /\b(?:curl|wget)\b[\s\S]{0,240}\|\s*(?:bash|sh)\b/iu,
  /\bsudo\s+rm\s+-rf\b/iu,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&?\s*;?\s*\}\s*;/u,
];

const SAFE_MAC_CUA_PRESS_KEYS = new Set([
  'return',
  'tab',
  'escape',
  'backspace',
  'delete',
  'forwarddelete',
  'space',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
]);

const MAC_CUA_PRESS_KEY_ALIASES = new Map([
  ['enter', 'return'],
  ['esc', 'escape'],
  [' ', 'space'],
  ['spacebar', 'space'],
  ['up', 'arrowup'],
  ['down', 'arrowdown'],
  ['left', 'arrowleft'],
  ['right', 'arrowright'],
]);

const DESTRUCTIVE_KEY_CHORDS = new Set([
  'cmd+q',
  'cmd+w',
  'cmd+shift+q',
  'cmd+shift+delete',
  'ctrl+w',
  'cmd+ctrl+q',
  'cmd+option+shift+q',
]);
const DEFAULT_DRIVER_TIMEOUT_MS = 60_000;
const CUA_MCP_CLIENT_INFO = {
  name: 'hybridclaw-mac-cua',
  version: process.env.npm_package_version || '0.0.0',
};

function normalizeKeyChord(key: string, modifiers: string[]): string {
  const normalizedModifiers = modifiers
    .map((modifier) => modifier.trim().toLowerCase())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return [...normalizedModifiers, key.trim().toLowerCase()].join('+');
}

export function assertSafeMacCuaKeyChord(
  key: string,
  modifiers: string[],
): void {
  if (DESTRUCTIVE_KEY_CHORDS.has(normalizeKeyChord(key, modifiers))) {
    throw new Error(
      `mac-cua blocked destructive browser key chord: ${[...modifiers, key].join('+')}`,
    );
  }
}

export function assertSafeMacCuaTypedPayload(text: string): void {
  if (SHELL_INJECTION_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error('mac-cua blocked unsafe typed payload');
  }
}

function normalizeSafeMacCuaPressKey(key: string): string {
  const normalized = String(key || '')
    .trim()
    .toLowerCase();
  const mapped = MAC_CUA_PRESS_KEY_ALIASES.get(normalized) || normalized;
  if (/^[a-z0-9]$/u.test(mapped) || SAFE_MAC_CUA_PRESS_KEYS.has(mapped)) {
    return mapped;
  }
  throw new Error(`mac-cua blocked unsupported key press: ${key}`);
}

function parseMacCuaTarget(selector: string): MacCuaTarget {
  const raw = selector.trim();
  const elementMatch = raw.match(
    /^(?:@?e|ax:|element:)(\d+)(?:@(?:window:)?([A-Za-z0-9_.:-]+))?$/u,
  );
  if (elementMatch?.[1]) {
    return {
      kind: 'ax',
      elementIndex: Number(elementMatch[1]),
      ...(elementMatch[2] ? { windowId: elementMatch[2] } : {}),
    };
  }

  const pointMatch = raw.match(
    /^(?:point:)?(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/u,
  );
  if (pointMatch?.[1] && pointMatch[2]) {
    return {
      kind: 'point',
      x: Number(pointMatch[1]),
      y: Number(pointMatch[2]),
    };
  }

  return { kind: 'query', query: raw };
}

function driverPayloadForText(value: string): { text: string } {
  assertSafeMacCuaTypedPayload(value);
  return { text: value };
}

function assertNoUnsupportedNavigationWait(
  opts?: NavigateOptions | HistoryNavigationOptions,
): void {
  if (!opts) return;
  if (opts.waitUntil || opts.timeoutMs !== undefined) {
    throw new Error(
      'MacCuaBrowserProvider does not support waitUntil or timeoutMs navigation waits until the CUA driver exposes a readiness probe.',
    );
  }
}

function resolveUrlHost(url: string | null, selector: string): string {
  if (!url) {
    throw new Error(
      `browser.fill(${selector}) SecretRef requires a resolvable browser URL for host-scoped secret policy evaluation.`,
    );
  }
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) {
      throw new Error('URL host is empty');
    }
    return parsed.hostname;
  } catch (error) {
    throw new Error(
      `browser.fill(${selector}) SecretRef requires a resolvable browser URL for host-scoped secret policy evaluation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function decodeDriverScreenshot(result: MacCuaScreenshotResult): Buffer {
  try {
    return Buffer.from(result.dataBase64, 'base64');
  } catch (error) {
    throw new Error(
      `mac-cua driver returned an invalid screenshot payload: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function defaultDriverCommand(): { command: string; args: string[] } {
  const configured = process.env.HYBRIDAI_CUA_DRIVER_BIN?.trim();
  return {
    command: configured || 'cua-driver',
    args: ['mcp', '--no-daemon-relaunch'],
  };
}

export function resolveMacCuaDriverCommand(options?: {
  command?: string;
  args?: string[];
}): { command: string; args: string[] } {
  const fallback = defaultDriverCommand();
  return {
    command: options?.command || fallback.command,
    args:
      options?.args && options.args.length > 0 ? options.args : fallback.args,
  };
}

function normalizePositiveInteger(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeWindowId(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const candidates: Array<{
    id: number;
    onCurrentSpace: boolean;
    layer: number;
    area: number;
  }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = normalizePositiveInteger(record.window_id);
    if (id === null) continue;
    const bounds =
      record.bounds && typeof record.bounds === 'object'
        ? (record.bounds as Record<string, unknown>)
        : {};
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    candidates.push({
      id,
      onCurrentSpace: record.on_current_space === true,
      layer: typeof record.layer === 'number' ? record.layer : 0,
      area:
        Number.isFinite(width) && Number.isFinite(height)
          ? Math.max(0, width * height)
          : 0,
    });
  }
  candidates.sort((a, b) => {
    if (a.layer !== b.layer) return a.layer - b.layer;
    if (a.onCurrentSpace !== b.onCurrentSpace) {
      return a.onCurrentSpace ? -1 : 1;
    }
    return b.area - a.area;
  });
  return candidates[0]?.id ?? null;
}

export function resolveMacCuaWindowStateElementIndex(
  record: Record<string, unknown>,
): number | null {
  const structured =
    normalizePositiveInteger(record.element_index) ||
    normalizePositiveInteger(record.elementIndex) ||
    normalizePositiveInteger(record.index);
  if (structured !== null) return structured;
  const tree = String(record.tree_markdown || record.markdown || '');
  const match = tree.match(/\[element_index\s+(\d+)\]/u);
  if (match?.[1]) return Number(match[1]);
  const indexedLine = tree.match(/^\s*(?:-\s+)?\[(\d+)\]\s+\w+/mu);
  return indexedLine?.[1] ? Number(indexedLine[1]) : null;
}

function firstElementIndex(record: Record<string, unknown>): number | null {
  return resolveMacCuaWindowStateElementIndex(record);
}

function firstEditableElementSelector(
  record: Record<string, unknown>,
  windowId?: string | number,
): string | null {
  const target = firstEditableElementTarget(record, windowId);
  if (!target || target.kind !== 'ax') return null;
  return `@e${target.elementIndex}${target.windowId ? `@window:${target.windowId}` : ''}`;
}

function firstEditableElementTarget(
  record: Record<string, unknown>,
  windowId?: string | number,
): MacCuaTarget | null {
  const tree = String(record.tree_markdown || record.markdown || '');
  for (const line of tree.split(/\r?\n/u)) {
    const indexMatch = line.match(/\[element_index\s+(\d+)\]/u);
    const roleMatch = line.match(
      /\b(?:AX)?(?:TextField|TextArea|SearchField|ComboBox)\b/iu,
    );
    if (indexMatch?.[1] && roleMatch) {
      const elementIndex = Number(indexMatch[1]);
      if (Number.isFinite(elementIndex)) {
        return {
          kind: 'ax',
          elementIndex,
          ...(windowId ? { windowId } : {}),
        };
      }
    }
  }
  const elementPattern =
    /^\s*(?:-\s+)?\[(\d+)\]\s+(\w+)(?:\s+"([^"]*)"|(?:\s+\(\d+\))?\s+id=([^\s[\]]*))?/gmu;
  for (const match of tree.matchAll(elementPattern)) {
    const index = match[1] ? Number(match[1]) : null;
    const role = String(match[2] || '').toLowerCase();
    if (
      index !== null &&
      Number.isFinite(index) &&
      (role.includes('textfield') ||
        role.includes('textarea') ||
        role.includes('searchfield') ||
        role.includes('combobox'))
    ) {
      return {
        kind: 'ax',
        elementIndex: index,
        ...(windowId ? { windowId } : {}),
      };
    }
  }
  return null;
}

function scrollDirectionFromDelta(
  deltaX: number,
  deltaY: number,
): 'up' | 'down' | 'left' | 'right' {
  if (Math.abs(deltaX) > Math.abs(deltaY)) {
    return deltaX < 0 ? 'left' : 'right';
  }
  return deltaY < 0 ? 'up' : 'down';
}

interface CuaMcpToolResult {
  data: unknown;
  images: string[];
  structuredContent: Record<string, unknown> | null;
  isError: boolean;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function normalizeMcpToolResult(result: CallToolResult): CuaMcpToolResult {
  const images: string[] = [];
  const textChunks: string[] = [];
  for (const part of result.content || []) {
    if (part.type === 'text') {
      textChunks.push(part.text || '');
    } else if (part.type === 'image' && part.data) {
      images.push(part.data);
    }
  }
  const text = textChunks.filter(Boolean).join('\n');
  let data: unknown = text;
  if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = text;
    }
  }
  const structured =
    result.structuredContent &&
    typeof result.structuredContent === 'object' &&
    !Array.isArray(result.structuredContent)
      ? (result.structuredContent as Record<string, unknown>)
      : null;
  return {
    data,
    images,
    structuredContent: structured,
    isError: result.isError === true,
  };
}

class StdioMacCuaDriver implements MacCuaDriver {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly sessions = new Map<
    string,
    { pid: number; windowId: number; lastTypedText?: string }
  >();

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly timeoutMs = DEFAULT_DRIVER_TIMEOUT_MS,
  ) {}

  async startBrowserSession(params: {
    bundleId: string;
    backgroundSafe: true;
  }): Promise<{ sessionId: string; windowId?: string | number }> {
    const existing = await this.findExistingBrowserWindow(params.bundleId);
    const record =
      existing ||
      (await this.callToolRecord('launch_app', {
        bundle_id: params.bundleId,
        urls: ['about:blank'],
      }));
    const pid = normalizePositiveInteger(record.pid);
    const windowId =
      normalizePositiveInteger(record.window_id) ||
      normalizeWindowId(record.windows);
    if (pid === null || windowId === null) {
      throw new Error(
        'mac-cua driver launch_app response did not include pid and window_id.',
      );
    }
    const sessionId = `${pid}:${windowId}`;
    this.sessions.set(sessionId, { pid, windowId });
    return {
      sessionId,
      windowId,
    };
  }

  async stopBrowserSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    if (this.sessions.size === 0) {
      await this.closeMcpSession();
    }
  }

  async keyChord(
    sessionId: string,
    params: { key: string; modifiers: string[] },
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.callTool('hotkey', {
      pid: session.pid,
      window_id: session.windowId,
      keys: [...params.modifiers, params.key],
    });
  }

  async pressKey(sessionId: string, key: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.callTool('press_key', {
      pid: session.pid,
      window_id: session.windowId,
      key,
    });
  }

  async typeTextChars(
    sessionId: string,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    if ('secretRef' in payload) {
      throw new Error(
        'mac-cua MCP driver cannot resolve SecretRef payloads directly.',
      );
    }
    session.lastTypedText = payload.text;
    const args = {
      pid: session.pid,
      window_id: session.windowId,
      text: payload.text,
    };
    try {
      await this.callTool('type_text_chars', args);
    } catch (error) {
      if (!String(error).includes('Unknown tool')) throw error;
      await this.callTool('type_text', args);
    }
  }

  async click(sessionId: string, target: MacCuaTarget): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.callTool('click', {
      pid: session.pid,
      window_id: session.windowId,
      ...this.toDriverTarget(target),
    });
  }

  async setValue(
    sessionId: string,
    target: MacCuaTarget,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    if ('secretRef' in payload) {
      throw new Error(
        'mac-cua MCP driver cannot resolve SecretRef payloads directly.',
      );
    }
    await this.callTool('set_value', {
      pid: session.pid,
      window_id: session.windowId,
      ...this.toDriverTarget(target),
      value: payload.text,
    });
  }

  async scroll(
    sessionId: string,
    params: { target?: MacCuaTarget; deltaX: number; deltaY: number },
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.callTool('scroll', {
      pid: session.pid,
      window_id: session.windowId,
      ...(params.target ? this.toDriverTarget(params.target) : {}),
      direction: scrollDirectionFromDelta(params.deltaX, params.deltaY),
      by: 'page',
      amount: 1,
    });
  }

  async screenshot(
    sessionId: string,
    opts: ScreenshotOptions & { mode: MacCuaScreenshotMode },
  ): Promise<MacCuaScreenshotResult> {
    const session = this.requireSession(sessionId);
    const result =
      opts.mode === 'ax'
        ? await this.callTool('get_window_state', {
            pid: session.pid,
            window_id: session.windowId,
          })
        : await this.callTool('screenshot', {
            window_id: session.windowId,
            format: opts.type || 'png',
          });
    const dataBase64 = result.images[0];
    if (!dataBase64) {
      const text =
        typeof result.data === 'string' ? result.data : JSON.stringify(result);
      throw new Error(
        text
          ? `mac-cua driver screenshot response did not include image bytes: ${text}`
          : 'mac-cua driver screenshot response did not include image bytes.',
      );
    }
    return {
      dataBase64,
      mimeType: opts.type === 'jpeg' ? 'image/jpeg' : 'image/png',
    };
  }

  async waitForElement(
    sessionId: string,
    target: MacCuaTarget,
    opts?: WaitOptions,
  ): Promise<void> {
    await this.resolveTarget(sessionId, target);
    void opts;
  }

  async resolveTarget(
    sessionId: string,
    target: MacCuaTarget,
  ): Promise<MacCuaResolvedTarget> {
    const session = this.requireSession(sessionId);
    if (target.kind === 'point') return { target };
    if (target.kind === 'ax') return { target };
    const record = await this.callToolRecord('get_window_state', {
      pid: session.pid,
      window_id: session.windowId,
      query: target.query,
    });
    const elementIndex = firstElementIndex(record);
    if (elementIndex === null) return { target };
    return { target: { kind: 'ax', elementIndex, windowId: session.windowId } };
  }

  async getAddressBarValue(sessionId: string): Promise<string | null> {
    return this.requireSession(sessionId).lastTypedText || null;
  }

  async getCurrentUrl(sessionId: string): Promise<string | null> {
    const session = this.requireSession(sessionId);
    try {
      const record = await this.callToolRecord('page', {
        pid: session.pid,
        window_id: session.windowId,
        action: 'execute_javascript',
        javascript: '(() => window.location.href)()',
      });
      const value = record.result || record.value;
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  }

  async detectTwoFactorWaypoint(
    sessionId: string,
  ): Promise<{ detected: boolean; signals?: string[]; selectors?: string[] }> {
    const session = this.requireSession(sessionId);
    const record = await this.callToolRecord('get_window_state', {
      pid: session.pid,
      window_id: session.windowId,
      query: 'verification code',
    });
    const text = JSON.stringify(record).toLowerCase();
    const detected =
      text.includes('verification code') ||
      text.includes('two-factor') ||
      text.includes('2fa') ||
      text.includes('one-time');
    if (!detected) return { detected: false };
    const selector = firstEditableElementSelector(record, session.windowId);
    return {
      detected: true,
      signals: ['ax_two_factor_text'],
      ...(selector ? { selectors: [selector] } : {}),
    };
  }

  private async findTwoFactorInputTarget(
    sessionId: string,
  ): Promise<MacCuaTarget | null> {
    const session = this.requireSession(sessionId);
    for (const query of [
      'one-time-code',
      'otp',
      'totp',
      'verification code',
      'two-factor',
      'code',
      '',
    ]) {
      const record = await this.callToolRecord('get_window_state', {
        pid: session.pid,
        window_id: session.windowId,
        ...(query ? { query } : {}),
      });
      const target = firstEditableElementTarget(record, session.windowId);
      if (!target) continue;
      return target;
    }
    return null;
  }

  async fillTwoFactorInput(
    sessionId: string,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<boolean> {
    const target = await this.findTwoFactorInputTarget(sessionId);
    if (!target) return false;
    await this.setValue(sessionId, target, payload);
    return true;
  }

  async focusTwoFactorInput(sessionId: string): Promise<boolean> {
    const target = await this.findTwoFactorInputTarget(sessionId);
    if (!target) {
      return false;
    }
    await this.click(sessionId, target);
    return true;
  }

  async getEnvironmentState(): Promise<MacCuaEnvironmentState> {
    const [cursorText, apps, windows] = await Promise.all([
      this.callToolText('get_cursor_position', {}),
      this.callToolRecord('list_apps', {}),
      this.callToolRecord('list_windows', {}),
    ]);
    const cursor = cursorText.match(
      /\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/u,
    );
    const activeApp = Array.isArray(apps.apps)
      ? apps.apps.find(
          (app): app is Record<string, unknown> =>
            Boolean(app) &&
            typeof app === 'object' &&
            !Array.isArray(app) &&
            app.active === true,
        )
      : null;
    return {
      cursorX: cursor?.[1] ? Number(cursor[1]) : 0,
      cursorY: cursor?.[2] ? Number(cursor[2]) : 0,
      frontmostBundleId:
        typeof activeApp?.bundle_id === 'string' ? activeApp.bundle_id : '',
      activeSpaceId:
        typeof windows.current_space_id === 'number'
          ? windows.current_space_id
          : null,
    };
  }

  private requireSession(sessionId: string): {
    pid: number;
    windowId: number;
    lastTypedText?: string;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('mac-cua driver session is not active.');
    return session;
  }

  private toDriverTarget(target: MacCuaTarget): {
    element_index?: number;
    x?: number;
    y?: number;
  } {
    if (target.kind === 'point') return { x: target.x, y: target.y };
    if (target.kind === 'ax') return { element_index: target.elementIndex };
    throw new Error('mac-cua query target was not resolved to AX or point.');
  }

  private async findExistingBrowserWindow(
    bundleId: string,
  ): Promise<Record<string, unknown> | null> {
    const apps = await this.callToolRecord('list_apps', {});
    const app = Array.isArray(apps.apps)
      ? apps.apps.find(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            entry.bundle_id === bundleId &&
            entry.running === true,
        )
      : null;
    const pid = normalizePositiveInteger(app?.pid);
    if (pid === null) return null;
    const windows = await this.callToolRecord('list_windows', {
      pid,
      on_screen_only: false,
    });
    const windowId = normalizeWindowId(windows.windows);
    return windowId === null ? null : { pid, window_id: windowId };
  }

  private async callToolRecord(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.callTool(tool, args);
    const payload =
      result.structuredContent ||
      (result.data &&
      typeof result.data === 'object' &&
      !Array.isArray(result.data)
        ? result.data
        : null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(
        `mac-cua driver tool ${tool} returned non-object output.`,
      );
    }
    return payload as Record<string, unknown>;
  }

  private async callToolText(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.callTool(tool, args);
    return typeof result.data === 'string' ? result.data : '';
  }

  private async callTool(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<CuaMcpToolResult> {
    await this.ensureMcpSession();
    if (!this.client) throw new Error('mac-cua MCP client is not connected.');
    const result = (await withTimeout(
      this.client.callTool(
        {
          name: tool,
          arguments: args,
        },
        CallToolResultSchema,
      ),
      this.timeoutMs,
      `mac-cua driver tool ${tool}`,
    )) as CallToolResult;
    const normalized = normalizeMcpToolResult(result);
    if (normalized.isError) {
      const message =
        typeof normalized.data === 'string'
          ? normalized.data
          : JSON.stringify(
              normalized.data || normalized.structuredContent || {},
            );
      throw new Error(
        `mac-cua driver tool ${tool} failed${message ? `: ${message}` : ''}`,
      );
    }
    return normalized;
  }

  private async ensureMcpSession(): Promise<void> {
    if (this.client) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    this.startPromise = (async () => {
      const transport = new StdioClientTransport({
        command: this.command,
        args: this.args,
        env: getDefaultEnvironment(),
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk) => {
        process.stderr.write(`[mac-cua] ${String(chunk)}`);
      });
      const client = new Client(CUA_MCP_CLIENT_INFO, { capabilities: {} });
      await withTimeout(
        client.connect(transport),
        this.timeoutMs,
        'mac-cua driver MCP connect',
      );
      this.transport = transport;
      this.client = client;
    })();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async closeMcpSession(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.startPromise = null;
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
  }
}

class MacCuaBrowserSession implements BrowserSession {
  private awaitingTwoFactor = false;
  private lastTwoFactorState: BrowserTwoFactorState | null = null;

  constructor(
    private readonly driver: MacCuaDriver,
    private readonly sessionId: string,
    private readonly browserName: MacCuaBrowserName,
    private readonly bundleId: string,
    private readonly metering: BrowserSessionMeteringContext | undefined,
    private readonly runId: string,
    private readonly screenshotMode: MacCuaScreenshotMode,
    private readonly allowPrivateNetwork: boolean | undefined,
    private readonly audit: typeof recordAuditEvent,
  ) {}

  async evaluate<T>(_fn: BrowserEvaluateFunction<T>): Promise<T> {
    throw new Error(
      'MacCuaBrowserProvider does not support DOM evaluate; use screenshot/AX targeting instead.',
    );
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    const bytes = await this.runAction('screenshot', async () =>
      decodeDriverScreenshot(
        await this.driver.screenshot(this.sessionId, {
          ...opts,
          mode: this.screenshotMode,
        }),
      ),
    );
    this.recordScreenshotTaken(opts);
    return bytes;
  }

  async navigate(url: string, opts?: NavigateOptions): Promise<void> {
    await this.runAction('navigate', async () => {
      assertNoUnsupportedNavigationWait(opts);
      const parsed = await assertBrowserNavigationUrl(url, {
        allowPrivateNetwork: this.allowPrivateNetwork,
      });
      await this.keyChord('l', ['cmd']);
      await this.driver.typeTextChars(this.sessionId, {
        text: parsed.toString(),
      });
      const addressBarValue = await this.driver.getAddressBarValue(
        this.sessionId,
      );
      if (!addressBarValue) {
        throw new Error(
          'mac-cua driver did not return an address-bar AX value before navigation commit.',
        );
      }
      await assertBrowserNavigationUrl(addressBarValue, {
        allowPrivateNetwork: this.allowPrivateNetwork,
      });
      await this.driver.pressKey(this.sessionId, 'return');
    });
  }

  async back(opts?: HistoryNavigationOptions): Promise<void> {
    await this.runAction('back', async () => {
      assertNoUnsupportedNavigationWait(opts);
      await this.keyChord('[', ['cmd']);
    });
  }

  async forward(opts?: HistoryNavigationOptions): Promise<void> {
    await this.runAction('forward', async () => {
      assertNoUnsupportedNavigationWait(opts);
      await this.keyChord(']', ['cmd']);
    });
  }

  async reload(opts?: HistoryNavigationOptions): Promise<void> {
    await this.runAction('reload', async () => {
      assertNoUnsupportedNavigationWait(opts);
      await this.keyChord('r', ['cmd']);
    });
  }

  async click(selector: string, _opts?: ClickOptions): Promise<void> {
    const requestedTarget = parseMacCuaTarget(selector);
    await this.runAction('click', async () => {
      const target = await this.resolveActionTarget(
        'click',
        selector,
        requestedTarget,
      );
      await this.driver.click(this.sessionId, target);
    });
  }

  async press(key: string): Promise<void> {
    const normalizedKey = normalizeSafeMacCuaPressKey(key);
    await this.runAction('press', async () => {
      await this.driver.pressKey(this.sessionId, normalizedKey);
    });
  }

  async fill(selector: string, value: BrowserFillInput): Promise<void> {
    const requestedTarget = parseMacCuaTarget(selector);
    await this.runAction('fill', async () => {
      const payload = this.buildFillPayload(selector, value);
      const target = await this.resolveActionTarget(
        'fill',
        selector,
        requestedTarget,
      );
      if ('secretRef' in payload) {
        await this.assertSecretFillAllowed(selector, payload.secretRef);
      }
      await this.driver.click(this.sessionId, target);
      await this.driver.typeTextChars(this.sessionId, payload);
      if ('secretRef' in payload) {
        this.recordCredentialFilled(selector, payload.secretRef);
      }
    });
  }

  async fillTwoFactorCode(
    value: BrowserFillInput,
  ): Promise<BrowserTwoFactorCodeFillResult> {
    const state = await this.inspectTwoFactorChallenge();
    const selector = state.selectors?.[0];
    if (selector) {
      await this.fill(selector, value);
      return { selector, strategy: 'ax-selector' };
    }

    let strategy = 'native-focus';
    await this.runAction('browser_resume_interaction', async () => {
      const payload = this.buildFillPayload('detected 2FA input', value);
      if (this.driver.fillTwoFactorInput) {
        const filled = await this.driver.fillTwoFactorInput(
          this.sessionId,
          payload,
        );
        if (filled) {
          strategy = 'native-set-value';
          return;
        }
      }
      if (!this.driver.focusTwoFactorInput) {
        throw new Error(
          'mac-cua cannot focus the 2FA input because the driver does not expose a native 2FA focus primitive.',
        );
      }
      const focused = await this.driver.focusTwoFactorInput(this.sessionId);
      if (!focused) {
        throw new Error('mac-cua could not focus the detected 2FA input.');
      }
      await this.driver.typeTextChars(this.sessionId, payload);
    });
    return { strategy };
  }

  private buildFillPayload(
    selector: string,
    value: BrowserFillInput,
  ): { text: string } | { secretRef: SecretRef } {
    if (typeof value === 'string') return driverPayloadForText(value);
    if (isSecretHandle(value)) {
      try {
        return driverPayloadForText(
          unsafeEscapeSecretHandle(value, {
            reason: `fill browser field ${selector}`,
            audit: (handle, reason) => {
              recordSecretUnsafeEscaped({
                sessionId: this.metering?.sessionId,
                runId: this.runId,
                skillName: this.metering?.skillName,
                secretSource: handle.ref.source,
                secretId: handle.ref.id,
                sinkKind: 'dom',
                selector,
                reason,
              });
            },
          }),
        );
      } finally {
        value.dispose();
      }
    }
    const hardened = hardenSecretRef(value);
    return {
      secretRef: { source: hardened.source, id: hardened.id },
    };
  }

  async scroll(opts: ScrollOptions): Promise<void> {
    const delta = normalizeScrollDelta(opts);
    await this.runAction('scroll', async () => {
      const target = opts.selector
        ? await this.resolveActionTarget(
            'scroll',
            opts.selector,
            parseMacCuaTarget(opts.selector),
          )
        : undefined;
      await this.driver.scroll(this.sessionId, {
        ...(target ? { target } : {}),
        ...delta,
      });
    });
  }

  async waitForSelector(selector: string, opts?: WaitOptions): Promise<void> {
    const requestedTarget = parseMacCuaTarget(selector);
    await this.runAction('wait_for_selector', async () => {
      const target = await this.resolveActionTarget(
        'wait_for_selector',
        selector,
        requestedTarget,
      );
      await this.driver.waitForElement(this.sessionId, target, opts);
    });
  }

  async inspectTwoFactorChallenge(): Promise<BrowserTwoFactorState> {
    if (this.awaitingTwoFactor && this.lastTwoFactorState?.detected) {
      return this.lastTwoFactorState;
    }
    const state = await this.detectCurrentTwoFactorState();
    if (state.detected) {
      this.lastTwoFactorState = state;
    }
    return state;
  }

  async waypoint(
    event: BrowserWaypointEvent,
    opts?: BrowserWaypointOptions,
  ): Promise<void> {
    await this.runAction(event, async () => {
      this.recordWaypoint(event, opts);
      this.awaitingTwoFactor = event === 'browser_await_two_factor';
      if (event === 'browser_resume_interaction') {
        this.awaitingTwoFactor = false;
        this.lastTwoFactorState = null;
      }
    });
  }

  private async keyChord(key: string, modifiers: string[]): Promise<void> {
    assertSafeMacCuaKeyChord(key, modifiers);
    await this.driver.keyChord(this.sessionId, { key, modifiers });
  }

  private async resolveActionTarget(
    action: string,
    selector: string,
    requestedTarget: MacCuaTarget,
  ): Promise<MacCuaTarget> {
    if (requestedTarget.kind === 'point') {
      throw new Error(
        'mac-cua pixel targeting is only allowed as an AX-resolution fallback.',
      );
    }
    const resolved = await this.driver.resolveTarget(
      this.sessionId,
      requestedTarget,
    );
    if (resolved.pixelFallback || resolved.target.kind === 'point') {
      this.recordPixelFallback(
        action,
        selector,
        resolved.target,
        resolved.pixelFallback?.reason || 'missing_ax_bounds',
      );
    }
    return resolved.target;
  }

  private async runAction<T>(
    action: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const before = await this.driver.getEnvironmentState();
    try {
      const result = await run();
      const after = await this.driver.getEnvironmentState();
      this.assertBackgroundSafe(before, after);
      await this.recordDetectedTwoFactor(action);
      this.recordAction(action, 'ok');
      return result;
    } catch (error) {
      this.recordAction(action, 'error', error);
      throw error;
    }
  }

  private assertBackgroundSafe(
    before: MacCuaEnvironmentState | undefined,
    after: MacCuaEnvironmentState | undefined,
  ): void {
    if (!before || !after) return;
    const unchanged =
      before.frontmostBundleId === after.frontmostBundleId &&
      before.activeSpaceId === after.activeSpaceId;
    if (!unchanged) {
      throw new Error(
        'mac-cua driver violated background-safe contract by changing frontmost app or active Space',
      );
    }
  }

  private recordAction(
    action: string,
    status: 'ok' | 'error',
    error?: unknown,
  ): void {
    if (!this.metering?.sessionId) return;
    this.audit({
      sessionId: this.metering.sessionId,
      runId: this.runId,
      event: {
        type: 'browser.action',
        provider: 'mac-cua',
        action,
        status,
        browser: this.browserName,
        bundleId: this.bundleId,
        ...(error
          ? { error: error instanceof Error ? error.message : String(error) }
          : {}),
      },
    });
  }

  private recordScreenshotTaken(opts?: ScreenshotOptions): void {
    if (!this.metering?.sessionId) return;
    this.audit({
      sessionId: this.metering.sessionId,
      runId: this.runId,
      event: {
        type: 'browser.screenshot_taken',
        provider: 'mac-cua',
        browser: this.browserName,
        bundleId: this.bundleId,
        mode: this.screenshotMode,
        fullPage: opts?.fullPage === true,
        imageType: opts?.type || null,
        artifactRef: null,
        path: null,
      },
    });
  }

  private recordWaypoint(
    event: BrowserWaypointEvent,
    opts?: BrowserWaypointOptions,
    detection?: { action: string; signals?: string[] },
  ): void {
    if (!this.metering?.sessionId) return;
    this.audit({
      sessionId: this.metering.sessionId,
      runId: this.runId,
      event: {
        type: 'browser.waypoint',
        provider: 'mac-cua',
        browser: this.browserName,
        bundleId: this.bundleId,
        waypoint: event,
        modality: opts?.modality || (detection ? 'mac-cua-ax' : null),
        prompt: opts?.prompt || null,
        suspendedSessionId: opts?.sessionId || null,
        responseKind: opts?.responseKind || null,
        ...(detection
          ? {
              detectedAfterAction: detection.action,
              signals: detection.signals || [],
            }
          : {}),
      },
    });
  }

  private recordPixelFallback(
    action: string,
    selector: string,
    target: MacCuaTarget,
    reason: string,
  ): void {
    if (!this.metering?.sessionId) return;
    this.audit({
      sessionId: this.metering.sessionId,
      runId: this.runId,
      event: {
        type: 'browser.pixel_fallback',
        provider: 'mac-cua',
        browser: this.browserName,
        bundleId: this.bundleId,
        action,
        selector,
        reason,
        target,
      },
    });
  }

  private async recordDetectedTwoFactor(action: string): Promise<void> {
    if (this.awaitingTwoFactor || !this.driver.detectTwoFactorWaypoint) return;
    if (
      action === 'browser_await_two_factor' ||
      action === 'browser_resume_interaction'
    ) {
      return;
    }
    const result = await this.detectCurrentTwoFactorState();
    if (!result.detected) return;
    this.awaitingTwoFactor = true;
    this.lastTwoFactorState = result;
    this.recordWaypoint(
      'browser_await_two_factor',
      { modality: 'mac-cua-ax' },
      { action, signals: result.signals },
    );
  }

  private async detectCurrentTwoFactorState(): Promise<BrowserTwoFactorState> {
    if (!this.driver.detectTwoFactorWaypoint) return { detected: false };
    const result = await this.driver.detectTwoFactorWaypoint(this.sessionId);
    const url = await this.driver
      .getCurrentUrl(this.sessionId)
      .catch(() => null);
    if (!result.detected) {
      return { detected: false, url };
    }
    return {
      detected: true,
      modality: 'totp',
      signals: result.signals || ['ax_two_factor_text'],
      url,
      title: '',
      preview: 'verification code',
      selectors: result.selectors || [],
    };
  }

  private recordCredentialFilled(selector: string, ref: SecretRef): void {
    if (!this.metering?.sessionId) return;
    this.audit({
      sessionId: this.metering.sessionId,
      runId: this.runId,
      event: {
        type: 'browser.credential_filled',
        selector,
        host: null,
        skill: this.metering.skillName || null,
        secretRef: {
          source: ref.source,
          id: ref.id,
        },
        sinkKind: 'dom',
      },
    });
  }

  private async assertSecretFillAllowed(
    selector: string,
    ref: SecretRef,
  ): Promise<void> {
    const skillName = this.metering?.skillName?.trim();
    if (!skillName) {
      throw new Error(
        `browser.fill(${selector}) SecretRef requires SessionOptions.metering.skillName so secret policy can evaluate the calling skill.`,
      );
    }
    const host = resolveUrlHost(
      await this.driver.getCurrentUrl(this.sessionId),
      selector,
    );
    assertSecretResolveAllowed({
      sessionId: this.metering?.sessionId,
      agentId: this.metering?.agentId,
      skillName,
      secretSource: ref.source,
      secretId: ref.id,
      sinkKind: 'dom',
      host,
      selector,
    });
    recordSecretResolved({
      sessionId: this.metering?.sessionId,
      runId: this.runId,
      skillName,
      secretSource: ref.source,
      secretId: ref.id,
      sinkKind: 'dom',
      host,
      selector,
    });
  }
}

export class MacCuaBrowserProvider implements BrowserProvider {
  private readonly activeSessions = new WeakMap<
    MacCuaBrowserSession,
    ActiveMacCuaSession
  >();
  private readonly driver: MacCuaDriver;
  private readonly browserName: MacCuaBrowserName;
  private readonly bundleId: string;
  private readonly screenshotMode: MacCuaScreenshotMode;
  private readonly audit: typeof recordAuditEvent;

  constructor(private readonly options: MacCuaProviderOptions = {}) {
    this.browserName = options.browser || 'chrome';
    this.bundleId = MAC_CUA_BROWSERS[this.browserName];
    this.screenshotMode = options.screenshotMode || 'som';
    this.audit = options.audit || recordAuditEvent;
    if (options.driver) {
      this.driver = options.driver;
    } else {
      if (process.platform !== 'darwin') {
        throw new Error('MacCuaBrowserProvider is only supported on macOS.');
      }
      const driverCommand = resolveMacCuaDriverCommand({
        command: options.driverCommand,
        args: options.driverArgs,
      });
      this.driver = new StdioMacCuaDriver(
        driverCommand.command,
        driverCommand.args,
        options.driverTimeoutMs,
      );
    }
  }

  async launchSession(opts: SessionOptions): Promise<BrowserSession> {
    this.assertReadyForRealDriver();
    if (opts.profileDirHint) {
      throw new Error(
        'MacCuaBrowserProvider controls the operator browser and does not accept profileDirHint.',
      );
    }
    const runId =
      opts.metering?.auditRunId || makeAuditRunId('mac-cua-browser');
    const launched = await this.driver.startBrowserSession({
      bundleId: this.bundleId,
      backgroundSafe: true,
    });
    const session = new MacCuaBrowserSession(
      this.driver,
      launched.sessionId,
      this.browserName,
      this.bundleId,
      opts.metering,
      runId,
      this.screenshotMode,
      this.options.allowPrivateNetwork,
      this.audit,
    );
    this.activeSessions.set(session, {
      sessionId: launched.sessionId,
      metering: opts.metering,
      runId,
    });
    this.recordSessionStarted(opts.metering, runId);
    return session;
  }

  getCapabilities(): BrowserProviderCapabilities {
    this.assertReadyForRealDriver();
    return DEFAULT_BROWSER_PROVIDER_CAPABILITIES;
  }

  async closeSession(session: BrowserSession): Promise<void> {
    if (!(session instanceof MacCuaBrowserSession)) {
      throw new Error('MacCuaBrowserProvider can only close its own sessions');
    }
    const active = this.activeSessions.get(session);
    if (!active) {
      throw new Error('MacCuaBrowserProvider session is not active');
    }
    this.activeSessions.delete(session);
    await this.driver.stopBrowserSession(active.sessionId);
    this.recordSessionEnded(active);
  }

  private recordSessionStarted(
    metering: BrowserSessionMeteringContext | undefined,
    runId: string,
  ): void {
    if (!metering?.sessionId) return;
    this.audit({
      sessionId: metering.sessionId,
      runId,
      event: {
        type: 'browser.session_started',
        provider: 'mac-cua',
        browser: this.browserName,
        bundleId: this.bundleId,
        backgroundSafe: true,
      },
    });
  }

  private recordSessionEnded(active: ActiveMacCuaSession): void {
    if (!active.metering?.sessionId) return;
    this.audit({
      sessionId: active.metering.sessionId,
      runId: active.runId,
      event: {
        type: 'browser.session_ended',
        provider: 'mac-cua',
        browser: this.browserName,
        bundleId: this.bundleId,
        endedAt: new Date().toISOString(),
      },
    });
  }

  private assertReadyForRealDriver(): void {
    if (this.options.driver) return;
    const blocking = buildCuaMacResults().find(
      (result) => result.severity !== 'ok',
    );
    if (!blocking) return;
    throw new Error(
      `MacCuaBrowserProvider is not ready to advertise or launch: ${blocking.label}: ${blocking.message}`,
    );
  }
}
