/**
 * Browser Use Cloud provider — leases a remote Chromium from the Browser Use
 * Cloud API and drives it over CDP from the gateway. Every session is audited
 * and metered into UsageTotals, so it refuses to launch without a session and
 * agent id. NOT the managed-cloud pool (operator-run, with its own guard).
 */
import { Buffer } from 'node:buffer';

const DEFAULT_BASE_URL = 'https://api.browser-use.com/api/v4';
const DEFAULT_BROWSER_USE_CLOUD_PRICING = {
  // Browser Use Cloud documents browser sessions at $0.02/hour.
  browserUsdPerMinute: 0.02 / 60,
  actionUsd: 0,
};
const MINIMUM_BILLED_MINUTES = 1;
const MAX_BROWSER_TIMEOUT_MINUTES = 240;

function normalizeBaseUrl(baseUrl) {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/u, '');
}

// The session lifetime comes from `browser.timeoutMinutes` only:
// SessionOptions.timeoutMs bounds the launch (the gateway passes 60s), and
// reading it here gave every gateway session a 1-minute lifetime.
function normalizeTimeoutMinutes(browserConfig) {
  const raw = browserConfig.timeoutMinutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.max(1, Math.min(MAX_BROWSER_TIMEOUT_MINUTES, Math.ceil(raw)));
}

function parseCloudCost(value) {
  const cost = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

function estimateBilledCost(params) {
  const elapsedMs = Math.max(0, params.nowMs - params.startedAtMs);
  const billedMinutes = Math.max(
    MINIMUM_BILLED_MINUTES,
    Math.ceil(elapsedMs / 60_000),
  );
  return billedMinutes * params.pricing.browserUsdPerMinute;
}

function buildCreateBrowserBody(browserConfig) {
  const timeout = normalizeTimeoutMinutes(browserConfig);
  const body = {};
  if (browserConfig.profileId !== undefined) {
    body.profileId = browserConfig.profileId;
  }
  if (browserConfig.proxyCountryCode !== undefined) {
    body.proxyCountryCode = browserConfig.proxyCountryCode;
  }
  if (timeout !== undefined) {
    body.timeout = timeout;
  }
  if (browserConfig.browserScreenWidth !== undefined) {
    body.browserScreenWidth = browserConfig.browserScreenWidth;
  }
  if (browserConfig.browserScreenHeight !== undefined) {
    body.browserScreenHeight = browserConfig.browserScreenHeight;
  }
  if (browserConfig.allowResizing !== undefined) {
    body.allowResizing = browserConfig.allowResizing;
  }
  if (browserConfig.enableRecording !== undefined) {
    body.enableRecording = browserConfig.enableRecording;
  }
  return body;
}

function readOptionalString(record, key) {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readCloudCostValue(record, key) {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function normalizeCloudSessionResponse(payload, path, method) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(
      `Browser Use Cloud API ${method} ${path} returned a non-object response.`,
    );
  }

  const record = payload;
  const id = readOptionalString(record, 'id');
  if (!id) {
    throw new Error(
      `Browser Use Cloud API ${method} ${path} returned a response without a valid id.`,
    );
  }

  return {
    id,
    status: readOptionalString(record, 'status') || 'unknown',
    timeoutAt: readOptionalString(record, 'timeoutAt'),
    startedAt: readOptionalString(record, 'startedAt'),
    liveUrl: readOptionalString(record, 'liveUrl'),
    cdpUrl: readOptionalString(record, 'cdpUrl'),
    finishedAt: readOptionalString(record, 'finishedAt'),
    proxyCost: readCloudCostValue(record, 'proxyCost'),
    browserCost: readCloudCostValue(record, 'browserCost'),
    recordingUrl: readOptionalString(record, 'recordingUrl'),
  };
}

function normalizeCloudCdpUrl(cdpUrl) {
  if (!cdpUrl) {
    throw new Error('Browser Use Cloud session did not return a cdpUrl.');
  }
  let parsed;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new Error(
      'Browser Use Cloud session returned an invalid cdpUrl; expected a ws:// or wss:// URL.',
    );
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(
      'Browser Use Cloud session returned an invalid cdpUrl; expected a ws:// or wss:// URL.',
    );
  }
  return parsed.toString();
}

async function loadPlaywright(host, injected) {
  if (injected) return injected;
  return await host.playwright.load(
    (cause) =>
      `Playwright is not available for Browser Use Cloud CDP connection. Cause: ${cause}`,
  );
}

class BrowserUseCloudSession {
  constructor(page, recordAction, metering, host) {
    this.page = page;
    this.recordAction = recordAction;
    this.metering = metering;
    this.host = host;
  }

  async evaluate(fn) {
    this.recordAction('evaluate');
    return await this.page.evaluate(fn);
  }

  async screenshot(opts) {
    this.recordAction('screenshot');
    const bytes = await this.page.screenshot({
      fullPage: opts?.fullPage,
      type: opts?.type,
    });
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  }

  async navigate(url, opts) {
    this.recordAction('navigate');
    const parsed = await this.host.navigation.assertUrl(url, {
      allowPrivateNetwork: this.host.allowPrivateNetwork,
    });
    await this.page.goto(
      parsed.toString(),
      this.host.playwright.toNavigationOptions(opts),
    );
  }

  async back(opts) {
    this.recordAction('back');
    await this.page.goBack(this.host.playwright.toNavigationOptions(opts));
  }

  async forward(opts) {
    this.recordAction('forward');
    await this.page.goForward(this.host.playwright.toNavigationOptions(opts));
  }

  async reload(opts) {
    this.recordAction('reload');
    await this.page.reload(this.host.playwright.toNavigationOptions(opts));
  }

  async click(selector, opts) {
    this.recordAction('click');
    await this.page.click(selector, { timeout: opts?.timeoutMs });
  }

  async fill(selector, value) {
    this.recordAction('fill');
    await this.host.playwright.fillField(
      this.page,
      selector,
      value,
      this.host.secretAudit,
      this.metering,
    );
  }

  async scroll(opts) {
    this.recordAction('scroll');
    const delta = this.host.playwright.normalizeScrollDelta(opts);
    if (opts.selector) {
      await this.page
        .locator(opts.selector)
        .evaluate((element, scrollDelta) => {
          element.scrollBy(scrollDelta.deltaX, scrollDelta.deltaY);
        }, delta);
      return;
    }

    await this.page.mouse.wheel(delta.deltaX, delta.deltaY);
  }

  async waitForSelector(selector, opts) {
    this.recordAction('wait_for_selector');
    await this.page.waitForSelector(selector, {
      state: opts?.state,
      timeout: opts?.timeoutMs,
    });
  }
}

export class BrowserUseCloudProvider {
  activeSessions = new WeakMap();

  constructor(options) {
    this.options = options;
    this.host = options.host;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.pricing = {
      ...DEFAULT_BROWSER_USE_CLOUD_PRICING,
      ...options.pricing,
    };
  }

  async launchSession(opts) {
    if (opts.profileDirHint) {
      throw new Error(
        'BrowserUseCloudProvider does not accept local profileDirHint paths; configure a Browser Use Cloud profileId instead.',
      );
    }
    const metering = this.resolveMetering(opts);

    const apiKey = this.resolveApiKey();
    const cloud = await this.createCloudSession(apiKey);
    let browser = null;
    try {
      const cdpUrl = normalizeCloudCdpUrl(cloud.cdpUrl);

      const playwright = await loadPlaywright(
        this.host,
        this.options.playwright,
      );
      browser = await playwright.chromium.connectOverCDP(cdpUrl);
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error(
          'Browser Use Cloud CDP connection did not expose a browser context.',
        );
      }
      const page = context.pages()[0] || (await context.newPage());
      const runId =
        metering.auditRunId ?? this.host.audit.makeRunId('browser_use_cloud');
      const session = new BrowserUseCloudSession(
        page,
        (name) => this.recordActionUsage(metering, name),
        metering,
        this.host,
      );

      const startedAtMs = Date.parse(cloud.startedAt || '') || Date.now();
      const startingCostUsd = estimateBilledCost({
        startedAtMs,
        nowMs: startedAtMs,
        pricing: this.pricing,
      });
      this.recordUsage(metering, {
        model: 'browser-use-cloud/session',
        costUsd: startingCostUsd,
        toolCalls: 0,
      });
      this.host.audit.record({
        sessionId: metering.sessionId,
        runId,
        event: {
          type: 'browser.session_started',
          provider: 'browser-use-cloud',
          providerSessionId: cloud.id,
          sessionUrl: cloud.liveUrl || null,
          startedAt: cloud.startedAt || null,
          timeoutAt: cloud.timeoutAt || null,
          pricing: {
            browserUsdPerMinute: this.pricing.browserUsdPerMinute,
            actionUsd: this.pricing.actionUsd,
          },
        },
      });

      this.activeSessions.set(session, {
        cloud,
        browser,
        apiKey,
        metering,
        startedAtMs,
        accruedCostUsd: startingCostUsd,
      });
      return session;
    } catch (error) {
      await this.cleanupFailedLaunch(apiKey, cloud, browser);
      throw error;
    }
  }

  getCapabilities() {
    return this.host.capabilities;
  }

  async closeSession(session) {
    if (!(session instanceof BrowserUseCloudSession)) {
      throw new Error(
        'BrowserUseCloudProvider can only close its own sessions',
      );
    }
    const active = this.activeSessions.get(session);
    if (!active) {
      throw new Error('BrowserUseCloudProvider session is not active');
    }

    const [stopResult, closeResult] = await Promise.allSettled([
      this.stopCloudSession(active.apiKey, active.cloud.id),
      active.browser.close(),
    ]);
    const stopped = stopResult.status === 'fulfilled' ? stopResult.value : null;

    this.recordCloseUsage(active, stopped);
    this.activeSessions.delete(session);
    const errors = [];
    if (stopResult.status === 'rejected') errors.push(stopResult.reason);
    if (closeResult.status === 'rejected') errors.push(closeResult.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'Failed to stop Browser Use Cloud session and close CDP browser.',
      );
    }
  }

  resolveApiKey() {
    const apiKey = this.options.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Browser Use Cloud API key is not set. Store it with `hybridclaw secret set BROWSER_USE_API_KEY <key>`.',
      );
    }
    return apiKey;
  }

  resolveMetering(opts) {
    const metering = opts.metering;
    if (!metering?.sessionId?.trim() || !metering.agentId?.trim()) {
      throw new Error(
        'BrowserUseCloudProvider requires metering.sessionId and metering.agentId so every cloud session is audited and recorded in UsageTotals.',
      );
    }
    return {
      sessionId: metering.sessionId.trim(),
      agentId: metering.agentId.trim(),
      auditRunId: metering.auditRunId?.trim() || undefined,
      skillName: metering.skillName?.trim() || undefined,
    };
  }

  async createCloudSession(apiKey) {
    return await this.requestJson(apiKey, '/browsers', {
      method: 'POST',
      body: JSON.stringify(buildCreateBrowserBody(this.options.browser || {})),
    });
  }

  async cleanupFailedLaunch(apiKey, cloud, browser) {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await this.stopCloudSession(apiKey, cloud.id).catch(() => {});
  }

  async stopCloudSession(apiKey, providerSessionId) {
    return await this.requestJson(
      apiKey,
      `/browsers/${encodeURIComponent(providerSessionId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action: 'stop' }),
      },
    );
  }

  async requestJson(apiKey, path, init) {
    const requestFetch = this.options.fetch || fetch;
    const response = await requestFetch(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Browser-Use-API-Key': apiKey,
      },
      body: init.body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let payload = null;
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      throw new Error(
        `Browser Use Cloud API ${init.method} ${path} failed with HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`,
      );
    }

    return normalizeCloudSessionResponse(payload, path, init.method);
  }

  recordActionUsage(metering, actionName) {
    this.recordUsage(metering, {
      model: `browser-use-cloud/action:${actionName}`,
      costUsd: this.pricing.actionUsd,
      toolCalls: 1,
    });
  }

  recordCloseUsage(active, stopped) {
    const cloudCostUsd =
      parseCloudCost(stopped?.browserCost) + parseCloudCost(stopped?.proxyCost);
    const estimatedCostUsd = estimateBilledCost({
      startedAtMs: active.startedAtMs,
      nowMs: Date.now(),
      pricing: this.pricing,
    });
    const sessionCostUsd = cloudCostUsd > 0 ? cloudCostUsd : estimatedCostUsd;
    const deltaUsd = Math.max(0, sessionCostUsd - active.accruedCostUsd);
    if (deltaUsd <= 0) return;
    this.recordUsage(active.metering, {
      model: 'browser-use-cloud/session',
      costUsd: deltaUsd,
      toolCalls: 0,
    });
  }

  recordUsage(metering, params) {
    this.host.usage.record({
      sessionId: metering.sessionId,
      agentId: metering.agentId,
      model: params.model,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCalls: params.toolCalls,
      costUsd: params.costUsd,
    });
  }
}
