import { Buffer } from 'node:buffer';
import { assertBrowserNavigationUrl } from '../../container/shared/browser-navigation.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { recordUsageEvent } from '../memory/db.js';
import {
  type SecretHandle,
  withSecretHeader,
} from '../security/secret-handles.js';
import {
  hardenSecretRef,
  resolveSecretHandleInput,
  type SecretRef,
} from '../security/secret-refs.js';
import {
  fillBrowserField,
  loadPlaywrightModule,
  noopSecretAudit,
  normalizeScrollDelta,
  type PlaywrightContextShape,
  type PlaywrightPageShape,
  type PlaywrightSecretFillLocator,
  toNavigationOptions,
} from './playwright-utils.js';
import type {
  BrowserConsoleMessage,
  BrowserEvaluateFunction,
  BrowserFillInput,
  BrowserProvider,
  BrowserProviderCapabilities,
  BrowserSession,
  BrowserSessionMeteringContext,
  BrowserWaypointEvent,
  BrowserWaypointOptions,
  ClickOptions,
  ConsoleMessageOptions,
  HistoryNavigationOptions,
  NavigateOptions,
  PdfOptions,
  ScreenshotOptions,
  ScrollOptions,
  SessionOptions,
  WaitOptions,
} from './provider.js';
import { DEFAULT_BROWSER_PROVIDER_CAPABILITIES } from './provider.js';

type ManagedCloudFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

type ManagedCloudPage = PlaywrightPageShape & {
  locator(selector: string): PlaywrightSecretFillLocator & {
    evaluate<TArg>(
      fn: (element: Element, arg: TArg) => void,
      arg: TArg,
    ): Promise<void>;
  };
};

type ManagedCloudBrowser = {
  contexts(): PlaywrightContextShape<ManagedCloudPage>[];
  close(): Promise<void>;
};

export type ManagedCloudPlaywrightModule = {
  chromium: {
    connectOverCDP(
      endpointURL: string,
      options?: { headers?: Record<string, string> },
    ): Promise<ManagedCloudBrowser>;
  };
};

export interface ManagedCloudBrowserPricing {
  actionUsd: number;
}

export interface ManagedCloudBrowserProviderOptions {
  endpointUrl?: string;
  poolTokenRef?: SecretRef;
  defaultTenantId?: string;
  allowPrivateNetwork?: boolean;
  fetch?: ManagedCloudFetch;
  playwright?: ManagedCloudPlaywrightModule;
  pricing?: Partial<ManagedCloudBrowserPricing>;
  secretAudit?: (handle: SecretHandle, reason: string) => void;
}

interface ManagedCloudLeaseResponse {
  leaseId: string;
  nodeId: string;
  cdpUrl: string;
  startedAt: string | null;
  expiresAt: string | null;
  costUsd: number | null;
}

interface ManagedCloudNavigationResponse {
  verdict: 'allow' | 'deny';
  url: string;
  reason: string | null;
  matchedRule: unknown;
}

interface ManagedCloudReleaseResponse {
  leaseId: string;
  endedAt: string | null;
  costUsd: number | null;
}

interface ActiveManagedCloudSession {
  lease: ManagedCloudLeaseResponse;
  browser: ManagedCloudBrowser;
  metering: RequiredMeteringContext;
  accruedCostUsd: number;
  runId: string;
}

type RequiredMeteringContext = BrowserSessionMeteringContext & {
  sessionId: string;
  agentId: string;
  tenantId: string;
};

const DEFAULT_ENDPOINT_URL = 'http://127.0.0.1:8787';
const DEFAULT_PRICING: ManagedCloudBrowserPricing = {
  actionUsd: 0,
};

export function normalizeManagedCloudEndpointUrl(endpointUrl?: string): string {
  return (endpointUrl || DEFAULT_ENDPOINT_URL).replace(/\/+$/u, '');
}

function toRecord(payload: unknown, context: string): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(
      `Managed browser ${context} returned a non-object response.`,
    );
  }
  return payload as Record<string, unknown>;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readOptionalCost(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeLeaseResponse(payload: unknown): ManagedCloudLeaseResponse {
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

function normalizeNavigationResponse(
  payload: unknown,
  fallbackUrl: string,
): ManagedCloudNavigationResponse {
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

function normalizeReleaseResponse(
  payload: unknown,
  leaseId: string,
): ManagedCloudReleaseResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { leaseId, endedAt: null, costUsd: null };
  }
  const record = payload as Record<string, unknown>;
  return {
    leaseId: readOptionalString(record, 'leaseId') || leaseId,
    endedAt: readOptionalString(record, 'endedAt'),
    costUsd: readOptionalCost(record, 'costUsd'),
  };
}

async function loadPlaywright(
  injected?: ManagedCloudPlaywrightModule,
): Promise<ManagedCloudPlaywrightModule> {
  return await loadPlaywrightModule(
    injected,
    (cause) =>
      `Playwright is not available for managed browser cloud CDP connection. Cause: ${cause}`,
  );
}

class ManagedCloudBrowserSession implements BrowserSession {
  private sessionLostRecorded = false;
  private readonly consoleLog: BrowserConsoleMessage[] = [];

  constructor(
    private readonly page: ManagedCloudPage,
    private readonly lease: ManagedCloudLeaseResponse,
    private readonly metering: RequiredMeteringContext,
    private readonly runId: string,
    private readonly recordAction: (name: string) => void,
    private readonly checkNavigation: (
      url: string,
      action: string,
      method?: string,
    ) => Promise<ManagedCloudNavigationResponse>,
    private readonly allowPrivateNetwork: boolean | undefined,
    private readonly secretAudit?: (
      handle: SecretHandle,
      reason: string,
    ) => void,
  ) {
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

  async evaluate<T>(fn: BrowserEvaluateFunction<T>): Promise<T> {
    return await this.runSessionAction('evaluate', () =>
      this.page.evaluate(fn),
    );
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    const bytes = await this.runSessionAction('screenshot', () =>
      this.page.screenshot({
        fullPage: opts?.fullPage,
        type: opts?.type,
      }),
    );
    recordAuditEvent({
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

  async navigate(url: string, opts?: NavigateOptions): Promise<void> {
    await this.runSessionAction('navigate', async () => {
      const parsed = await assertBrowserNavigationUrl(url, {
        allowPrivateNetwork: this.allowPrivateNetwork,
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
      await this.page.goto(guard.url, toNavigationOptions(opts));
    });
  }

  async back(opts?: HistoryNavigationOptions): Promise<void> {
    await this.runSessionAction('back', async () => {
      await this.page.goBack(toNavigationOptions(opts));
      await this.auditHistoryNavigation('back');
    });
  }

  async forward(opts?: HistoryNavigationOptions): Promise<void> {
    await this.runSessionAction('forward', async () => {
      await this.page.goForward(toNavigationOptions(opts));
      await this.auditHistoryNavigation('forward');
    });
  }

  async reload(opts?: HistoryNavigationOptions): Promise<void> {
    await this.runSessionAction('reload', async () => {
      await this.page.reload(toNavigationOptions(opts));
      await this.auditHistoryNavigation('reload');
    });
  }

  async click(selector: string, opts?: ClickOptions): Promise<void> {
    await this.runSessionAction('click', () =>
      this.page.click(selector, { timeout: opts?.timeoutMs }),
    );
  }

  async fill(selector: string, value: BrowserFillInput): Promise<void> {
    await this.runSessionAction('fill', () =>
      fillBrowserField(
        this.page,
        selector,
        value,
        this.secretAudit,
        this.metering,
      ),
    );
  }

  async scroll(opts: ScrollOptions): Promise<void> {
    await this.runSessionAction('scroll', async () => {
      const delta = normalizeScrollDelta(opts);
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

  async waitForSelector(selector: string, opts?: WaitOptions): Promise<void> {
    await this.runSessionAction('wait_for_selector', () =>
      this.page.waitForSelector(selector, {
        state: opts?.state,
        timeout: opts?.timeoutMs,
      }),
    );
  }

  async upload(selector: string, files: string[]): Promise<void> {
    await this.runSessionAction('upload', async () => {
      if (typeof this.page.setInputFiles !== 'function') {
        throw new Error(
          'Managed browser CDP page does not support file uploads.',
        );
      }
      await this.page.setInputFiles(selector, files);
    });
  }

  async pdf(opts?: PdfOptions): Promise<Buffer> {
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

  async consoleMessages(
    opts?: ConsoleMessageOptions,
  ): Promise<BrowserConsoleMessage[]> {
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

  async waypoint(
    event: BrowserWaypointEvent,
    opts?: BrowserWaypointOptions,
  ): Promise<void> {
    await this.runSessionAction(event, async () => {
      recordAuditEvent({
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

  private async runSessionAction<T>(
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.recordAction(action);
    try {
      return await operation();
    } catch (error) {
      this.recordSessionLost(action, error);
      throw error;
    }
  }

  private recordSessionLost(action: string, error: unknown): void {
    if (this.sessionLostRecorded || !isLikelySessionLostError(error)) return;
    this.sessionLostRecorded = true;
    recordAuditEvent({
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

  private async auditHistoryNavigation(action: string): Promise<void> {
    const url = this.page.url();
    if (!url || url === 'about:blank') return;
    const parsed = await assertBrowserNavigationUrl(url, {
      allowPrivateNetwork: this.allowPrivateNetwork,
    });
    const guard = await this.checkNavigation(parsed.toString(), action, 'GET');
    if (guard.verdict !== 'allow') {
      throw new Error(
        `Managed browser history navigation blocked by guard: ${guard.reason || guard.verdict}`,
      );
    }
  }
}

function isLikelySessionLostError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:target closed|browser has been closed|context.*closed|websocket|socket hang up|econnreset|econnrefused|connection.*closed|cdp)/iu.test(
    message,
  );
}

export class ManagedCloudBrowserProvider implements BrowserProvider {
  private readonly activeSessions = new WeakMap<
    ManagedCloudBrowserSession,
    ActiveManagedCloudSession
  >();
  private readonly endpointUrl: string;
  private readonly pricing: ManagedCloudBrowserPricing;
  private cachedAuthHeaders: Record<string, string> | null = null;

  constructor(
    private readonly options: ManagedCloudBrowserProviderOptions = {},
  ) {
    this.endpointUrl = normalizeManagedCloudEndpointUrl(options.endpointUrl);
    this.pricing = {
      ...DEFAULT_PRICING,
      ...options.pricing,
    };
  }

  async launchSession(opts: SessionOptions): Promise<BrowserSession> {
    if (opts.profileDirHint) {
      throw new Error(
        'ManagedCloudBrowserProvider does not accept local profileDirHint paths; profile persistence is owned by the managed pool.',
      );
    }
    const metering = this.resolveMetering(opts);
    const lease = await this.createLease(metering, opts);
    let browser: ManagedCloudBrowser | null = null;
    try {
      const playwright = await loadPlaywright(this.options.playwright);
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
      const runId = metering.auditRunId ?? makeAuditRunId('managed_browser');
      const session = new ManagedCloudBrowserSession(
        page,
        lease,
        metering,
        runId,
        (name) => this.recordActionUsage(metering, name),
        (url, action, method) =>
          this.checkNavigation(lease, metering, runId, url, action, method),
        this.options.allowPrivateNetwork,
        this.options.secretAudit,
      );

      const startingCostUsd = lease.costUsd ?? 0;
      this.recordUsage(metering, {
        model: 'managed-cloud-browser/session',
        costUsd: startingCostUsd,
        toolCalls: 0,
      });
      recordAuditEvent({
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

  getCapabilities(): BrowserProviderCapabilities {
    return DEFAULT_BROWSER_PROVIDER_CAPABILITIES;
  }

  async closeSession(session: BrowserSession): Promise<void> {
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
    recordAuditEvent({
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

    const errors: unknown[] = [];
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

  private resolveMetering(opts: SessionOptions): RequiredMeteringContext {
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

  private authHeaders(): Record<string, string> {
    if (this.cachedAuthHeaders) return this.cachedAuthHeaders;
    if (!this.options.poolTokenRef) return {};
    const ref = hardenSecretRef(this.options.poolTokenRef);
    const handle = resolveSecretHandleInput(ref, {
      path: 'ManagedCloudBrowserProvider.poolTokenRef',
      required: true,
      sinkKind: 'http',
    });
    if (!handle) {
      throw new Error('Managed browser pool token did not resolve.');
    }
    const header = withSecretHeader(handle, 'Authorization', {
      prefix: 'Bearer',
      audit: this.options.secretAudit || noopSecretAudit,
    });
    this.cachedAuthHeaders = { [header.name]: header.value };
    return this.cachedAuthHeaders;
  }

  private async createLease(
    metering: RequiredMeteringContext,
    opts: SessionOptions,
  ): Promise<ManagedCloudLeaseResponse> {
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

  private async checkNavigation(
    lease: ManagedCloudLeaseResponse,
    metering: RequiredMeteringContext,
    runId: string,
    url: string,
    action: string,
    method = 'GET',
  ): Promise<ManagedCloudNavigationResponse> {
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
    recordAuditEvent({
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

  private async releaseLease(
    leaseId: string,
  ): Promise<ManagedCloudReleaseResponse> {
    const payload = await this.requestJson(
      `/leases/${encodeURIComponent(leaseId)}`,
      {
        method: 'DELETE',
      },
    );
    return normalizeReleaseResponse(payload, leaseId);
  }

  private async requestJson(
    path: string,
    init: { method: string; body?: string },
  ): Promise<unknown> {
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
    let payload: unknown = null;
    if (text.trim()) {
      try {
        payload = JSON.parse(text) as unknown;
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

  private recordActionUsage(
    metering: RequiredMeteringContext,
    actionName: string,
  ): void {
    if (this.pricing.actionUsd <= 0) return;
    this.recordUsage(metering, {
      model: `managed-cloud-browser/action:${actionName}`,
      costUsd: this.pricing.actionUsd,
      toolCalls: 1,
    });
  }

  private recordCloseUsage(
    active: ActiveManagedCloudSession,
    release: ManagedCloudReleaseResponse | null,
  ): void {
    const sessionCostUsd = release?.costUsd ?? active.accruedCostUsd;
    const deltaUsd = Math.max(0, sessionCostUsd - active.accruedCostUsd);
    if (deltaUsd <= 0) return;
    this.recordUsage(active.metering, {
      model: 'managed-cloud-browser/session',
      costUsd: deltaUsd,
      toolCalls: 0,
    });
  }

  private recordUsage(
    metering: RequiredMeteringContext,
    params: {
      model: string;
      costUsd: number;
      toolCalls: number;
    },
  ): void {
    recordUsageEvent({
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
