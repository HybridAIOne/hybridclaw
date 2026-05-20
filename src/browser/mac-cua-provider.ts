import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertBrowserNavigationUrl } from '../../container/shared/browser-navigation.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { buildCuaMacResults } from '../doctor/checks/cua-mac.js';
import {
  assertSecretResolveAllowed,
  recordSecretResolved,
} from '../gateway/gateway-secret-injection.js';
import { hardenSecretRef, type SecretRef } from '../security/secret-refs.js';
import { normalizeScrollDelta } from './playwright-utils.js';
import type {
  BrowserEvaluateFunction,
  BrowserProvider,
  BrowserProviderCapabilities,
  BrowserSession,
  BrowserSessionMeteringContext,
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
  ): Promise<{ detected: boolean; signals?: string[] }>;
  getEnvironmentState(): Promise<MacCuaEnvironmentState>;
}

export interface MacCuaProviderOptions {
  browser?: MacCuaBrowserName;
  driver?: MacCuaDriver;
  driverCommand?: string;
  driverArgs?: string[];
  screenshotMode?: MacCuaScreenshotMode;
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
    args: [],
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

function firstElementIndex(record: Record<string, unknown>): number | null {
  const tree = String(record.tree_markdown || record.markdown || '');
  const match = tree.match(/\[element_index\s+(\d+)\]/u);
  return match?.[1] ? Number(match[1]) : null;
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

class StdioMacCuaDriver implements MacCuaDriver {
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
        'mac-cua CLI driver cannot resolve SecretRef payloads directly.',
      );
    }
    session.lastTypedText = payload.text;
    await this.callTool('type_text', {
      pid: session.pid,
      window_id: session.windowId,
      text: payload.text,
    });
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
        'mac-cua CLI driver cannot resolve SecretRef payloads directly.',
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
    const outPath = path.join(
      os.tmpdir(),
      `hybridclaw-mac-cua-${process.pid}-${Date.now()}.png`,
    );
    try {
      if (opts.mode === 'ax') {
        await this.callTool('get_window_state', {
          pid: session.pid,
          window_id: session.windowId,
        });
      } else {
        await this.callTool(
          'screenshot',
          {
            window_id: session.windowId,
            format: opts.type || 'png',
          },
          { screenshotOutFile: outPath },
        );
      }
      if (!fs.existsSync(outPath)) {
        throw new Error(
          'mac-cua driver screenshot response did not include image bytes.',
        );
      }
      return {
        dataBase64: fs.readFileSync(outPath).toString('base64'),
        mimeType: opts.type === 'jpeg' ? 'image/jpeg' : 'image/png',
      };
    } finally {
      fs.rmSync(outPath, { force: true });
    }
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
  ): Promise<{ detected: boolean; signals?: string[] }> {
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
    return detected
      ? { detected: true, signals: ['ax_two_factor_text'] }
      : { detected: false };
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
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error(
        `mac-cua driver tool ${tool} returned non-object output.`,
      );
    }
    return result as Record<string, unknown>;
  }

  private async callToolText(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.callTool(tool, args, { raw: true });
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return typeof result === 'string' ? result : '';
    }
    const content = (result as Record<string, unknown>).content;
    if (!Array.isArray(content)) return '';
    return content
      .map((entry) =>
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).text === 'string'
          ? String((entry as Record<string, unknown>).text)
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }

  private async callTool(
    tool: string,
    args: Record<string, unknown>,
    opts?: { raw?: boolean; screenshotOutFile?: string },
  ): Promise<unknown> {
    const commandArgs = [
      ...this.args,
      'call',
      tool,
      JSON.stringify(args),
      '--compact',
      ...(opts?.raw ? ['--raw'] : []),
      ...(opts?.screenshotOutFile
        ? ['--screenshot-out-file', opts.screenshotOutFile]
        : []),
    ];
    const { stdout, stderr, status, signal } =
      await this.runCommand(commandArgs);
    if (status !== 0) {
      throw new Error(
        `mac-cua driver tool ${tool} failed${
          signal ? ` after ${signal}` : ''
        }: ${stderr || stdout || `exit ${status}`}`,
      );
    }
    const trimmed = stdout.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }

  private async runCommand(args: string[]): Promise<{
    stdout: string;
    stderr: string;
    status: number | null;
    signal: NodeJS.Signals | null;
  }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(
          new Error(
            `mac-cua driver command ${args.join(' ')} timed out after ${
              this.timeoutMs
            }ms`,
          ),
        );
      }, this.timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('exit', (status, signal) => {
        clearTimeout(timeout);
        resolve({ stdout, stderr, status, signal });
      });
    });
  }
}

class MacCuaBrowserSession implements BrowserSession {
  private awaitingTwoFactor = false;

  constructor(
    private readonly driver: MacCuaDriver,
    private readonly sessionId: string,
    private readonly browserName: MacCuaBrowserName,
    private readonly bundleId: string,
    private readonly metering: BrowserSessionMeteringContext | undefined,
    private readonly runId: string,
    private readonly screenshotMode: MacCuaScreenshotMode,
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
      const parsed = await assertBrowserNavigationUrl(url);
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
      await assertBrowserNavigationUrl(addressBarValue);
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

  async fill(selector: string, value: string | SecretRef): Promise<void> {
    const requestedTarget = parseMacCuaTarget(selector);
    await this.runAction('fill', async () => {
      const payload =
        typeof value === 'string'
          ? driverPayloadForText(value)
          : (() => {
              const hardened = hardenSecretRef(value);
              return {
                secretRef: { source: hardened.source, id: hardened.id },
              };
            })();
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

  async waypoint(
    event: BrowserWaypointEvent,
    opts?: BrowserWaypointOptions,
  ): Promise<void> {
    await this.runAction(event, async () => {
      this.recordWaypoint(event, opts);
      this.awaitingTwoFactor = event === 'browser_await_two_factor';
      if (event === 'browser_resume_interaction') {
        this.awaitingTwoFactor = false;
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
      before.cursorX === after.cursorX &&
      before.cursorY === after.cursorY &&
      before.frontmostBundleId === after.frontmostBundleId &&
      before.activeSpaceId === after.activeSpaceId;
    if (!unchanged) {
      throw new Error(
        'mac-cua driver violated background-safe contract by changing cursor, frontmost app, or active Space',
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
    const result = await this.driver.detectTwoFactorWaypoint(this.sessionId);
    if (!result.detected) return;
    this.awaitingTwoFactor = true;
    this.recordWaypoint(
      'browser_await_two_factor',
      { modality: 'mac-cua-ax' },
      { action, signals: result.signals },
    );
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
      const fallback = defaultDriverCommand();
      this.driver = new StdioMacCuaDriver(
        options.driverCommand || fallback.command,
        options.driverArgs || fallback.args,
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
