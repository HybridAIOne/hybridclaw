/**
 * Resolve and validate plugin configuration.
 *
 * @param {Record<string, unknown>} pluginConfig - Validated config from manifest schema.
 * @param {object} api - Plugin API (for getCredential).
 * @param {(key: string) => string | undefined} api.getCredential
 * @returns {import('./types.js').BrevoEmailConfig}
 */
export function resolveBrevoConfig(pluginConfig, api) {
  const smtpLogin = api.getCredential('BREVO_SMTP_LOGIN');
  if (!smtpLogin) {
    throw new Error('BREVO_SMTP_LOGIN is required but not set.');
  }
  const smtpKey = api.getCredential('BREVO_SMTP_KEY');
  if (!smtpKey) {
    throw new Error('BREVO_SMTP_KEY is required but not set.');
  }

  return {
    domain: String(pluginConfig.domain || 'agent.hybridai.one').trim(),
    smtpHost: String(pluginConfig.smtpHost || 'smtp-relay.brevo.com').trim(),
    smtpPort: Number(pluginConfig.smtpPort) || 587,
    smtpLogin,
    smtpKey,
    webhookSecret: String(pluginConfig.webhookSecret || '').trim(),
    maxBodyBytes: Number(pluginConfig.maxBodyBytes) || 10 * 1024 * 1024,
  };
}
