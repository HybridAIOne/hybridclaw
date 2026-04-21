import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type TwilioSignatureParams = Record<string, string | string[]>;

function normalizeParamValues(
  params: TwilioSignatureParams,
): Array<[name: string, values: string[]]> {
  return Object.entries(params)
    .map(([name, value]): [string, string[]] => [
      name,
      Array.isArray(value)
        ? value.map((entry) => String(entry))
        : [String(value)],
    ])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

export function buildTwilioSignature(params: {
  authToken: string;
  url: string;
  values?: TwilioSignatureParams;
}): string {
  const authToken = String(params.authToken || '');
  const url = String(params.url || '');
  let payload = url;
  for (const [name, values] of normalizeParamValues(params.values || {})) {
    for (const value of values) {
      payload += `${name}${value}`;
    }
  }
  return createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
}

export function validateTwilioSignature(params: {
  authToken: string;
  signature: string | null | undefined;
  url: string;
  values?: TwilioSignatureParams;
}): boolean {
  const expected = buildTwilioSignature({
    authToken: params.authToken,
    url: params.url,
    values: params.values,
  });
  const actual = String(params.signature || '').trim();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const actualDigest = createHash('sha256').update(actual, 'utf8').digest();
  return Boolean(expected) && timingSafeEqual(expectedDigest, actualDigest);
}

export class ReplayProtector {
  private readonly entries = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  observe(token?: string | null): boolean {
    const normalized = String(token || '').trim();
    if (!normalized) {
      return true;
    }
    const now = Date.now();
    this.prune(now);
    const existing = this.entries.get(normalized);
    if (existing && now - existing < this.ttlMs) {
      return false;
    }
    this.entries.set(normalized, now);
    return true;
  }

  private prune(now: number): void {
    for (const [token, seenAt] of this.entries) {
      if (now - seenAt >= this.ttlMs) {
        this.entries.delete(token);
      }
    }
  }
}
