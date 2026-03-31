const REDACTION_DISABLED_ENV = 'HYBRIDCLAW_REDACT_SECRETS';
const HIGH_ENTROPY_MIN_LENGTH = 24;
const HIGH_ENTROPY_THRESHOLD = 3.5;

type RedactionReplacer = (substring: string, ...args: string[]) => string;

export interface SecretRedactionPattern {
  match: RegExp;
  replace: string | RedactionReplacer;
}

export interface HighEntropyRedactionOptions {
  minLength?: number;
  threshold?: number;
}

function isRedactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env[REDACTION_DISABLED_ENV] || '')
    .trim()
    .toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return '***';
  if (trimmed.length < 18) return '***';
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function shannonEntropy(text: string): number {
  if (!text) return 0;
  const counts = new Map<string, number>();
  for (const char of text) {
    counts.set(char, (counts.get(char) || 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function luhnCheck(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function isAllowlistedEmail(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'noreply@github.com';
}

function isPublicIpv4(value: string): boolean {
  const parts = value.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = parts;
  if (parts.some((part) => part < 0 || part > 255)) return false;
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 169 && b === 254) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  return true;
}

function isPublicIpv6(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized.includes(':')) return false;
  if (normalized === '::1') return false;
  if (
    normalized.startsWith('fe80:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd')
  ) {
    return false;
  }
  return true;
}

function isValidSsn(value: string): boolean {
  const match = value.match(/^(\d{3})-(\d{2})-(\d{4})$/);
  if (!match) return false;
  const [, area, group, serial] = match;
  if (area === '000' || area === '666' || area.startsWith('9')) return false;
  if (group === '00' || serial === '0000') return false;
  return true;
}

function replaceEmail(_match: string, value: string): string {
  return isAllowlistedEmail(value) ? value : '***EMAIL_REDACTED***';
}

function replaceIpv4(_match: string, value: string): string {
  return isPublicIpv4(value) ? '***IP_ADDRESS_REDACTED***' : value;
}

function replaceIpv6(_match: string, value: string): string {
  return isPublicIpv6(value) ? '***IP_ADDRESS_REDACTED***' : value;
}

function replaceSsn(_match: string, value: string): string {
  return isValidSsn(value) ? '***SSN_REDACTED***' : value;
}

function isLikelyPhoneNumber(value: string): boolean {
  const trimmed = value.trim();
  if (
    /^\d{4}[-/]\d{2}[-/]\d{2}$/.test(trimmed) ||
    /^\d{2}[-/]\d{2}[-/]\d{2,4}$/.test(trimmed) ||
    /^\d{3}-\d{2}-\d{4}$/.test(trimmed)
  ) {
    return false;
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  if (!/[+()/\s.-]/.test(trimmed) && !trimmed.startsWith('0')) return false;
  return true;
}

function replacePhone(_match: string, value: string): string {
  return isLikelyPhoneNumber(value) ? '***PHONE_REDACTED***' : value;
}

function replaceCreditCard(_match: string, value: string): string {
  return luhnCheck(value) ? '***CREDIT_CARD_REDACTED***' : value;
}

function unwrapQuotedValue(value: string): {
  quote: '"' | "'" | '';
  inner: string;
} {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return {
        quote: first,
        inner: value.slice(1, -1),
      };
    }
  }

  return { quote: '', inner: value };
}

function redactStructuredSecretValue(value: string): string {
  const { quote, inner } = unwrapQuotedValue(value);
  const redacted = redactSecrets(inner);
  const next = redacted !== inner ? redacted : maskSecret(inner);
  return quote ? `${quote}${next}${quote}` : next;
}

function redactConnectionString(value: string): string {
  const schemeIdx = value.indexOf('://');
  if (schemeIdx === -1) return '***CONNECTION_STRING_REDACTED***';
  return `${value.slice(0, schemeIdx + 3)}***`;
}

const JSON_SECRET_KEY_RE =
  /((?:["'])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|webhook[_-]?secret|auth(?:orization)?|token|secret|password|private[_-]?key)(?:["'])\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\s}\]]+)/gi;
const ENV_SECRET_ASSIGNMENT_RE =
  /\b((?:KEY|[A-Za-z_][A-Za-z0-9_]*?(?:API[_-]?KEY|ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|WEBHOOK[_-]?SECRET|AUTH(?:ORIZATION)?|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY)[A-Za-z0-9_]*))\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"'`]+)/gi;
const OBJECT_SECRET_KEY_RE =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|webhook[_-]?secret|auth(?:orization)?|token|secret|password|private[_-]?key)/i;

export const SECRET_REDACTION_PATTERNS: readonly SecretRedactionPattern[] =
  Object.freeze([
    {
      match:
        /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
      replace: '***PRIVATE_KEY_REDACTED***',
    },
    {
      match: JSON_SECRET_KEY_RE,
      replace: (_match: string, prefix: string, value: string) =>
        `${prefix}${redactStructuredSecretValue(value)}`,
    },
    {
      match: ENV_SECRET_ASSIGNMENT_RE,
      replace: (_match: string, key: string, value: string) =>
        `${key}=${redactStructuredSecretValue(value)}`,
    },
    {
      match: /\b(Bearer\s+)([^\s"',;]+)/gi,
      replace: (_match: string, prefix: string, token: string) =>
        `${prefix}${maskSecret(token)}`,
    },
    {
      match:
        /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|mssql):\/\/[^\s"'`]+)/gi,
      replace: (_match: string, value: string) => redactConnectionString(value),
    },
    {
      match: /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
      replace: (_match: string, token: string) => maskSecret(token),
    },
    {
      match: /\b(gho_[A-Za-z0-9_]{20,})\b/g,
      replace: (_match: string, token: string) => maskSecret(token),
    },
    {
      match: /\b(ghs_[A-Za-z0-9_]{20,})\b/g,
      replace: (_match: string, token: string) => maskSecret(token),
    },
    {
      match: /\b(ghu_[A-Za-z0-9_]{20,})\b/g,
      replace: (_match: string, token: string) => maskSecret(token),
    },
    {
      match: /\b(ghp_[A-Za-z0-9_]{20,})\b/g,
      replace: (_match: string, token: string) => maskSecret(token),
    },
    {
      match: /\b(npm_[A-Za-z0-9]{20,})\b/g,
      replace: (_match: string, token: string) => maskSecret(token),
    },
    {
      match: /\b(sk_(?:live|test)_[A-Za-z0-9]{16,})\b/g,
      replace: (_match: string, token: string) => maskSecret(token),
    },
    {
      match: /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
      replace: (_match: string, token: string) => maskSecret(token),
    },
    {
      match: /\b(AKIA[0-9A-Z]{16})\b/g,
      replace: (_match: string, token: string) => maskSecret(token),
    },
    {
      match: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      replace: (_match: string, token: string) => maskSecret(token),
    },
    {
      match: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
      replace: (_match: string, token: string) => maskSecret(token),
    },
    {
      match: /\b(hf_[A-Za-z0-9]{20,})\b/g,
      replace: (_match: string, token: string) => maskSecret(token),
    },
    {
      match: /\b(SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
      replace: (_match: string, token: string) => maskSecret(token),
    },
    {
      match: /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi,
      replace: replaceEmail,
    },
    {
      match:
        /\b((?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d))\b/g,
      replace: replaceIpv4,
    },
    {
      match:
        /\b(([0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|::1)\b/g,
      replace: replaceIpv6,
    },
    {
      match: /\b(\d{3}-\d{2}-\d{4})\b/g,
      replace: replaceSsn,
    },
    {
      match:
        /(?<!\w)((?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4})(?!\w)/g,
      replace: replacePhone,
    },
    {
      match: /(?<!\w)(\+\d{1,3}(?:[\s./-]?\d){6,14})(?!\w)/g,
      replace: replacePhone,
    },
    {
      match: /(?<!\w)(0\d{1,5}(?:[/\s.-]?\d){5,13})(?!\w)/g,
      replace: replacePhone,
    },
    {
      match: /\b((?:\d[ -]?){13,19})\b/g,
      replace: replaceCreditCard,
    },
  ]);

export function redactSecrets(text: string): string {
  if (!text || !isRedactionEnabled()) return text;

  let next = text;
  for (const pattern of SECRET_REDACTION_PATTERNS) {
    next = next.replace(pattern.match, pattern.replace as never);
  }
  return next;
}

export function redactSecretsDeep<T>(value: T): T {
  if (!isRedactionEnabled()) return value;
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretsDeep(entry)) as T;
  }
  if (!value || typeof value !== 'object') return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' && OBJECT_SECRET_KEY_RE.test(key)) {
      redacted[key] = redactStructuredSecretValue(raw);
      continue;
    }
    redacted[key] = redactSecretsDeep(raw);
  }
  return redacted as T;
}

export function redactHighEntropyStrings(
  text: string,
  options: HighEntropyRedactionOptions = {},
): string {
  if (!text || !isRedactionEnabled()) return text;

  const minLength = options.minLength ?? HIGH_ENTROPY_MIN_LENGTH;
  const threshold = options.threshold ?? HIGH_ENTROPY_THRESHOLD;
  return text.replace(/[A-Za-z0-9+/=_-]{24,}/g, (candidate) => {
    if (candidate.length < minLength) return candidate;
    if (
      /[/.:\\]/.test(candidate) ||
      candidate.startsWith('-Users-') ||
      candidate.startsWith('~')
    ) {
      return candidate;
    }
    if (/^[0-9a-f]{24,}$/i.test(candidate)) return candidate;
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate,
      )
    ) {
      return candidate;
    }
    if (!/[A-Za-z]/.test(candidate) || !/[0-9]/.test(candidate)) {
      return candidate;
    }
    if (shannonEntropy(candidate) < threshold) return candidate;
    return '***HIGH_ENTROPY_SECRET_REDACTED***';
  });
}
