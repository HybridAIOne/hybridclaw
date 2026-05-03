import { Buffer } from 'node:buffer';
import { assertBrowserNavigationUrl } from '../../container/shared/browser-navigation.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { recordUsageEvent } from '../memory/db.js';
import type { SecretHandle } from '../security/secret-handles.js';
import {
  resolveSecretInputUnsafe,
  type SecretInput,
  type SecretRef,
} from '../security/secret-refs.js';
import type {
  BrowserEvaluateFunction,
  BrowserProvider,
  BrowserSession,
  BrowserSessionMeteringContext,
  ClickOptions,
  HistoryNavigationOptions,
  NavigateOptions,
  ScreenshotOptions,
  ScrollOptions,
  SessionOptions,
  WaitOptions,
} from './provider.js';

type BrowserUseCloudFetch = (
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

type BrowserUseCloudPage = {
  evaluate<T>(fn: BrowserEvaluateFunction<T>): Promise<T>;
  screenshot(opts?: {
    fullPage?: boolean;
    type?: 'png' | 'jpeg';
  }): Promise<Buffer | Uint8Array>;
  goto(
    url: string,
    opts?: { waitUntil?: NavigateOptions['waitUntil']; timeout?: number },
  ): Promise<unknown>;
  goBack(opts?: {
    waitUntil?: NavigateOptions['waitUntil'];
    timeout?: number;
  }): Promise<unknown>;
  goForward(opts?: {
    waitUntil?: NavigateOptions['waitUntil'];
    timeout?: number;
  }): Promise<unknown>;
  reload(opts?: {
    waitUntil?: NavigateOptions['waitUntil'];
    timeout?: number;
  }): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  mouse: {
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  waitForSelector(
    selector: string,
    opts?: { state?: WaitOptions['state']; timeout?: number },
  ): Promise<unknown>;
  locator(selector: string): {
    evaluate<TArg>(
      fn: (element: Element, arg: TArg) => void,
      arg: TArg,
    ): Promise<void>;
  };
};

type BrowserUseCloudContext = {
  pages(): BrowserUseCloudPage[];
  newPage(): Promise<BrowserUseCloudPage>;
};

type BrowserUseCloudBrowser = {
  contexts(): BrowserUseCloudContext[];
  close(): Promise<void>;
};

export type BrowserUseCloudPlaywrightModule = {
  chromium: {
    connectOverCDP(endpointURL: string): Promise<BrowserUseCloudBrowser>;
  };
};

export interface BrowserUseCloudSessionConfig {
  profileId?: string | null;
  proxyCountryCode?: string | null;
  timeoutMinutes?: number;
  browserScreenWidth?: number;
  browserScreenHeight?: number;
  allowResizing?: boolean;
  enableRecording?: boolean;
}

export interface BrowserUseCloudPricing {
  browserUsdPerMinute: number;
  actionUsd: number;
}

export interface BrowserUseCloudCapabilityMatrixEntry {
  provider: 'browser-use-cloud';
  pricing: BrowserUseCloudPricing;
  capabilities: {
    cdp: true;
    liveReplayUrl: true;
    recording: true;
  };
}

export interface BrowserUseCloudProviderOptions {
  apiKeyRef?: SecretRef;
  baseUrl?: string;
  browser?: BrowserUseCloudSessionConfig;
  fetch?: BrowserUseCloudFetch;
  metering?: BrowserSessionMeteringContext;
  playwright?: BrowserUseCloudPlaywrightModule;
  pricing?: Partial<BrowserUseCloudPricing>;
  secretAudit?: (handle: SecretHandle, reason: string) => void;
}

interface BrowserUseCloudSessionResponse {
  id: string;
  status: string;
  timeoutAt?: string | null;
  startedAt?: string | null;
  liveUrl?: string | null;
  cdpUrl?: string | null;
  finishedAt?: string | null;
  proxyCost?: string | number | null;
  browserCost?: string | number | null;
  recordingUrl?: string | null;
}

interface ActiveCloudSession {
  cloud: BrowserUseCloudSessionResponse;
  browser: BrowserUseCloudBrowser;
  metering: BrowserSessionMeteringContext;
  startedAtMs: number;
  accruedCostUsd: number;
}

const DEFAULT_BASE_URL = 'https://api.browser-use.com/api/v3';
const DEFAULT_API_KEY_REF: SecretRef = {
  source: 'env',
  id: 'BROWSER_USE_API_KEY',
};
const DEFAULT_SCROLL_DELTA = 800;
export const BROWSER_USE_CLOUD_CAPABILITY_MATRIX: BrowserUseCloudCapabilityMatrixEntry =
  {
    provider: 'browser-use-cloud',
    pricing: {
      // Browser Use Cloud documents Pay As You Go browser sessions at $0.06/hour.
      browserUsdPerMinute: 0.001,
      actionUsd: 0,
    },
    capabilities: {
      cdp: true,
      liveReplayUrl: true,
      recording: true,
    },
  };
const MAX_BROWSER_TIMEOUT_MINUTES = 240;
const noopSecretAudit = () => {};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/u, '');
}

function normalizeTimeoutMinutes(
  opts: SessionOptions,
  browserConfig: BrowserUseCloudSessionConfig,
): number | undefined {
  const raw =
    typeof browserConfig.timeoutMinutes === 'number'
      ? browserConfig.timeoutMinutes
      : typeof opts.timeoutMs === 'number'
        ? Math.ceil(opts.timeoutMs / 60_000)
        : undefined;
  if (raw == null || !Number.isFinite(raw)) return undefined;
  return Math.max(1, Math.min(MAX_BROWSER_TIMEOUT_MINUTES, Math.ceil(raw)));
}

function toNavigationOptions(
  opts?: NavigateOptions | HistoryNavigationOptions,
): { waitUntil?: NavigateOptions['waitUntil']; timeout?: number } | undefined {
  if (!opts) return undefined;
  return {
    waitUntil: opts.waitUntil,
    timeout: opts.timeoutMs,
  };
}

function normalizeScrollDelta(opts: ScrollOptions): {
  deltaX: number;
  deltaY: number;
} {
  const explicitDeltaX = typeof opts.deltaX === 'number';
  const explicitDeltaY = typeof opts.deltaY === 'number';
  if (explicitDeltaX || explicitDeltaY) {
    return {
      deltaX: explicitDeltaX ? opts.deltaX || 0 : 0,
      deltaY: explicitDeltaY ? opts.deltaY || 0 : 0,
    };
  }

  switch (opts.direction) {
    case 'up':
      return { deltaX: 0, deltaY: -DEFAULT_SCROLL_DELTA };
    case 'left':
      return { deltaX: -DEFAULT_SCROLL_DELTA, deltaY: 0 };
    case 'right':
      return { deltaX: DEFAULT_SCROLL_DELTA, deltaY: 0 };
    default:
      return { deltaX: 0, deltaY: DEFAULT_SCROLL_DELTA };
  }
}

function parseCloudCost(value: unknown): number {
  const cost = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

function estimateBilledCost(params: {
  startedAtMs: number;
  nowMs: number;
  pricing: BrowserUseCloudPricing;
}): number {
  const elapsedMs = Math.max(0, params.nowMs - params.startedAtMs);
  const billedMinutes = Math.max(1, Math.ceil(elapsedMs / 60_000));
  return billedMinutes * params.pricing.browserUsdPerMinute;
}

function buildCreateBrowserBody(
  opts: SessionOptions,
  browserConfig: BrowserUseCloudSessionConfig,
): Record<string, unknown> {
  const timeout = normalizeTimeoutMinutes(opts, browserConfig);
  return {
    ...(browserConfig.profileId !== undefined
      ? { profileId: browserConfig.profileId }
      : {}),
    ...(browserConfig.proxyCountryCode !== undefined
      ? { proxyCountryCode: browserConfig.proxyCountryCode }
      : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(browserConfig.browserScreenWidth !== undefined
      ? { browserScreenWidth: browserConfig.browserScreenWidth }
      : {}),
    ...(browserConfig.browserScreenHeight !== undefined
      ? { browserScreenHeight: browserConfig.browserScreenHeight }
      : {}),
    ...(browserConfig.allowResizing !== undefined
      ? { allowResizing: browserConfig.allowResizing }
      : {}),
    ...(browserConfig.enableRecording !== undefined
      ? { enableRecording: browserConfig.enableRecording }
      : {}),
  };
}

async function loadPlaywright(
  injected?: BrowserUseCloudPlaywrightModule,
): Promise<BrowserUseCloudPlaywrightModule> {
  if (injected) return injected;
  try {
    return (await import('playwright')) as BrowserUseCloudPlaywrightModule;
  } catch (error) {
    throw new Error(
      `Playwright is not available for Browser Use Cloud CDP connection. Cause: ${errorMessage(error)}`,
    );
  }
}

class BrowserUseCloudSession implements BrowserSession {
  constructor(
    private readonly page: BrowserUseCloudPage,
    private readonly recordAction: (name: string) => void,
    private readonly secretAudit?: (
      handle: SecretHandle,
      reason: string,
    ) => void,
  ) {}

  async evaluate<T>(fn: BrowserEvaluateFunction<T>): Promise<T> {
    this.recordAction('evaluate');
    return await this.page.evaluate(fn);
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    this.recordAction('screenshot');
    const bytes = await this.page.screenshot({
      fullPage: opts?.fullPage,
      type: opts?.type,
    });
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  }

  async navigate(url: string, opts?: NavigateOptions): Promise<void> {
    this.recordAction('navigate');
    const parsed = await assertBrowserNavigationUrl(url);
    await this.page.goto(parsed.toString(), toNavigationOptions(opts));
  }

  async back(opts?: HistoryNavigationOptions): Promise<void> {
    this.recordAction('back');
    await this.page.goBack(toNavigationOptions(opts));
  }

  async forward(opts?: HistoryNavigationOptions): Promise<void> {
    this.recordAction('forward');
    await this.page.goForward(toNavigationOptions(opts));
  }

  async reload(opts?: HistoryNavigationOptions): Promise<void> {
    this.recordAction('reload');
    await this.page.reload(toNavigationOptions(opts));
  }

  async click(selector: string, opts?: ClickOptions): Promise<void> {
    this.recordAction('click');
    await this.page.click(selector, { timeout: opts?.timeoutMs });
  }

  async fill(selector: string, value: SecretInput): Promise<void> {
    this.recordAction('fill');
    let resolved: string;
    if (typeof value === 'string') {
      resolved = value;
    } else {
      const resolvedSecret = resolveSecretInputUnsafe(value, {
        path: `browser.fill(${selector})`,
        required: true,
        reason: `fill browser field ${selector}`,
        audit: this.secretAudit || noopSecretAudit,
      });
      if (resolvedSecret == null) {
        throw new Error(`browser.fill(${selector}) secret did not resolve`);
      }
      resolved = resolvedSecret;
    }
    await this.page.fill(selector, resolved);
  }

  async scroll(opts: ScrollOptions): Promise<void> {
    this.recordAction('scroll');
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
  }

  async waitForSelector(selector: string, opts?: WaitOptions): Promise<void> {
    this.recordAction('wait_for_selector');
    await this.page.waitForSelector(selector, {
      state: opts?.state,
      timeout: opts?.timeoutMs,
    });
  }
}

export class BrowserUseCloudProvider implements BrowserProvider {
  private readonly activeSessions = new WeakMap<
    BrowserUseCloudSession,
    ActiveCloudSession
  >();
  private readonly baseUrl: string;
  private readonly pricing: BrowserUseCloudPricing;

  constructor(private readonly options: BrowserUseCloudProviderOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.pricing = {
      ...BROWSER_USE_CLOUD_CAPABILITY_MATRIX.pricing,
      ...options.pricing,
    };
  }

  async launchSession(opts: SessionOptions): Promise<BrowserSession> {
    if (opts.profileDirHint) {
      throw new Error(
        'BrowserUseCloudProvider does not accept local profileDirHint paths; configure a Browser Use Cloud profileId instead.',
      );
    }
    const metering = this.resolveMetering(opts);

    const apiKey = this.resolveApiKey();
    const cloud = await this.createCloudSession(apiKey, opts);
    if (!cloud.cdpUrl) {
      throw new Error('Browser Use Cloud session did not return a cdpUrl.');
    }

    const playwright = await loadPlaywright(this.options.playwright);
    const browser = await playwright.chromium.connectOverCDP(cloud.cdpUrl);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => {});
      throw new Error(
        'Browser Use Cloud CDP connection did not expose a browser context.',
      );
    }
    const page = context.pages()[0] || (await context.newPage());
    const runId = metering.auditRunId || makeAuditRunId('browser_use_cloud');
    const session = new BrowserUseCloudSession(
      page,
      (name) => this.recordActionUsage(metering, name),
      this.options.secretAudit,
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
    recordAuditEvent({
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
      metering,
      startedAtMs,
      accruedCostUsd: startingCostUsd,
    });
    return session;
  }

  async closeSession(session: BrowserSession): Promise<void> {
    if (!(session instanceof BrowserUseCloudSession)) {
      throw new Error(
        'BrowserUseCloudProvider can only close its own sessions',
      );
    }
    const active = this.activeSessions.get(session);
    if (!active) {
      throw new Error('BrowserUseCloudProvider session is not active');
    }
    this.activeSessions.delete(session);

    let stopped: BrowserUseCloudSessionResponse | null = null;
    try {
      stopped = await this.stopCloudSession(active.cloud.id);
    } finally {
      await active.browser.close();
    }

    this.recordCloseUsage(active, stopped);
  }

  private resolveApiKey(): string {
    const value = resolveSecretInputUnsafe(
      this.options.apiKeyRef || DEFAULT_API_KEY_REF,
      {
        path: 'BrowserUseCloudProvider.apiKeyRef',
        required: true,
        reason: 'call Browser Use Cloud API',
        audit: this.options.secretAudit || noopSecretAudit,
      },
    );
    if (!value) {
      throw new Error('Browser Use Cloud API key did not resolve.');
    }
    return value;
  }

  private resolveMetering(opts: SessionOptions): BrowserSessionMeteringContext {
    const metering = opts.metering || this.options.metering;
    if (!metering?.sessionId?.trim() || !metering.agentId?.trim()) {
      throw new Error(
        'BrowserUseCloudProvider requires metering.sessionId and metering.agentId so every cloud session is audited and recorded in UsageTotals.',
      );
    }
    return {
      sessionId: metering.sessionId.trim(),
      agentId: metering.agentId.trim(),
      auditRunId: metering.auditRunId?.trim() || undefined,
    };
  }

  private async createCloudSession(
    apiKey: string,
    opts: SessionOptions,
  ): Promise<BrowserUseCloudSessionResponse> {
    return await this.requestJson(apiKey, '/browsers', {
      method: 'POST',
      body: JSON.stringify(
        buildCreateBrowserBody(opts, this.options.browser || {}),
      ),
    });
  }

  private async stopCloudSession(
    providerSessionId: string,
  ): Promise<BrowserUseCloudSessionResponse> {
    const apiKey = this.resolveApiKey();
    return await this.requestJson(
      apiKey,
      `/browsers/${encodeURIComponent(providerSessionId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action: 'stop' }),
      },
    );
  }

  private async requestJson(
    apiKey: string,
    path: string,
    init: { method: string; body?: string },
  ): Promise<BrowserUseCloudSessionResponse> {
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
        `Browser Use Cloud API ${init.method} ${path} failed with HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`,
      );
    }

    if (!payload || typeof payload !== 'object') {
      throw new Error(
        `Browser Use Cloud API ${init.method} ${path} returned a non-object response.`,
      );
    }

    return payload as BrowserUseCloudSessionResponse;
  }

  private recordActionUsage(
    metering: BrowserSessionMeteringContext,
    actionName: string,
  ): void {
    this.recordUsage(metering, {
      model: `browser-use-cloud/action:${actionName}`,
      costUsd: this.pricing.actionUsd,
      toolCalls: 1,
    });
  }

  private recordCloseUsage(
    active: ActiveCloudSession,
    stopped: BrowserUseCloudSessionResponse | null,
  ): void {
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

  private recordUsage(
    metering: BrowserSessionMeteringContext,
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
