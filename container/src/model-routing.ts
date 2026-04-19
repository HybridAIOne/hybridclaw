import {
  isPremiumModelPermissionError,
  ProviderRequestError,
} from './providers/shared.js';
import type {
  ContainerInput,
  ModelRoutingInput,
  ModelRoutingRouteInput,
} from './types.js';

const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const BILLING_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const AUTH_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_ERROR_COOLDOWN_MS = 15 * 60 * 1000;
const MIN_CONTEXT_WINDOW_TOKENS = 4_096;
const CONTEXT_WINDOW_DOWNGRADE_TIERS = [
  1_000_000,
  512_000,
  256_000,
  200_000,
  128_000,
  64_000,
  32_000,
  16_000,
  8_000,
  MIN_CONTEXT_WINDOW_TOKENS,
] as const;

interface CredentialUsageState {
  requestCount: number;
  exhaustedUntilMs: number | null;
}

interface ModelRoutingRouteState extends ModelRoutingRouteInput {
  currentCredentialId: string | null;
  retried429: boolean;
}

export interface ActiveModelRoute extends ModelRoutingRouteInput {
  credentialId?: string;
  credentialLabel?: string;
}

export class ContextTierDowngradedError extends Error {
  constructor(
    public readonly previousContextWindow: number,
    public readonly nextContextWindow: number,
  ) {
    super(
      `Context window downgraded from ${previousContextWindow} to ${nextContextWindow} tokens.`,
    );
    this.name = 'ContextTierDowngradedError';
  }
}

export type ModelRoutingRecoveryAction =
  | { type: 'none'; reason: string }
  | { type: 'route_changed'; reason: string }
  | {
      type: 'context_downgraded';
      reason: string;
      previousContextWindow: number;
      nextContextWindow: number;
    };

const providerCredentialUsageState = new Map<
  string,
  Map<string, CredentialUsageState>
>();

export function clearModelRoutingStateForTests(): void {
  providerCredentialUsageState.clear();
}

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/\/+$/g, '');
}

function getProviderPoolStateKey(route: ModelRoutingRouteState): string {
  return `${route.provider || 'hybridai'}::${normalizeBaseUrl(route.baseUrl)}`;
}

function getCredentialUsageMap(
  route: ModelRoutingRouteState,
): Map<string, CredentialUsageState> {
  const poolKey = getProviderPoolStateKey(route);
  let usage = providerCredentialUsageState.get(poolKey);
  if (!usage) {
    usage = new Map<string, CredentialUsageState>();
    providerCredentialUsageState.set(poolKey, usage);
  }
  for (const entry of route.credentialPool?.entries || []) {
    if (!usage.has(entry.id)) {
      usage.set(entry.id, {
        requestCount: 0,
        exhaustedUntilMs: null,
      });
    }
  }
  return usage;
}

function getCredentialUsageState(
  route: ModelRoutingRouteState,
  credentialId: string,
): CredentialUsageState {
  const usage = getCredentialUsageMap(route);
  let state = usage.get(credentialId);
  if (!state) {
    state = {
      requestCount: 0,
      exhaustedUntilMs: null,
    };
    usage.set(credentialId, state);
  }
  return state;
}

function isCredentialAvailable(
  route: ModelRoutingRouteState,
  credentialId: string,
  now: number = Date.now(),
): boolean {
  const state = getCredentialUsageState(route, credentialId);
  return !state.exhaustedUntilMs || state.exhaustedUntilMs <= now;
}

function selectLeastUsedCredential(
  route: ModelRoutingRouteState,
  excludeCredentialId?: string,
): { id: string; label: string; apiKey: string } | null {
  const entries =
    route.credentialPool?.entries.filter(
      (entry) =>
        entry.id !== excludeCredentialId && isCredentialAvailable(route, entry.id),
    ) || [];
  if (entries.length === 0) return null;

  return [...entries].sort((left, right) => {
    const leftState = getCredentialUsageState(route, left.id);
    const rightState = getCredentialUsageState(route, right.id);
    if (leftState.requestCount !== rightState.requestCount) {
      return leftState.requestCount - rightState.requestCount;
    }
    const labelCompare = left.label.localeCompare(right.label);
    if (labelCompare !== 0) return labelCompare;
    return left.id.localeCompare(right.id);
  })[0];
}

function resolveStatusCode(error: unknown): number | null {
  if (error instanceof ProviderRequestError) return error.status;
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\b(401|402|403|404|429|5\d\d)\b/);
  return match ? Number(match[1]) : null;
}

function resolveErrorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error || '').trim();
}

function isAuthFailure(statusCode: number | null, message: string): boolean {
  return (
    statusCode === 401 ||
    /unauthorized|invalid api key|invalid token|authentication failed/i.test(
      message,
    )
  );
}

function isBillingFailure(statusCode: number | null, message: string): boolean {
  return (
    statusCode === 402 ||
    /billing|quota|credit balance|payment required|insufficient.*quota/i.test(
      message,
    )
  );
}

function isRateLimitFailure(
  statusCode: number | null,
  message: string,
): boolean {
  return statusCode === 429 || /rate.?limit|too many requests/i.test(message);
}

function canFallbackFromError(error: unknown, statusCode: number | null): boolean {
  if (isPremiumModelPermissionError(error)) return false;
  if (statusCode !== null) {
    return statusCode >= 400 && statusCode <= 599;
  }
  const message = resolveErrorMessage(error);
  return /fetch failed|network|socket|timeout|timed out|econnreset|terminated/i.test(
    message,
  );
}

function getCredentialCooldownMs(
  statusCode: number | null,
  message: string,
): number {
  if (isRateLimitFailure(statusCode, message)) return RATE_LIMIT_COOLDOWN_MS;
  if (isBillingFailure(statusCode, message)) return BILLING_COOLDOWN_MS;
  if (isAuthFailure(statusCode, message)) return AUTH_COOLDOWN_MS;
  return DEFAULT_ERROR_COOLDOWN_MS;
}

function getNextContextWindowTier(
  contextWindow: number | undefined,
): number | null {
  if (
    typeof contextWindow !== 'number' ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= MIN_CONTEXT_WINDOW_TOKENS
  ) {
    return null;
  }

  for (const tier of CONTEXT_WINDOW_DOWNGRADE_TIERS) {
    if (tier < contextWindow) return tier;
  }

  const halved = Math.floor(contextWindow / 2);
  return halved >= MIN_CONTEXT_WINDOW_TOKENS ? halved : null;
}

export class PrimaryModelRoutingSession {
  private readonly routes: ModelRoutingRouteState[];
  private readonly adaptiveContextTierDowngradeOn429: boolean;
  private routeIndex = 0;

  constructor(
    modelRouting: ModelRoutingInput | undefined,
    fallbackRoute: ModelRoutingRouteInput,
  ) {
    const routes = (modelRouting?.routes || [fallbackRoute]).map((route) => ({
      ...route,
      baseUrl: normalizeBaseUrl(route.baseUrl),
      requestHeaders: { ...(route.requestHeaders || {}) },
      credentialPool: route.credentialPool
        ? {
            rotation: route.credentialPool.rotation,
            entries: route.credentialPool.entries.map((entry) => ({
              id: entry.id,
              label: entry.label,
              apiKey: entry.apiKey,
            })),
          }
        : undefined,
      currentCredentialId: null,
      retried429: false,
    }));

    if (routes.length === 0) {
      routes.push({
        ...fallbackRoute,
        baseUrl: normalizeBaseUrl(fallbackRoute.baseUrl),
        requestHeaders: { ...(fallbackRoute.requestHeaders || {}) },
        currentCredentialId: null,
        retried429: false,
      });
    }

    this.routes = routes;
    this.adaptiveContextTierDowngradeOn429 =
      modelRouting?.adaptiveContextTierDowngradeOn429 !== false;
  }

  current(): ActiveModelRoute {
    const route = this.routes[this.routeIndex];
    const currentCredentialId = route.currentCredentialId;
    const currentCredential = route.credentialPool?.entries.find(
      (entry) => entry.id === currentCredentialId,
    );

    if (
      currentCredential &&
      isCredentialAvailable(route, currentCredential.id)
    ) {
      return {
        ...route,
        apiKey: currentCredential.apiKey,
        credentialId: currentCredential.id,
        credentialLabel: currentCredential.label,
      };
    }

    const selectedCredential = selectLeastUsedCredential(route);
    if (selectedCredential) {
      route.currentCredentialId = selectedCredential.id;
      return {
        ...route,
        apiKey: selectedCredential.apiKey,
        credentialId: selectedCredential.id,
        credentialLabel: selectedCredential.label,
      };
    }

    route.currentCredentialId = null;
    return { ...route };
  }

  noteSuccess(): void {
    const route = this.routes[this.routeIndex];
    const activeRoute = this.current();
    route.retried429 = false;
    if (!activeRoute.credentialId) return;
    const state = getCredentialUsageState(route, activeRoute.credentialId);
    state.requestCount += 1;
    state.exhaustedUntilMs = null;
  }

  recover(
    error: unknown,
    opts: { canRetrySameRoute: boolean },
  ): ModelRoutingRecoveryAction {
    const route = this.routes[this.routeIndex];
    const activeRoute = this.current();
    const statusCode = resolveStatusCode(error);
    const message = resolveErrorMessage(error);

    if (
      this.adaptiveContextTierDowngradeOn429 &&
      isRateLimitFailure(statusCode, message)
    ) {
      const nextContextWindow = getNextContextWindowTier(activeRoute.contextWindow);
      if (
        nextContextWindow !== null &&
        typeof activeRoute.contextWindow === 'number'
      ) {
        route.contextWindow = nextContextWindow;
        route.retried429 = false;
        return {
          type: 'context_downgraded',
          reason: 'rate_limit',
          previousContextWindow: activeRoute.contextWindow,
          nextContextWindow,
        };
      }
    }

    if (isAuthFailure(statusCode, message)) {
      if (this.rotateCredential(statusCode, message)) {
        return {
          type: 'route_changed',
          reason: 'credential_auth',
        };
      }
      if (this.advanceRoute()) {
        return {
          type: 'route_changed',
          reason: 'provider_auth',
        };
      }
      return {
        type: 'none',
        reason: 'auth_exhausted',
      };
    }

    if (isBillingFailure(statusCode, message)) {
      if (this.rotateCredential(statusCode, message)) {
        return {
          type: 'route_changed',
          reason: 'credential_billing',
        };
      }
      if (this.advanceRoute()) {
        return {
          type: 'route_changed',
          reason: 'provider_billing',
        };
      }
      return {
        type: 'none',
        reason: 'billing_exhausted',
      };
    }

    if (isRateLimitFailure(statusCode, message)) {
      if (!route.retried429 && opts.canRetrySameRoute) {
        route.retried429 = true;
        return {
          type: 'none',
          reason: 'rate_limit_retry',
        };
      }
      if (this.rotateCredential(statusCode, message)) {
        return {
          type: 'route_changed',
          reason: 'credential_rate_limit',
        };
      }
      if (!opts.canRetrySameRoute && this.advanceRoute()) {
        return {
          type: 'route_changed',
          reason: 'provider_rate_limit',
        };
      }
      return {
        type: 'none',
        reason: 'rate_limit_exhausted',
      };
    }

    if (canFallbackFromError(error, statusCode) && this.advanceRoute()) {
      return {
        type: 'route_changed',
        reason: 'provider_failover',
      };
    }

    return {
      type: 'none',
      reason: 'no_recovery_path',
    };
  }

  private rotateCredential(statusCode: number | null, message: string): boolean {
    const route = this.routes[this.routeIndex];
    if ((route.credentialPool?.entries.length || 0) < 2) return false;

    const activeRoute = this.current();
    if (!activeRoute.credentialId) return false;

    const currentState = getCredentialUsageState(route, activeRoute.credentialId);
    currentState.exhaustedUntilMs =
      Date.now() + getCredentialCooldownMs(statusCode, message);
    route.currentCredentialId = null;
    route.retried429 = false;

    const nextCredential = selectLeastUsedCredential(
      route,
      activeRoute.credentialId,
    );
    if (!nextCredential) return false;

    route.currentCredentialId = nextCredential.id;
    return true;
  }

  private advanceRoute(): boolean {
    if (this.routeIndex >= this.routes.length - 1) return false;
    this.routeIndex += 1;
    this.routes[this.routeIndex].currentCredentialId = null;
    this.routes[this.routeIndex].retried429 = false;
    return true;
  }
}

export function createPrimaryModelRoutingSession(
  input: ContainerInput,
): PrimaryModelRoutingSession {
  return new PrimaryModelRoutingSession(input.modelRouting, {
    provider: input.provider,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model: input.model,
    chatbotId: input.chatbotId,
    enableRag: input.enableRag,
    requestHeaders: input.requestHeaders,
    isLocal: input.isLocal,
    contextWindow: input.contextWindow,
    thinkingFormat: input.thinkingFormat,
    maxTokens: input.maxTokens,
  });
}
