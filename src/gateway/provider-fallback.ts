import { performance } from 'node:perf_hooks';

import { resolveModelRuntimeCredentials } from '../providers/factory.js';
import type { ResolvedModelRuntimeCredentials } from '../providers/types.js';

export interface FallbackChainEntry {
  model: string;
  baseUrl?: string;
  keyEnv?: string;
  chatbotId?: string;
  agentId?: string;
}

export type FallbackReason = 'auth' | 'rate_limit' | 'other';

export interface FallbackActivation {
  runtime: ResolvedModelRuntimeCredentials;
  model: string;
  entry: FallbackChainEntry;
}

const DEFAULT_COOLDOWN_MS = 60_000;

const cooldownMap = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function loadFallbackChainFromEnv(
  raw: string | undefined = process.env.HYBRIDAI_FALLBACK_CHAIN,
): FallbackChainEntry[] {
  const text = String(raw || '').trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: FallbackChainEntry[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    if (!model) continue;
    const entry: FallbackChainEntry = { model };
    if (typeof item.baseUrl === 'string' && item.baseUrl.trim()) {
      entry.baseUrl = item.baseUrl.trim();
    }
    if (typeof item.keyEnv === 'string' && item.keyEnv.trim()) {
      entry.keyEnv = item.keyEnv.trim();
    }
    if (typeof item.chatbotId === 'string' && item.chatbotId.trim()) {
      entry.chatbotId = item.chatbotId.trim();
    }
    if (typeof item.agentId === 'string' && item.agentId.trim()) {
      entry.agentId = item.agentId.trim();
    }
    entries.push(entry);
  }
  return entries;
}

export function classifyProviderError(err: unknown): FallbackReason {
  const text = err instanceof Error ? err.message : String(err);
  if (/(^|\D)401(\D|$)|(^|\D)403(\D|$)/.test(text)) return 'auth';
  if (/unauthorized|forbidden|invalid api key|permission denied/i.test(text)) {
    return 'auth';
  }
  if (/(^|\D)429(\D|$)/.test(text)) return 'rate_limit';
  if (/rate[- ]?limit|too many requests|quota|billing/i.test(text)) {
    return 'rate_limit';
  }
  return 'other';
}

export function isProviderCooledDown(
  providerId: string,
  now: number = performance.now(),
): boolean {
  const until = cooldownMap.get(providerId);
  return typeof until === 'number' && until > now;
}

export function markProviderCooldown(
  providerId: string,
  durationMs: number = DEFAULT_COOLDOWN_MS,
  now: number = performance.now(),
): void {
  if (!providerId) return;
  cooldownMap.set(providerId, now + Math.max(0, durationMs));
}

export function clearProviderCooldown(providerId?: string): void {
  if (!providerId) {
    cooldownMap.clear();
    return;
  }
  cooldownMap.delete(providerId);
}

async function resolveEntry(
  entry: FallbackChainEntry,
): Promise<ResolvedModelRuntimeCredentials | null> {
  let runtime: ResolvedModelRuntimeCredentials;
  try {
    runtime = await resolveModelRuntimeCredentials({
      model: entry.model,
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
      ...(entry.chatbotId ? { chatbotId: entry.chatbotId } : {}),
    });
  } catch {
    return null;
  }
  let apiKey = runtime.apiKey;
  if (entry.keyEnv) {
    const envKey = String(process.env[entry.keyEnv] || '').trim();
    if (envKey) apiKey = envKey;
  }
  if (!apiKey && !runtime.isLocal) return null;
  return {
    ...runtime,
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    apiKey,
    ...(entry.chatbotId ? { chatbotId: entry.chatbotId } : {}),
  };
}

export interface ProviderFallbackControllerOptions {
  chain: FallbackChainEntry[];
  primaryProvider: string;
  cooldownMs?: number;
}

export class ProviderFallbackController {
  private readonly chain: FallbackChainEntry[];
  private readonly primaryProvider: string;
  private readonly cooldownMs: number;
  private index = 0;
  private activated = false;

  constructor(opts: ProviderFallbackControllerOptions) {
    this.chain = opts.chain;
    this.primaryProvider = String(opts.primaryProvider || '')
      .trim()
      .toLowerCase();
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  hasRemaining(): boolean {
    return this.index < this.chain.length;
  }

  isActivated(): boolean {
    return this.activated;
  }

  async tryActivate(
    reason: FallbackReason,
    currentProvider: string,
  ): Promise<FallbackActivation | null> {
    if (reason === 'rate_limit' && this.primaryProvider) {
      const current = String(currentProvider || '')
        .trim()
        .toLowerCase();
      const leavingPrimary =
        !this.activated || current === this.primaryProvider;
      if (leavingPrimary) {
        markProviderCooldown(this.primaryProvider, this.cooldownMs);
      }
    }
    while (this.index < this.chain.length) {
      const entry = this.chain[this.index];
      this.index += 1;
      if (!entry) continue;
      const runtime = await resolveEntry(entry);
      if (!runtime) continue;
      this.activated = true;
      return { runtime, model: entry.model, entry };
    }
    return null;
  }
}

export interface CallWithFallbackParams<T> {
  primaryRuntime: ResolvedModelRuntimeCredentials;
  primaryModel: string;
  chain: FallbackChainEntry[];
  cooldownMs?: number;
  invoke: (
    runtime: ResolvedModelRuntimeCredentials,
    model: string,
  ) => Promise<T>;
  onFallback?: (activation: FallbackActivation, reason: FallbackReason) => void;
}

export async function callWithProviderFallback<T>(
  params: CallWithFallbackParams<T>,
): Promise<T> {
  const controller = new ProviderFallbackController({
    chain: params.chain,
    primaryProvider: params.primaryRuntime.provider,
    ...(params.cooldownMs !== undefined
      ? { cooldownMs: params.cooldownMs }
      : {}),
  });

  let runtime = params.primaryRuntime;
  let model = params.primaryModel;

  if (
    params.chain.length > 0 &&
    isProviderCooledDown(params.primaryRuntime.provider)
  ) {
    const activation = await controller.tryActivate(
      'rate_limit',
      params.primaryRuntime.provider,
    );
    if (activation) {
      runtime = activation.runtime;
      model = activation.model;
      params.onFallback?.(activation, 'rate_limit');
    }
  }

  const maxAttempts = params.chain.length + 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await params.invoke(runtime, model);
    } catch (err) {
      lastError = err;
      const reason = classifyProviderError(err);
      if (reason === 'other' || !controller.hasRemaining()) throw err;
      const activation = await controller.tryActivate(reason, runtime.provider);
      if (!activation) throw err;
      runtime = activation.runtime;
      model = activation.model;
      params.onFallback?.(activation, reason);
    }
  }
  throw lastError;
}
