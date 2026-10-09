/**
 * Managed-cloud browser provider — leases Chromium workers from an
 * operator-run HybridClaw browser pool (`infra/managed-browser`) and drives
 * them over CDP. Every navigation passes the core private-network guard and
 * then the pool's tenant navigation guard; leases are audited and metered.
 * NOT Browser Use Cloud (a third-party API without HybridClaw's guard).
 */
import { Buffer } from 'node:buffer';

const DEFAULT_ENDPOINT_URL = 'http://127.0.0.1:8787';
const DEFAULT_PRICING = {
  actionUsd: 0,
};

/** The pool's bearer header, or none for a pool without a token. */
export function poolAuthHeaders(poolToken) {
  return poolToken ? { Authorization: `Bearer ${poolToken}` } : {};
}

export function normalizeManagedCloudEndpointUrl(endpointUrl) {
  // A scan instead of /\/+$/, which backtracks polynomially on many slashes.
  const url = endpointUrl || DEFAULT_ENDPOINT_URL;
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

function toRecord(payload, context) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(
      `Managed browser ${context} returned a non-object response.`,
    );
  }
  return payload;
}

function readOptionalString(record, key) {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readOptionalCost(record, key) {
  const value = record[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeLeaseResponse(payload) {
  const record = toRecord(payload, 'pool lease');
  const leaseId = readOptionalString(record, 'leaseId');
  const nodeId = readOptionalString(record, 'nodeId');
  const cdpUrl = readOptionalString(record, 'cdpUrl');
  if (!leaseId || !nodeId || !cdpUrl) {
    throw new Error(
      'Managed browser pool lease response requires leaseId, nodeId, and cdpUrl.',
    );
  }
  const parsed = new URL(cdpUrl);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(
      'Managed browser pool returned an invalid cdpUrl; expected a ws:// or wss:// URL.',
    );
  }
  return {
    leaseId,
    nodeId,
    cdpUrl: parsed.toString(),
    startedAt: readOptionalString(record, 'startedAt'),
    expiresAt: readOptionalString(record, 'expiresAt'),
    costUsd: readOptionalCost(record, 'costUsd'),
  };
}

function normalizeNavigationResponse(payload, fallbackUrl) {
  const record = toRecord(payload, 'navigation guard');
  const verdict = readOptionalString(record, 'verdict');
  if (verdict !== 'allow' && verdict !== 'deny') {
    throw new Error(
      'Managed browser navigation guard response requires verdict allow or deny.',
    );
  }
  return {
    verdict,
    url: readOptionalString(record, 'url') || fallbackUrl,
    reason: readOptionalString(record, 'reason'),
    matchedRule: record.matchedRule ?? null,
  };
}

function normalizeReleaseResponse(payload, leaseId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { leaseId, endedAt: null, costUsd: null };
  }
  const record = payload;
  return {
    leaseId: readOptionalString(record, 'leaseId') || leaseId,
    endedAt: readOptionalString(record, 'endedAt'),
    costUsd: readOptionalCost(record, 'costUsd'),
  };
}

async function loadPlaywright(host, injected) {
  if (injected) return injected;
  return await host.playwright.load(
    (cause) =>
      `Playwright is not available for managed browser cloud CDP connection. Cause: ${cause}`,
  );
}

class ManagedCloudBrowserSession {
  sessionLostRecorded = false;
  consoleLog = [];

  constructor(
    page,
    lease,
    metering,
    runId,
    recordAction,
    checkNavigation,
    host,
  ) {
    this.page = page;
    this.lease = lease;
    this.metering = metering;
    this.runId = runId;
    this.recordAction = recordAction;
    this.checkNavigation = checkNavigation;
    this.host = host;
    this.page.on?.('console', (message) => {
      this.consoleLog.push({
        level: message.type(),
        text: message.text(),
        timestamp: Date.now(),
      });
      if (this.consoleLog.length > 500) {
        this.consoleLog.splice(0, this.consoleLog.length - 500);
      }
    });
  }

  async evaluate(fn) {
    return await this.runSessionAction('evaluate', () =>
      this.page.evaluate(fn),
    );
  }

  async screenshot(opts) {
    const bytes = await this.runSessionAction('screenshot', () =>
      this.page.screenshot({
        fullPage: opts?.fullPage,
        type: opts?.type,
      }),
    );
    this.host.audit.record({
      sessionId: this.metering.sessionId,
      runId: this.runId,
      event: {
        type: 'browser.screenshot_taken',
        provider: 'managed-cloud',
        leaseId: this.lease.leaseId,
        tenantId: this.metering.tenantId,
        artifactRef: null,
        path: null,
      },
    });
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  }

  async navigate(url, opts) {
    await this.runSessionAction('navigate', async () => {
      const parsed = await this.host.navigation.assertUrl(url, {
        allowPrivateNetwork: this.host.allowPrivateNetwork,
      });
      const guard = await this.checkNavigation(
        parsed.toString(),
        'goto',
        'GET',
      );
      if (guard.verdict !== 'allow') {
        throw new Error(
          `Managed browser navigation blocked by guard: ${guard.reason || guard.verdict}`,
        );
      }
      await this.page.goto(
        guard.url,
        this.host.playwright.toNavigationOptions(opts),
      );
    });
  }

  async back(opts) {
    await this.runSessionAction('back', async () => {
      await this.page.goBack(this.host.playwright.toNavigationOptions(opts));
      await this.auditHistoryNavigation('back');
    });
  }

  async forward(opts) {
    await this.runSessionAction('forward', async () => {
      await this.page.goForward(this.host.playwright.toNavigationOptions(opts));
      await this.auditHistoryNavigation('forward');
    });
  }

  async reload(opts) {
    await this.runSessionAction('reload', async () => {
      await this.page.reload(this.host.playwright.toNavigationOptions(opts));
      await this.auditHistoryNavigation('reload');
    });
  }

  async click(selector, opts) {
    await this.runSessionAction('click', () =>
      this.page.click(selector, { timeout: opts?.timeoutMs }),
    );
  }

  async fill(selector, value) {
    await this.runSessionAction('fill', () =>
      this.host.playwright.fillField(
        this.page,
        selector,
        value,
        this.host.secretAudit,
        this.metering,
      ),
    );
  }

  async scroll(opts) {
    await this.runSessionAction('scroll', async () => {
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
    });
  }

  async waitForSelector(selector, opts) {
    await this.runSessionAction('wait_for_selector', () =>
      this.page.waitForSelector(selector, {
        state: opts?.state,
        timeout: opts?.timeoutMs,
      }),
    );
  }

  async upload(selector, files) {
    await this.runSessionAction('upload', async () => {
      if (typeof this.page.setInputFiles !== 'function') {
        throw new Error(
          'Managed browser CDP page does not support file uploads.',
        );
      }
      await this.page.setInputFiles(selector, files);
    });
  }

  async pdf(opts) {
    return await this.runSessionAction('pdf', async () => {
      if (typeof this.page.pdf !== 'function') {
        throw new Error(
          'Managed browser CDP page does not support PDF generation.',
        );
      }
      const bytes = await this.page.pdf({
        printBackground: opts?.printBackground,
        format: opts?.format,
      });
      return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    });
  }

  async consoleMessages(opts) {
    return await this.runSessionAction('console_messages', async () => {
      const limit =
        typeof opts?.limit === 'number' && Number.isFinite(opts.limit)
          ? Math.max(0, Math.floor(opts.limit))
          : 200;
      const messages = this.consoleLog.slice(-limit);
      if (opts?.clear) this.consoleLog.length = 0;
      return messages;
    });
  }

  async waypoint(event, opts) {
    await this.runSessionAction(event, async () => {
      this.host.audit.record({
        sessionId: this.metering.sessionId,
        runId: this.runId,
        event: {
          type: 'browser.waypoint',
          provider: 'managed-cloud',
          tenantId: this.metering.tenantId,
          leaseId: this.lease.leaseId,
          poolNodeId: this.lease.nodeId,
          waypoint: event,
          modality: opts?.modality || null,
          prompt: opts?.prompt || null,
          suspendedSessionId: opts?.sessionId || null,
          responseKind: opts?.responseKind || null,
        },
      });
    });
  }

  async runSessionAction(action, operation) {
    this.recordAction(action);
    try {
      return await operation();
    } catch (error) {
      this.recordSessionLost(action, error);
      throw error;
    }
  }

  recordSessionLost(action, error) {
    if (this.sessionLostRecorded || !isLikelySessionLostError(error)) return;
    this.sessionLostRecorded = true;
    this.host.audit.record({
      sessionId: this.metering.sessionId,
      runId: this.runId,
      event: {
        type: 'browser.session_lost',
        provider: 'managed-cloud',
        tenantId: this.metering.tenantId,
        leaseId: this.lease.leaseId,
        poolNodeId: this.lease.nodeId,
        action,
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }

  async auditHistoryNavigation(action) {
    const url = this.page.url();
    if (!url || url === 'about:blank') return;
    const parsed = await this.host.navigation.assertUrl(url, {
      allowPrivateNetwork: this.host.allowPrivateNetwork,
    });
    const guard = await this.checkNavigation(parsed.toString(), action, 'GET');
    if (guard.verdict !== 'allow') {
      throw new Error(
        `Managed browser history navigation blocked by guard: ${guard.reason || guard.verdict}`,
      );
    }
  }
}

function isLikelySessionLostError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:target closed|browser has been closed|context.*closed|websocket|socket hang up|econnreset|econnrefused|connection.*closed|cdp)/iu.test(
    message,
  );
}

export class ManagedCloudBrowserProvider {
  activeSessions = new WeakMap();

  constructor(options) {
    this.options = options;
    this.host = options.host;
    this.endpointUrl = normalizeManagedCloudEndpointUrl(options.endpointUrl);
    this.pricing = {
      ...DEFAULT_PRICING,
      ...options.pricing,
    };
  }

  async launchSession(opts) {
    if (opts.profileDirHint) {
      throw new Error(
        'ManagedCloudBrowserProvider does not accept local profileDirHint paths; profile persistence is owned by the managed pool.',
      );
    }
    const metering = this.resolveMetering(opts);
    const lease = await this.createLease(metering, opts);
    let browser = null;
    try {
      const playwright = await loadPlaywright(
        this.host,
        this.options.playwright,
      );
      const authHeaders = this.authHeaders();
      browser =
        Object.keys(authHeaders).length > 0
          ? await playwright.chromium.connectOverCDP(lease.cdpUrl, {
              headers: authHeaders,
            })
          : await playwright.chromium.connectOverCDP(lease.cdpUrl);
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error(
          'Managed browser cloud CDP connection did not expose a browser context.',
        );
      }
      const page = context.pages()[0] || (await context.newPage());
      const runId =
        metering.auditRunId ?? this.host.audit.makeRunId('managed_browser');
      const session = new ManagedCloudBrowserSession(
        page,
        lease,
        metering,
        runId,
        (name) => this.recordActionUsage(metering, name),
        (url, action, method) =>
          this.checkNavigation(lease, metering, runId, url, action, method),
        this.host,
      );

      const startingCostUsd = lease.costUsd ?? 0;
      this.recordUsage(metering, {
        model: 'managed-cloud-browser/session',
        costUsd: startingCostUsd,
        toolCalls: 0,
      });
      this.host.audit.record({
        sessionId: metering.sessionId,
        runId,
        event: {
          type: 'browser.session_started',
          provider: 'managed-cloud',
          tenantId: metering.tenantId,
          leaseId: lease.leaseId,
          poolNodeId: lease.nodeId,
          startedAt: lease.startedAt,
          expiresAt: lease.expiresAt,
          pricing: {
            actionUsd: this.pricing.actionUsd,
          },
        },
      });
      this.activeSessions.set(session, {
        lease,
        browser,
        metering,
        accruedCostUsd: startingCostUsd,
        runId,
      });
      return session;
    } catch (error) {
      if (browser) await browser.close().catch(() => undefined);
      await this.releaseLease(lease.leaseId).catch(() => undefined);
      throw error;
    }
  }

  getCapabilities() {
    return this.host.capabilities;
  }

  async closeSession(session) {
    if (!(session instanceof ManagedCloudBrowserSession)) {
      throw new Error(
        'ManagedCloudBrowserProvider can only close its own sessions',
      );
    }
    const active = this.activeSessions.get(session);
    if (!active) {
      throw new Error('ManagedCloudBrowserProvider session is not active');
    }

    const [releaseResult, closeResult] = await Promise.allSettled([
      this.releaseLease(active.lease.leaseId),
      active.browser.close(),
    ]);
    const release =
      releaseResult.status === 'fulfilled' ? releaseResult.value : null;
    this.recordCloseUsage(active, release);
    this.host.audit.record({
      sessionId: active.metering.sessionId,
      runId: active.runId,
      event: {
        type: 'browser.session_ended',
        provider: 'managed-cloud',
        tenantId: active.metering.tenantId,
        leaseId: active.lease.leaseId,
        poolNodeId: active.lease.nodeId,
        endedAt: release?.endedAt ?? null,
      },
    });
    this.activeSessions.delete(session);

    const errors = [];
    if (releaseResult.status === 'rejected') errors.push(releaseResult.reason);
    if (closeResult.status === 'rejected') errors.push(closeResult.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'Failed to release managed browser lease and close CDP browser.',
      );
    }
  }

  resolveMetering(opts) {
    const metering = opts.metering;
    const sessionId = metering?.sessionId?.trim();
    const agentId = metering?.agentId?.trim();
    const tenantId =
      metering?.tenantId?.trim() ||
      this.options.defaultTenantId?.trim() ||
      agentId;
    if (!sessionId || !agentId || !tenantId) {
      throw new Error(
        'ManagedCloudBrowserProvider requires metering.sessionId and metering.agentId.',
      );
    }
    return {
      sessionId,
      agentId,
      tenantId,
      auditRunId: metering?.auditRunId?.trim() || undefined,
      skillName: metering?.skillName?.trim() || undefined,
    };
  }

  authHeaders() {
    return poolAuthHeaders(this.options.getPoolToken?.());
  }

  async createLease(metering, opts) {
    const timeoutMs = opts.timeoutMs;
    const ttlSeconds =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
        ? Math.max(1, Math.ceil(timeoutMs / 1000))
        : undefined;
    const payload = await this.requestJson('/leases', {
      method: 'POST',
      body: JSON.stringify({
        tenantId: metering.tenantId,
        agentId: metering.agentId,
        sessionId: metering.sessionId,
        auditRunId: metering.auditRunId ?? null,
        ttlSeconds,
      }),
    });
    return normalizeLeaseResponse(payload);
  }

  async checkNavigation(lease, metering, runId, url, action, method = 'GET') {
    const guard = normalizeNavigationResponse(
      await this.requestJson(
        `/leases/${encodeURIComponent(lease.leaseId)}/navigation`,
        {
          method: 'POST',
          body: JSON.stringify({
            tenantId: metering.tenantId,
            agentId: metering.agentId,
            sessionId: metering.sessionId,
            url,
            method,
          }),
        },
      ),
      url,
    );
    this.host.audit.record({
      sessionId: metering.sessionId,
      runId,
      event: {
        type: 'browser.navigation',
        provider: 'managed-cloud',
        tenantId: metering.tenantId,
        leaseId: lease.leaseId,
        poolNodeId: lease.nodeId,
        url: guard.url,
        action,
        method,
        verdict: guard.verdict,
        reason: guard.reason,
        matchedRule: guard.matchedRule,
      },
    });
    return guard;
  }

  async releaseLease(leaseId) {
    const payload = await this.requestJson(
      `/leases/${encodeURIComponent(leaseId)}`,
      {
        method: 'DELETE',
      },
    );
    return normalizeReleaseResponse(payload, leaseId);
  }

  async requestJson(path, init) {
    const requestFetch = this.options.fetch || fetch;
    const response = await requestFetch(`${this.endpointUrl}${path}`, {
      method: init.method,
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
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
        `Managed browser pool ${init.method} ${path} failed with HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`,
      );
    }
    return payload;
  }

  recordActionUsage(metering, actionName) {
    if (this.pricing.actionUsd <= 0) return;
    this.recordUsage(metering, {
      model: `managed-cloud-browser/action:${actionName}`,
      costUsd: this.pricing.actionUsd,
      toolCalls: 1,
    });
  }

  recordCloseUsage(active, release) {
    const sessionCostUsd = release?.costUsd ?? active.accruedCostUsd;
    const deltaUsd = Math.max(0, sessionCostUsd - active.accruedCostUsd);
    if (deltaUsd <= 0) return;
    this.recordUsage(active.metering, {
      model: 'managed-cloud-browser/session',
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
