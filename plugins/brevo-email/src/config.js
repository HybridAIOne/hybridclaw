/**
 * Resolve and validate plugin configuration.
 *
 * @param {Record<string, unknown>} pluginConfig - Validated config from manifest schema.
 * @param {object} api - Plugin API (for getCredential).
 * @param {(key: string) => string | undefined} api.getCredential
 * @returns {import('./types.js').BrevoEmailConfig}
 */
export function resolveBrevoConfig(pluginConfig, api) {
  const smtpLogin =
    api.getCredential('BREVO_SMTP_LOGIN') ||
    (process.env.BREVO_SMTP_LOGIN || '').trim();
  if (!smtpLogin) {
    throw new Error('BREVO_SMTP_LOGIN is required but not set.');
  }
  const smtpKey =
    api.getCredential('BREVO_SMTP_KEY') ||
    (process.env.BREVO_SMTP_KEY || '').trim();
  if (!smtpKey) {
    throw new Error('BREVO_SMTP_KEY is required but not set.');
  }

  const webhookSecret =
    api.getCredential('BREVO_WEBHOOK_SECRET') ||
    (process.env.BREVO_WEBHOOK_SECRET || '').trim();

  return {
    domain: String(pluginConfig.domain || 'agent.hybridai.one').trim(),
    fromName: String(pluginConfig.fromName || '').trim(),
    fromAddress: String(pluginConfig.fromAddress || '').trim(),
    smtpHost: String(pluginConfig.smtpHost || 'smtp-relay.brevo.com').trim(),
    smtpPort: Number(pluginConfig.smtpPort) || 587,
    smtpLogin,
    smtpKey,
    webhookSecret,
    maxBodyBytes: Number(pluginConfig.maxBodyBytes) || 10 * 1024 * 1024,
  };
}
