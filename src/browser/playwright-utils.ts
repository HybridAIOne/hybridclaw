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
  BrowserSessionMeteringContext,
  HistoryNavigationOptions,
  NavigateOptions,
  ScrollOptions,
} from './provider.js';

export type PlaywrightNavigationOptions = {
  waitUntil?: 'load' | 'domcontentloaded' | undefined;
  timeout?: number | undefined;
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

type CredentialFillParams = {
  selector: string;
  host: string;
  context?: BrowserSessionMeteringContext | undefined;
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
  context?: BrowserSessionMeteringContext | undefined;
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
    context?: BrowserSessionMeteringContext | undefined;
    secretAudit?: ((handle: SecretHandle, reason: string) => void) | undefined;
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
