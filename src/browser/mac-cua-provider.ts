import { Buffer } from 'node:buffer';
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
import {
  type MacCuaDriver,
  type MacCuaEnvironmentState,
  type MacCuaScreenshotMode,
  type MacCuaScreenshotResult,
  type MacCuaTarget,
  resolveMacCuaDriverCommand,
  StdioMacCuaDriver,
} from './mac-cua-driver.js';
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

// What an action needs from the controlled window: 'loads' brings its own
// page (navigate), 'current' acts on the open page, 'none' never touches it.
type MacCuaPageUse = 'loads' | 'current' | 'none';

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
    await this.runAction(
      'navigate',
      async () => {
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
      },
      'loads',
    );
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
    let strategy = selector ? 'ax-selector' : 'native-focus';
    await this.runAction('browser_resume_interaction', async () => {
      const payload = this.buildFillPayload(
        selector || 'detected 2FA input',
        value,
      );
      if (selector) {
        const target = await this.resolveActionTarget(
          'browser_resume_interaction',
          selector,
          parseMacCuaTarget(selector),
        );
        if ('secretRef' in payload) {
          await this.assertSecretFillAllowed(selector, payload.secretRef);
        }
        await this.driver.click(this.sessionId, target);
        await this.driver.typeTextChars(this.sessionId, payload);
        await this.driver.pressKey(this.sessionId, 'return');
        if ('secretRef' in payload) {
          this.recordCredentialFilled(selector, payload.secretRef);
        }
        return;
      }

      if (this.driver.fillTwoFactorInput) {
        const filled = await this.driver.fillTwoFactorInput(
          this.sessionId,
          payload,
        );
        if (filled) {
          strategy = 'native-set-value';
          await this.driver.pressKey(this.sessionId, 'return');
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
      await this.driver.pressKey(this.sessionId, 'return');
    });
    return { ...(selector ? { selector } : {}), strategy, submitted: true };
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
    await this.runAction(
      event,
      async () => {
        this.recordWaypoint(event, opts);
        this.awaitingTwoFactor = event === 'browser_await_two_factor';
        if (event === 'browser_resume_interaction') {
          this.awaitingTwoFactor = false;
          this.lastTwoFactorState = null;
        }
      },
      'none',
    );
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
    page: MacCuaPageUse = 'current',
  ): Promise<T> {
    const before = await this.driver.getEnvironmentState();
    try {
      const result = await this.runInSessionWindow(action, run, page);
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

  // The operator or the browser can close the controlled window at any time.
  // cua-driver sends keys to the browser process, so keys meant for a closed
  // window reach whichever window has focus: check, and reopen, before every
  // action. Only navigation reruns in the new window (once); other actions
  // would act on its blank start page, so they fail and ask for a navigate.
  private async runInSessionWindow<T>(
    action: string,
    run: () => Promise<T>,
    page: MacCuaPageUse,
  ): Promise<T> {
    if (page === 'none') return await run();
    const reopened = await this.driver.ensureSessionWindow(this.sessionId);
    if (reopened && page === 'current') throw this.windowReopenedError(action);
    try {
      return await run();
    } catch (error) {
      // Ask the driver whether the window closed mid-action rather than
      // parsing its error text.
      if (
        reopened ||
        !(await this.driver.ensureSessionWindow(this.sessionId))
      ) {
        throw error;
      }
      if (page === 'current') throw this.windowReopenedError(action);
      return await run();
    }
  }

  private windowReopenedError(action: string): Error {
    return new Error(
      `mac-cua ${this.browserName} window was closed, so a new one was opened; navigate to the page again before retrying ${action}.`,
    );
  }

  private assertBackgroundSafe(
    before: MacCuaEnvironmentState | undefined,
    after: MacCuaEnvironmentState | undefined,
  ): void {
    if (!before || !after) return;
    if (after.frontmostBundleId === this.bundleId) return;
    if (
      before.frontmostBundleId === after.frontmostBundleId &&
      before.activeSpaceId === after.activeSpaceId
    ) {
      return;
    }
    throw new Error(
      'mac-cua driver violated background-safe contract by changing frontmost app or active Space',
    );
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
    // The browser window title is the page title; it needs no page JS.
    const title = await this.driver.getWindowTitle(this.sessionId);
    if (!result.detected) {
      return { detected: false, url, title };
    }
    return {
      detected: true,
      modality: 'totp',
      signals: result.signals || ['ax_two_factor_text'],
      url,
      title,
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
