import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readStoredRuntimeEnv } from '../config/runtime-env.js';
import { redactSecretsDeep } from '../security/redact.js';

type SentryModule = typeof import('@sentry/node');

export interface SentryErrorContext {
  mechanism: string;
  extra?: Record<string, unknown>;
  tags?: Record<string, string>;
}

let sentry: SentryModule | null = null;
let initPromise: Promise<void> | null = null;
let initialized = false;
let resolvedRelease: string | null = null;

function readRuntimeSetting(name: string): string {
  const stored = readStoredRuntimeEnv()[name]?.trim();
  if (stored) return stored;
  return String(process.env[name] || '').trim();
}

function readSampleRate(): number | undefined {
  const raw = readRuntimeSetting('SENTRY_TRACES_SAMPLE_RATE');
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return undefined;
  return value;
}

function readPackageVersion(packageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf-8'),
    ) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { version?: unknown }).version === 'string'
    ) {
      const version = (parsed as { version: string }).version.trim();
      if (version) return version;
    }
  } catch {
    // Fall through to the next release source.
  }
  return null;
}

function defaultSentryRelease(): string {
  if (resolvedRelease) return resolvedRelease;
  const envVersion = String(process.env.npm_package_version || '').trim();
  const packageVersion =
    envVersion ||
    readPackageVersion(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'package.json',
      ),
    ) ||
    '0.0.0';
  resolvedRelease = `hybridclaw@${packageVersion}`;
  return resolvedRelease;
}

function normalizeException(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function isSentryConfigured(): boolean {
  return Boolean(readRuntimeSetting('SENTRY_DSN'));
}

export async function initSentry(): Promise<void> {
  if (!isSentryConfigured() || initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const sdk = await import('@sentry/node');
      const client = sdk.init({
        dsn: readRuntimeSetting('SENTRY_DSN'),
        environment: readRuntimeSetting('SENTRY_ENVIRONMENT') || 'production',
        release: readRuntimeSetting('SENTRY_RELEASE') || defaultSentryRelease(),
        skipOpenTelemetrySetup: true,
        tracesSampleRate: readSampleRate(),
        beforeSend(event) {
          return redactSecretsDeep(event);
        },
      });
      if (!client) return;
      sdk.setTag('service', 'hybridclaw-gateway');
      sentry = sdk;
      initialized = true;
    } catch (error) {
      // Sentry is optional; telemetry startup must never block the gateway.
      // eslint-disable-next-line no-console
      console.warn('Failed to start Sentry SDK:', error);
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

export function captureSentryException(
  error: unknown,
  context: SentryErrorContext,
): void {
  if (!initialized || !sentry) return;

  const tags = {
    ...context.tags,
    mechanism: context.mechanism,
  };
  const extra = context.extra ? redactSecretsDeep(context.extra) : undefined;

  sentry.captureException(normalizeException(error), {
    extra,
    tags,
  });
}

export async function shutdownSentry(timeoutMs = 2_000): Promise<void> {
  if (!initialized || !sentry) return;
  const sdk = sentry;
  sentry = null;
  initialized = false;
  try {
    await sdk.flush(timeoutMs);
  } catch (error) {
    // Sentry is optional; telemetry shutdown must never block process exit.
    // eslint-disable-next-line no-console
    console.warn('Failed to flush Sentry SDK:', error);
  }
}
