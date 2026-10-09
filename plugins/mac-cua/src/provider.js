/**
 * mac-cua browser provider — drives the operator's own macOS browser through
 * the Cua Driver's accessibility tree, in a window it opens for the agent.
 * There is no DOM: sessions expose `nativeSnapshot` and AX refs instead of
 * `evaluate`, and every navigation, typed payload, and key chord passes the
 * guards below before it reaches the driver. macOS only.
 */
import { Buffer } from 'node:buffer';
import { resolveMacCuaDriverCommand, StdioMacCuaDriver } from './driver.js';
import { buildCuaMacResults } from './readiness.js';

export const MAC_CUA_BROWSERS = {
  safari: 'com.apple.Safari',
  chrome: 'com.google.Chrome',
  firefox: 'org.mozilla.firefox',
  brave: 'com.brave.Browser',
  arc: 'company.thebrowser.Browser',
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

function normalizeKeyChord(key, modifiers) {
  const normalizedModifiers = modifiers
    .map((modifier) => modifier.trim().toLowerCase())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return [...normalizedModifiers, key.trim().toLowerCase()].join('+');
}

export function assertSafeMacCuaKeyChord(key, modifiers) {
  if (DESTRUCTIVE_KEY_CHORDS.has(normalizeKeyChord(key, modifiers))) {
    throw new Error(
      `mac-cua blocked destructive browser key chord: ${[...modifiers, key].join('+')}`,
    );
  }
}

export function assertSafeMacCuaTypedPayload(text) {
  if (SHELL_INJECTION_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error('mac-cua blocked unsafe typed payload');
  }
}

function normalizeSafeMacCuaPressKey(key) {
  const normalized = String(key || '')
    .trim()
    .toLowerCase();
  const mapped = MAC_CUA_PRESS_KEY_ALIASES.get(normalized) || normalized;
  if (/^[a-z0-9]$/u.test(mapped) || SAFE_MAC_CUA_PRESS_KEYS.has(mapped)) {
    return mapped;
  }
  throw new Error(`mac-cua blocked unsupported key press: ${key}`);
}

function parseMacCuaTarget(selector) {
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

  return { kind: 'query', query: selectorQueryText(raw) };
}

// Models write Playwright selectors (`text=Dashboard`, `a:has-text("Pay")`,
// getByRole('link', { name: 'Pay' })). The AX tree knows labels, not CSS, so
// the label inside is the query.
function selectorQueryText(selector) {
  const quoted = selector.match(
    /(?:^text=|:has-text\(|:contains\(|getByText\(|\bname\s*[:=])\s*(["'`])([\s\S]*?)\1/u,
  );
  if (quoted?.[2]?.trim()) return quoted[2].trim();
  const bare = selector.match(/^text=\s*([\s\S]+)$/u)?.[1] ?? selector;
  return bare
    .trim()
    .replace(/^(["'`])([\s\S]*)\1$/u, '$2')
    .trim();
}

function driverPayloadForText(value) {
  assertSafeMacCuaTypedPayload(value);
  return { text: value };
}

function assertNoUnsupportedNavigationWait(opts) {
  if (!opts) return;
  if (opts.waitUntil || opts.timeoutMs !== undefined) {
    throw new Error(
      'MacCuaBrowserProvider does not support waitUntil or timeoutMs navigation waits until the CUA driver exposes a readiness probe.',
    );
  }
}

function resolveUrlHost(url, selector) {
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
      `browser.fill(${selector}) SecretRef requires a resolvable browser URL for host-scoped secret policy evaluation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function decodeDriverScreenshot(result) {
  try {
    return Buffer.from(result.dataBase64, 'base64');
  } catch (error) {
    throw new Error(
      `mac-cua driver returned an invalid screenshot payload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

class MacCuaBrowserSession {
  // The operator's own browser window on the gateway's desktop.
  headed = true;
  awaitingTwoFactor = false;
  lastTwoFactorState = null;
  lastPage = null;

  constructor(
    driver,
    sessionId,
    browserName,
    bundleId,
    metering,
    runId,
    screenshotMode,
    host,
    audit,
  ) {
    this.driver = driver;
    this.sessionId = sessionId;
    this.browserName = browserName;
    this.bundleId = bundleId;
    this.metering = metering;
    this.runId = runId;
    this.screenshotMode = screenshotMode;
    this.host = host;
    this.audit = audit;
  }

  async evaluate(_fn) {
    throw new Error(
      'MacCuaBrowserProvider does not support DOM evaluate; use screenshot/AX targeting instead.',
    );
  }

  async screenshot(opts) {
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

  async navigate(url, opts) {
    await this.runAction(
      'navigate',
      async () => {
        assertNoUnsupportedNavigationWait(opts);
        const parsed = await this.host.navigation.assertUrl(url, {
          allowPrivateNetwork: this.host.allowPrivateNetwork,
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
        await this.host.navigation.assertUrl(addressBarValue, {
          allowPrivateNetwork: this.host.allowPrivateNetwork,
        });
        await this.driver.pressKey(this.sessionId, 'return');
      },
      'loads',
    );
  }

  async back(opts) {
    await this.runAction('back', async () => {
      assertNoUnsupportedNavigationWait(opts);
      await this.driver.pressHistoryButton(this.sessionId, 'back');
    });
  }

  async forward(opts) {
    await this.runAction('forward', async () => {
      assertNoUnsupportedNavigationWait(opts);
      await this.driver.pressHistoryButton(this.sessionId, 'forward');
    });
  }

  async reload(opts) {
    await this.runAction('reload', async () => {
      assertNoUnsupportedNavigationWait(opts);
      await this.keyChord('r', ['cmd']);
    });
  }

  async click(selector, _opts) {
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

  async press(key) {
    const normalizedKey = normalizeSafeMacCuaPressKey(key);
    await this.runAction('press', async () => {
      await this.driver.pressKey(this.sessionId, normalizedKey);
    });
  }

  async fill(selector, value) {
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

  async fillTwoFactorCode(value) {
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

  buildFillPayload(selector, value) {
    if (typeof value === 'string') return driverPayloadForText(value);
    if (this.host.secrets.isHandle(value)) {
      try {
        return driverPayloadForText(
          this.host.secrets.unsafeEscape(value, {
            reason: `fill browser field ${selector}`,
            audit: (handle, reason) => {
              this.host.secrets.recordUnsafeEscaped({
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
    const hardened = this.host.secrets.hardenRef(value);
    return {
      secretRef: { source: hardened.source, id: hardened.id },
    };
  }

  async scroll(opts) {
    const delta = this.host.playwright.normalizeScrollDelta(opts);
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

  async waitForSelector(selector, opts) {
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

  async nativeSnapshot(opts) {
    const readPage = this.driver.readPage?.bind(this.driver);
    if (!readPage) {
      throw new Error(
        'mac-cua driver cannot read the page accessibility tree.',
      );
    }
    const page = await this.runAction('snapshot', () =>
      readPage(this.sessionId, opts),
    );
    const title = await this.driver.getWindowTitle(this.sessionId);
    this.lastPage = { url: page.url || '', title };
    return {
      url: page.url || '',
      title,
      snapshot: page.snapshot,
      truncated: page.truncated,
      elementCount: page.elementCount,
      refs: page.refs,
    };
  }

  async liveFrame(opts) {
    // The action before already probed the window, 2FA and the URL; doing
    // that again would add seconds to every click.
    const image = opts.image
      ? decodeDriverScreenshot(
          await this.driver.screenshot(this.sessionId, {
            type: 'jpeg',
            quality: opts.quality,
            mode: 'vision',
          }),
        )
      : undefined;
    let page = this.lastPage;
    if (!page) {
      const url = await this.driver
        .getCurrentUrl(this.sessionId)
        .catch(() => null);
      page = {
        url: url || '',
        title: await this.driver.getWindowTitle(this.sessionId),
      };
      this.lastPage = page;
    }
    return { ...page, ...(image ? { image } : {}) };
  }

  async inspectTwoFactorChallenge() {
    if (this.awaitingTwoFactor && this.lastTwoFactorState?.detected) {
      return this.lastTwoFactorState;
    }
    const state = await this.detectCurrentTwoFactorState();
    if (state.detected) {
      this.lastTwoFactorState = state;
    }
    return state;
  }

  async waypoint(event, opts) {
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

  async keyChord(key, modifiers) {
    assertSafeMacCuaKeyChord(key, modifiers);
    await this.driver.keyChord(this.sessionId, { key, modifiers });
  }

  async resolveActionTarget(action, selector, requestedTarget) {
    if (requestedTarget.kind === 'point') {
      throw new Error(
        'mac-cua pixel targeting is only allowed as an AX-resolution fallback.',
      );
    }
    const resolved = await this.driver.resolveTarget(
      this.sessionId,
      requestedTarget,
      action === 'fill' ? 'fill' : 'click',
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

  async runAction(action, run, page = 'current') {
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
  async runInSessionWindow(action, run, page) {
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

  windowReopenedError(action) {
    return new Error(
      `mac-cua ${this.browserName} window was closed, so a new one was opened; navigate to the page again before retrying ${action}.`,
    );
  }

  assertBackgroundSafe(before, after) {
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

  recordAction(action, status, error) {
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

  recordScreenshotTaken(opts) {
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

  recordWaypoint(event, opts, detection) {
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

  recordPixelFallback(action, selector, target, reason) {
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

  async recordDetectedTwoFactor(action) {
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

  async detectCurrentTwoFactorState() {
    if (!this.driver.detectTwoFactorWaypoint) return { detected: false };
    const result = await this.driver.detectTwoFactorWaypoint(this.sessionId);
    const url = await this.driver
      .getCurrentUrl(this.sessionId)
      .catch(() => null);
    // The browser window title is the page title; it needs no page JS.
    const title = await this.driver.getWindowTitle(this.sessionId);
    this.lastPage = { url: url || '', title };
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

  recordCredentialFilled(selector, ref) {
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

  async assertSecretFillAllowed(selector, ref) {
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
    this.host.secrets.assertResolveAllowed({
      sessionId: this.metering?.sessionId,
      agentId: this.metering?.agentId,
      skillName,
      secretSource: ref.source,
      secretId: ref.id,
      sinkKind: 'dom',
      host,
      selector,
    });
    this.host.secrets.recordResolved({
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

export class MacCuaBrowserProvider {
  activeSessions = new WeakMap();

  constructor(options) {
    this.options = options;
    this.host = options.host;
    this.browserName = options.browser || 'chrome';
    this.bundleId = MAC_CUA_BROWSERS[this.browserName];
    this.screenshotMode = options.screenshotMode || 'som';
    this.audit = options.audit || this.host.audit.record;
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
        this.host.mcp.load,
        options.driverTimeoutMs,
      );
    }
  }

  async launchSession(opts) {
    this.assertReadyForRealDriver();
    if (opts.profileDirHint) {
      throw new Error(
        'MacCuaBrowserProvider controls the operator browser and does not accept profileDirHint.',
      );
    }
    const runId =
      opts.metering?.auditRunId || this.host.audit.makeRunId('mac-cua-browser');
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
      this.host,
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

  getCapabilities() {
    this.assertReadyForRealDriver();
    return this.host.capabilities;
  }

  async closeSession(session) {
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

  recordSessionStarted(metering, runId) {
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

  recordSessionEnded(active) {
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

  assertReadyForRealDriver() {
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
