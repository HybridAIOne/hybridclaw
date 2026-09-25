import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readStringValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function readCredentialValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeBaseUrl(value, fallback) {
  const trimmed = String(value || '').trim() || fallback;
  return trimmed.replace(/\/+$/, '');
}

export function stripProviderPrefix(model, provider) {
  const trimmed = String(model || '').trim();
  const prefix = `${provider}/`;
  if (trimmed.toLowerCase().startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeProviderError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function readErrorMessage(body) {
  const trimmed = String(body || '').trim();
  if (!trimmed) return 'Unknown error';
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed.trim() || 'Unknown error';
    if (isRecord(parsed)) {
      const nested = isRecord(parsed.error) ? parsed.error : {};
      return (
        readStringValue(parsed.message) ||
        readStringValue(parsed.detail) ||
        readStringValue(parsed.error) ||
        readStringValue(nested.message) ||
        readStringValue(nested.detail) ||
        trimmed
      );
    }
  } catch {
    // Fall back to the raw body.
  }
  return trimmed;
}

export class ProviderRequestError extends Error {
  constructor(status, body) {
    super(`Provider API error ${status}: ${readErrorMessage(body)}`);
    this.name = 'ProviderRequestError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Writes a generated file under `<workspace>/<outputDir>/` and returns the
 * host path plus the path the agent sees inside its sandbox.
 */
export function writeWorkspaceFile(context, outputDir, filename, data) {
  const outputRoot = path.join(context.workspaceRoot, outputDir);
  fs.mkdirSync(outputRoot, { recursive: true });
  const hostPath = path.join(outputRoot, filename);
  fs.writeFileSync(hostPath, data);
  return {
    hostPath,
    displayPath: `${context.workspaceDisplayRoot}/${outputDir}/${filename}`,
  };
}

export function uniqueFilename(prefix, index, ext) {
  return `${prefix}-${Date.now()}-${index + 1}-${randomUUID().slice(0, 8)}${ext}`;
}

/** Auth, rate-limit, and server errors move on to the next provider; others stop. */
export function classifyProviderError(err) {
  const text = err instanceof Error ? err.message : String(err);
  if (/(^|\D)40[13](\D|$)/.test(text)) return 'auth';
  if (
    /unauthorized|forbidden|invalid api key|missing api key|no api key|api key.*required|credentials?.*not configured|permission denied/i.test(
      text,
    )
  ) {
    return 'auth';
  }
  if (
    /(^|\D)429(\D|$)|rate[- ]?limit|too many requests|quota|billing/i.test(text)
  ) {
    return 'rate_limit';
  }
  if (
    /(^|\D)5\d\d(\D|$)|internal server error|bad gateway|service unavailable|gateway timeout/i.test(
      text,
    )
  ) {
    return 'server_error';
  }
  return 'other';
}

export function shouldFallbackProviderError(err) {
  return classifyProviderError(err) !== 'other';
}
