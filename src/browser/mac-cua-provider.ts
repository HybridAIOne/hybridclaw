import { Buffer } from 'node:buffer';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
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

type JsonRpcMessage = {
  id: number;
  method: string;
  params?: unknown;
};

type ActiveMacCuaSession = {
  sessionId: string;
  metering: BrowserSessionMeteringContext | undefined;
  runId: string;
};

const SHELL_INJECTION_PATTERNS = [
  /\b(?:curl|wget)\b[\s\S]{0,240}\|\s*(?:bash|sh)\b/iu,
  /\bsudo\s+rm\s+-rf\b/iu,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*;\s*\}\s*;/u,
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
const DEFAULT_DRIVER_TIMEOUT_MS = 30_000;

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

class StdioMacCuaDriver implements MacCuaDriver {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private buffer = '';

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly timeoutMs = DEFAULT_DRIVER_TIMEOUT_MS,
  ) {}

  async startBrowserSession(params: {
    bundleId: string;
    backgroundSafe: true;
  }): Promise<{ sessionId: string; windowId?: string | number }> {
    const result = await this.call('browser.start', params);
    if (!result || typeof result !== 'object') {
      throw new Error('mac-cua driver returned an invalid start response.');
    }
    const record = result as Record<string, unknown>;
    if (typeof record.sessionId !== 'string' || !record.sessionId.trim()) {
      throw new Error(
        'mac-cua driver start response did not include sessionId.',
      );
    }
    return {
      sessionId: record.sessionId,
      ...(typeof record.windowId === 'string' ||
      typeof record.windowId === 'number'
        ? { windowId: record.windowId }
        : {}),
    };
  }

  async stopBrowserSession(sessionId: string): Promise<void> {
    await this.call('browser.stop', { sessionId });
  }

  async keyChord(
    sessionId: string,
    params: { key: string; modifiers: string[] },
  ): Promise<void> {
    await this.call('input.key_chord', { sessionId, ...params });
  }

  async pressKey(sessionId: string, key: string): Promise<void> {
    await this.call('input.press_key', { sessionId, key });
  }

  async typeTextChars(
    sessionId: string,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<void> {
    await this.call('input.type_text_chars', { sessionId, ...payload });
  }

  async click(sessionId: string, target: MacCuaTarget): Promise<void> {
    await this.call('input.click', { sessionId, target });
  }

  async setValue(
    sessionId: string,
    target: MacCuaTarget,
    payload: { text: string } | { secretRef: SecretRef },
  ): Promise<void> {
    await this.call('ax.set_value', { sessionId, target, ...payload });
  }

  async scroll(
    sessionId: string,
    params: { target?: MacCuaTarget; deltaX: number; deltaY: number },
  ): Promise<void> {
    await this.call('input.scroll', { sessionId, ...params });
  }

  async screenshot(
    sessionId: string,
    opts: ScreenshotOptions & { mode: MacCuaScreenshotMode },
  ): Promise<MacCuaScreenshotResult> {
    const result = await this.call('browser.screenshot', {
      sessionId,
      ...opts,
    });
    if (!result || typeof result !== 'object') {
      throw new Error(
        'mac-cua driver returned an invalid screenshot response.',
      );
    }
    const record = result as Record<string, unknown>;
    if (typeof record.dataBase64 !== 'string') {
      throw new Error(
        'mac-cua driver screenshot response did not include dataBase64.',
      );
    }
    return {
      dataBase64: record.dataBase64,
      ...(typeof record.mimeType === 'string'
        ? { mimeType: record.mimeType }
        : {}),
    };
  }

  async waitForElement(
    sessionId: string,
    target: MacCuaTarget,
    opts?: WaitOptions,
  ): Promise<void> {
    await this.call('ax.wait_for_element', { sessionId, target, opts });
  }

  async getAddressBarValue(sessionId: string): Promise<string | null> {
    const result = await this.call('browser.address_bar_value', { sessionId });
    if (!result || typeof result !== 'object') return null;
    const value = (result as Record<string, unknown>).value;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  async getCurrentUrl(sessionId: string): Promise<string | null> {
    const result = await this.call('browser.current_url', { sessionId });
    if (!result || typeof result !== 'object') return null;
    const value = (result as Record<string, unknown>).url;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  async detectTwoFactorWaypoint(
    sessionId: string,
  ): Promise<{ detected: boolean; signals?: string[] }> {
    const result = await this.call('ax.detect_two_factor_waypoint', {
      sessionId,
    });
    if (!result || typeof result !== 'object') return { detected: false };
    const record = result as Record<string, unknown>;
    const signals = Array.isArray(record.signals)
      ? record.signals.filter(
          (value): value is string => typeof value === 'string',
        )
      : undefined;
    return {
      detected: record.detected === true,
      ...(signals && signals.length > 0 ? { signals } : {}),
    };
  }

  async getEnvironmentState(): Promise<MacCuaEnvironmentState> {
    const result = await this.call('system.environment_state');
    if (!result || typeof result !== 'object') {
      throw new Error('mac-cua driver returned an invalid environment state.');
    }
    return result as MacCuaEnvironmentState;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) return;
    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child.stdout.setEncoding('utf-8');
    this.child.stdout.on('data', (chunk) => this.handleStdout(String(chunk)));
    this.child.stderr.on('data', (chunk) => {
      process.stderr.write(`[mac-cua] ${String(chunk)}`);
    });
    this.child.on('exit', (code, signal) => {
      const error = new Error(
        signal
          ? `mac-cua driver exited after ${signal}`
          : `mac-cua driver exited with code ${code ?? 'unknown'}`,
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
      this.child = null;
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = typeof message.id === 'number' ? message.id : null;
      if (id === null) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(String(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private async call(method: string, params?: unknown): Promise<unknown> {
    await this.ensureStarted();
    if (!this.child) throw new Error('mac-cua driver is not running.');
    const id = this.nextId++;
    const message: JsonRpcMessage = { id, method, params };
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `mac-cua driver call ${method} timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child?.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          const pending = this.pending.get(id);
          if (pending) clearTimeout(pending.timeout);
          this.pending.delete(id);
          reject(error);
        }
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
    const target = parseMacCuaTarget(selector);
    await this.runAction('click', async () => {
      await this.driver.click(this.sessionId, target);
    });
  }

  async fill(selector: string, value: string | SecretRef): Promise<void> {
    const target = parseMacCuaTarget(selector);
    const payload =
      typeof value === 'string'
        ? driverPayloadForText(value)
        : (() => {
            const hardened = hardenSecretRef(value);
            return {
              secretRef: { source: hardened.source, id: hardened.id },
            };
          })();
    await this.runAction('fill', async () => {
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
      await this.driver.scroll(this.sessionId, {
        ...(opts.selector ? { target: parseMacCuaTarget(opts.selector) } : {}),
        ...delta,
      });
    });
  }

  async waitForSelector(selector: string, opts?: WaitOptions): Promise<void> {
    const target = parseMacCuaTarget(selector);
    await this.runAction('wait_for_selector', async () => {
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
