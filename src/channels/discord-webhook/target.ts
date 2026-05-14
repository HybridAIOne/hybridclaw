export const DISCORD_WEBHOOK_DEFAULT_TARGET = 'default';

const DISCORD_WEBHOOK_PREFIX_RE = /^discord[_-]?webhook(?::(.+))?$/i;
const DISCORD_WEBHOOK_TARGET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DISCORD_WEBHOOK_ALLOWED_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
]);
const DISCORD_WEBHOOK_PATH_RE =
  /^\/api\/webhooks\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;

export function normalizeDiscordWebhookTargetName(
  value?: string | null,
): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return DISCORD_WEBHOOK_DEFAULT_TARGET;
  if (!DISCORD_WEBHOOK_TARGET_NAME_RE.test(normalized)) return null;
  return normalized;
}

export function discordWebhookSecretNameForTarget(targetName: string): string {
  const target = normalizeDiscordWebhookTargetName(targetName);
  if (!target) {
    throw new Error(`Invalid Discord webhook target name: ${targetName}`);
  }
  if (target === DISCORD_WEBHOOK_DEFAULT_TARGET) return 'DISCORD_WEBHOOK_URL';
  return `DISCORD_WEBHOOK_URL_TARGET_${Buffer.from(target, 'utf-8')
    .toString('hex')
    .toUpperCase()}`;
}

export function normalizeDiscordWebhookChannelTarget(
  value?: string | null,
): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const match = normalized.match(DISCORD_WEBHOOK_PREFIX_RE);
  if (!match) return null;
  const target = normalizeDiscordWebhookTargetName(
    match[1] || DISCORD_WEBHOOK_DEFAULT_TARGET,
  );
  return target ? `discord_webhook:${target}` : null;
}

export function isDiscordWebhookChannelTarget(value?: string | null): boolean {
  return normalizeDiscordWebhookChannelTarget(value) !== null;
}

export function parseDiscordWebhookChannelTarget(
  value?: string | null,
): { target: string } | null {
  const normalized = normalizeDiscordWebhookChannelTarget(value);
  if (!normalized) return null;
  const target = normalized.slice('discord_webhook:'.length);
  return target ? { target } : null;
}

export function normalizeDiscordWebhookUrl(
  value: unknown,
  path = 'discordWebhook.webhooks.<target>.webhook_url',
): string {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error(`${path} is required.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${path} must be a valid Discord Incoming Webhook URL.`);
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (
    parsed.protocol !== 'https:' ||
    !DISCORD_WEBHOOK_ALLOWED_HOSTS.has(host) ||
    !DISCORD_WEBHOOK_PATH_RE.test(pathname)
  ) {
    throw new Error(`${path} must be a valid Discord Incoming Webhook URL.`);
  }

  parsed.username = '';
  parsed.password = '';
  parsed.pathname = pathname;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}
