import { Buffer } from 'node:buffer';
import { assertBrowserNavigationUrl } from '../../container/shared/browser-navigation.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  assertSecretResolveAllowed,
  recordSecretResolved,
  recordSecretUnsafeEscaped,
} from '../gateway/gateway-secret-injection.js';
import type { SecretHandle } from '../security/secret-handles.js';
import { unsafeEscapeSecretHandle } from '../security/secret-handles.js';
import { normalizeSecretString as normalizeString } from '../security/secret-normalization.js';
import {
  hardenSecretRef,
  resolveSecretHandleInput,
  type SecretInput,
  type SecretRef,
} from '../security/secret-refs.js';
import type {
  BrowserEvaluateFunction,
  BrowserSession,
  BrowserSessionMeteringContext,
  ClickOptions,
  HistoryNavigationOptions,
  NavigateOptions,
  ScreenshotOptions,
  ScrollOptions,
  WaitOptions,
} from './provider.js';

export type PlaywrightScreenshotOptions = {
  fullPage?: boolean;
  type?: 'png' | 'jpeg';
};

export type PlaywrightNavigationOptions = {
  waitUntil?: 'load' | 'domcontentloaded';
  timeout?: number;
};

export type PlaywrightPageShape = {
  evaluate<T>(fn: BrowserEvaluateFunction<T>): Promise<T>;
  screenshot(opts?: PlaywrightScreenshotOptions): Promise<Buffer | Uint8Array>;
  goto(url: string, opts?: PlaywrightNavigationOptions): Promise<unknown>;
  goBack(opts?: PlaywrightNavigationOptions): Promise<unknown>;
  goForward(opts?: PlaywrightNavigationOptions): Promise<unknown>;
  reload(opts?: PlaywrightNavigationOptions): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  url(): string;
  mouse: {
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  waitForSelector(
    selector: string,
    opts?: { state?: WaitOptions['state']; timeout?: number },
  ): Promise<unknown>;
  locator(selector: string): PlaywrightSecretFillLocator & {
    evaluate<TArg>(
      fn: (element: Element, arg: TArg) => void,
      arg: TArg,
    ): Promise<void>;
  };
};

export type PlaywrightContextShape<TPage extends PlaywrightPageShape> = {
  pages(): TPage[];
  newPage(): Promise<TPage>;
  close(): Promise<void>;
};

export type PlaywrightFillPage = {
  fill(selector: string, value: string): Promise<void>;
  locator(selector: string): PlaywrightSecretFillLocator;
  url(): string;
};

export const DEFAULT_SCROLL_DELTA = 800;

export const noopSecretAudit = () => {};

export type PlaywrightSecretFillLocator = {
  fill(value: string): Promise<void>;
  pressSequentially?(value: string): Promise<void>;
};

export class PlaywrightBrowserSession<
  TPage extends PlaywrightPageShape = PlaywrightPageShape,
> implements BrowserSession
{
  constructor(
    private readonly page: TPage,
    private readonly secretAudit?: (
      handle: SecretHandle,
      reason: string,
    ) => void,
    private readonly metering?: BrowserSessionMeteringContext,
  ) {}

  async evaluate<T>(fn: BrowserEvaluateFunction<T>): Promise<T> {
    return await this.page.evaluate(fn);
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    const bytes = await this.page.screenshot({
      fullPage: opts?.fullPage,
      type: opts?.type,
    });
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  }

  async navigate(url: string, opts?: NavigateOptions): Promise<void> {
    const parsed = await assertBrowserNavigationUrl(url);
    await this.page.goto(parsed.toString(), toNavigationOptions(opts));
  }

  async back(opts?: HistoryNavigationOptions): Promise<void> {
    await this.page.goBack(toNavigationOptions(opts));
  }

  async forward(opts?: HistoryNavigationOptions): Promise<void> {
    await this.page.goForward(toNavigationOptions(opts));
  }

  async reload(opts?: HistoryNavigationOptions): Promise<void> {
    await this.page.reload(toNavigationOptions(opts));
  }

  async click(selector: string, opts?: ClickOptions): Promise<void> {
    await this.page.click(selector, { timeout: opts?.timeoutMs });
  }

  async fill(selector: string, value: SecretInput): Promise<void> {
    await fillBrowserField(
      this.page,
      selector,
      value,
      this.secretAudit,
      this.metering,
    );
  }

  async scroll(opts: ScrollOptions): Promise<void> {
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
    await this.page.waitForSelector(selector, {
      state: opts?.state,
      timeout: opts?.timeoutMs,
    });
  }
}

type CredentialFillParams = {
  selector: string;
  host: string;
  context?: BrowserSessionMeteringContext;
  ref: SecretRef;
  skillName: string;
};

export function toNavigationOptions(
  opts?: NavigateOptions | HistoryNavigationOptions,
): PlaywrightNavigationOptions | undefined {
  if (!opts) return undefined;
  return {
    waitUntil: opts.waitUntil,
    timeout: opts.timeoutMs,
  };
}

export function normalizeScrollDelta(opts: ScrollOptions): {
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

function resolvePageHost(page: PlaywrightFillPage, selector: string): string {
  try {
    const url = page.url();
    if (!url) {
      throw new Error('page URL is empty');
    }
    return new URL(url).hostname;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `browser.fill(${selector}) SecretRef requires a resolvable page URL for host-scoped secret policy evaluation: ${cause}`,
    );
  }
}

function resolveCredentialFillParams(params: {
  selector: string;
  host: string;
  context?: BrowserSessionMeteringContext;
  ref: SecretRef;
}): CredentialFillParams {
  const skillName = normalizeString(params.context?.skillName);
  if (!skillName) {
    throw new Error(
      `browser.fill(${params.selector}) SecretRef requires SessionOptions.metering.skillName so secret policy can evaluate the calling skill.`,
    );
  }
  return { ...params, skillName };
}

function assertCredentialFillAllowed(params: CredentialFillParams): void {
  assertSecretResolveAllowed({
    sessionId: params.context?.sessionId,
    agentId: params.context?.agentId,
    skillName: params.skillName,
    secretSource: params.ref.source,
    secretId: params.ref.id,
    sinkKind: 'dom',
    host: params.host,
    selector: params.selector,
  });
}

function recordCredentialResolve(params: CredentialFillParams): void {
  if (!params.context?.sessionId) return;
  recordSecretResolved({
    sessionId: params.context.sessionId,
    runId: params.context.auditRunId,
    skillName: params.skillName,
    secretSource: params.ref.source,
    secretId: params.ref.id,
    sinkKind: 'dom',
    host: params.host,
    selector: params.selector,
  });
}

function recordCredentialFilled(params: CredentialFillParams): void {
  if (!params.context?.sessionId) return;
  recordAuditEvent({
    sessionId: params.context.sessionId,
    runId: params.context.auditRunId || makeAuditRunId('browser-credential'),
    event: {
      type: 'browser.credential_filled',
      selector: params.selector,
      host: normalizeString(params.host) || null,
      skill: params.skillName,
      secretRef: {
        source: params.ref.source,
        id: params.ref.id,
      },
    },
  });
}

async function injectSecretIntoElement(
  locator: PlaywrightSecretFillLocator,
  handle: SecretHandle,
  opts: {
    selector: string;
    host: string;
    context?: BrowserSessionMeteringContext;
    secretAudit?: (handle: SecretHandle, reason: string) => void;
  },
): Promise<void> {
  try {
    await locator.fill('');
    if (locator.pressSequentially) {
      await locator.pressSequentially(
        unsafeEscapeSecretHandle(handle, {
          reason: `fill browser field ${opts.selector}`,
          audit: (auditedHandle, reason) => {
            if (opts.context?.sessionId) {
              recordSecretUnsafeEscaped({
                sessionId: opts.context.sessionId,
                runId: opts.context.auditRunId,
                skillName: opts.context.skillName,
                secretSource: auditedHandle.ref.source,
                secretId: auditedHandle.ref.id,
                sinkKind: 'dom',
                host: opts.host,
                selector: opts.selector,
                reason,
              });
            }
            (opts.secretAudit || noopSecretAudit)(auditedHandle, reason);
          },
        }),
      );
      return;
    }
    await locator.fill(
      unsafeEscapeSecretHandle(handle, {
        reason: `fill browser field ${opts.selector}`,
        audit: (auditedHandle, reason) => {
          if (opts.context?.sessionId) {
            recordSecretUnsafeEscaped({
              sessionId: opts.context.sessionId,
              runId: opts.context.auditRunId,
              skillName: opts.context.skillName,
              secretSource: auditedHandle.ref.source,
              secretId: auditedHandle.ref.id,
              sinkKind: 'dom',
              host: opts.host,
              selector: opts.selector,
              reason,
            });
          }
          (opts.secretAudit || noopSecretAudit)(auditedHandle, reason);
        },
      }),
    );
  } finally {
    handle.dispose();
  }
}

async function fillBrowserCredentialField(
  page: PlaywrightFillPage,
  selector: string,
  ref: SecretRef,
  secretAudit?: (handle: SecretHandle, reason: string) => void,
  context?: BrowserSessionMeteringContext,
): Promise<void> {
  const host = resolvePageHost(page, selector);
  const hardenedRef = hardenSecretRef(ref);
  const params = resolveCredentialFillParams({
    selector,
    host,
    context,
    ref: hardenedRef,
  });
  assertCredentialFillAllowed(params);
  const handle = resolveSecretHandleInput(hardenedRef, {
    path: `browser.fill(${selector})`,
    required: true,
    sinkKind: 'dom',
  }) as SecretHandle;
  recordCredentialResolve(params);
  await injectSecretIntoElement(page.locator(selector), handle, {
    selector,
    host,
    context,
    secretAudit,
  });
  recordCredentialFilled(params);
}

export async function fillBrowserField(
  page: PlaywrightFillPage,
  selector: string,
  value: SecretInput,
  secretAudit?: (handle: SecretHandle, reason: string) => void,
  context?: BrowserSessionMeteringContext,
): Promise<void> {
  if (typeof value === 'string') {
    await page.fill(selector, value);
    return;
  }
  await fillBrowserCredentialField(page, selector, value, secretAudit, context);
}

export async function loadPlaywrightModule<T>(
  injected: T | undefined,
  errorMessage: (cause: string) => string,
): Promise<T> {
  if (injected) return injected;
  try {
    return (await import('playwright')) as T;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(errorMessage(cause));
  }
}
