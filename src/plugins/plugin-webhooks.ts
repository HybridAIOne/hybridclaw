export const PLUGIN_INBOUND_WEBHOOK_PATH_PREFIX = '/api/plugin-webhooks';

export function buildPluginInboundWebhookPath(
  pluginId: string,
  webhookName: string,
): string {
  const normalizedPluginId = String(pluginId || '').trim();
  const normalizedWebhookName = String(webhookName || '').trim();
  if (!normalizedPluginId) {
    throw new Error('Plugin webhook path requires a non-empty plugin id.');
  }
  if (!normalizedWebhookName) {
    throw new Error('Plugin webhook path requires a non-empty webhook name.');
  }
  return `${PLUGIN_INBOUND_WEBHOOK_PATH_PREFIX}/${encodeURIComponent(normalizedPluginId)}/${encodeURIComponent(normalizedWebhookName)}`;
}

export function isPluginInboundWebhookPath(pathname: string): boolean {
  const normalized = String(pathname || '').trim();
  return (
    normalized === PLUGIN_INBOUND_WEBHOOK_PATH_PREFIX ||
    normalized.startsWith(`${PLUGIN_INBOUND_WEBHOOK_PATH_PREFIX}/`)
  );
}
