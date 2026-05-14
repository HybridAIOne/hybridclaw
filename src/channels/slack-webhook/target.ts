export const SLACK_WEBHOOK_DEFAULT_TARGET = 'default';

const SLACK_WEBHOOK_PREFIX_RE = /^slack[_-]?webhook(?::(.+))?$/i;
const SLACK_WEBHOOK_TARGET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SLACK_WEBHOOK_ALLOWED_HOSTS = new Set([
  'hooks.slack.com',
  'hooks.slack-gov.com',
]);

export function normalizeSlackWebhookTargetName(
  value?: string | null,
): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return SLACK_WEBHOOK_DEFAULT_TARGET;
  if (!SLACK_WEBHOOK_TARGET_NAME_RE.test(normalized)) return null;
  return normalized;
}

export function slackWebhookSecretNameForTarget(targetName: string): string {
  const target = normalizeSlackWebhookTargetName(targetName);
  if (!target) {
    throw new Error(`Invalid Slack webhook target name: ${targetName}`);
  }
  if (target === SLACK_WEBHOOK_DEFAULT_TARGET) return 'SLACK_WEBHOOK_URL';
  return `SLACK_WEBHOOK_URL_TARGET_${Buffer.from(target, 'utf-8')
    .toString('hex')
    .toUpperCase()}`;
}

export function normalizeSlackWebhookChannelTarget(
  value?: string | null,
): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const match = normalized.match(SLACK_WEBHOOK_PREFIX_RE);
  if (!match) return null;
  const target = normalizeSlackWebhookTargetName(
    match[1] || SLACK_WEBHOOK_DEFAULT_TARGET,
  );
  return target ? `slack_webhook:${target}` : null;
}

export function isSlackWebhookChannelTarget(value?: string | null): boolean {
  return normalizeSlackWebhookChannelTarget(value) !== null;
}

export function parseSlackWebhookChannelTarget(
  value?: string | null,
): { target: string } | null {
  const normalized = normalizeSlackWebhookChannelTarget(value);
  if (!normalized) return null;
  const target = normalized.slice('slack_webhook:'.length);
  return target ? { target } : null;
}

export function normalizeSlackWebhookUrl(
  value: unknown,
  path = 'slackWebhook.webhooks.<target>.webhook_url',
): string {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error(`${path} is required.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${path} must be a valid Slack Incoming Webhook URL.`);
  }

  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    !SLACK_WEBHOOK_ALLOWED_HOSTS.has(host) ||
    !parsed.pathname.startsWith('/services/')
  ) {
    throw new Error(`${path} must be a valid Slack Incoming Webhook URL.`);
  }

  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}
