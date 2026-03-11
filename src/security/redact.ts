const REDACTION_DISABLED_ENV = 'HYBRIDCLAW_REDACT_SECRETS';

type RedactionReplacer = (substring: string, ...args: string[]) => string;

export interface SecretRedactionPattern {
  match: RegExp;
  replace: string | RedactionReplacer;
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
      match: /\b(ghp_[A-Za-z0-9_]{20,})\b/g,
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
