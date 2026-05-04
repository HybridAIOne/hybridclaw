import type { SecretHandle } from '../security/secret-handles.js';
import {
  resolveSecretInputUnsafe,
  type SecretInput,
} from '../security/secret-refs.js';
import type {
  HistoryNavigationOptions,
  NavigateOptions,
  ScrollOptions,
} from './provider.js';

export type PlaywrightNavigationOptions = {
  waitUntil?: 'load' | 'domcontentloaded';
  timeout?: number;
};

export type PlaywrightFillPage = {
  fill(selector: string, value: string): Promise<void>;
};

export const DEFAULT_SCROLL_DELTA = 800;

export const noopSecretAudit = () => {};

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

export function resolveBrowserFillValue(
  selector: string,
  value: SecretInput,
  secretAudit?: (handle: SecretHandle, reason: string) => void,
): string {
  if (typeof value === 'string') return value;
  const resolvedSecret = resolveSecretInputUnsafe(value, {
    path: `browser.fill(${selector})`,
    required: true,
    reason: `fill browser field ${selector}`,
    audit: secretAudit || noopSecretAudit,
  });
  if (resolvedSecret == null) {
    throw new Error(`browser.fill(${selector}) secret did not resolve`);
  }
  return resolvedSecret;
}

export async function fillBrowserField(
  page: PlaywrightFillPage,
  selector: string,
  value: SecretInput,
  secretAudit?: (handle: SecretHandle, reason: string) => void,
): Promise<void> {
  await page.fill(
    selector,
    resolveBrowserFillValue(selector, value, secretAudit),
  );
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
