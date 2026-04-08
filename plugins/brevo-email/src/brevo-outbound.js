import nodemailer from 'nodemailer';

/**
 * Create a Brevo SMTP service with start/stop lifecycle.
 *
 * @param {import('./types.js').BrevoEmailConfig} config
 * @param {import('hybridclaw/plugin-sdk').PluginLogger} logger
 * @param {(options: import('nodemailer').TransportOptions) => import('nodemailer').Transporter} [createTransportImpl]
 * @returns {{ service: import('hybridclaw/plugin-sdk').PluginService; send: (opts: SendOptions) => Promise<void> }}
 */
export function createBrevoSmtpService(
  config,
  logger,
  createTransportImpl = nodemailer.createTransport,
) {
  /** @type {import('nodemailer').Transporter | null} */
  let transport = null;

  function ensureTransport() {
    if (transport) return transport;
    transport = createTransportImpl({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: {
        user: config.smtpLogin,
        pass: config.smtpKey,
      },
    });
    return transport;
  }

  /** @type {import('hybridclaw/plugin-sdk').PluginService} */
  const service = {
    id: 'brevo-email-smtp',
    async start() {
      const t = ensureTransport();
      try {
        await t.verify();
        logger.info(
          { host: config.smtpHost, port: config.smtpPort },
          'Brevo SMTP transport verified',
        );
      } catch (error) {
        logger.error(
          { error, host: config.smtpHost, port: config.smtpPort },
          'Brevo SMTP verification failed',
        );
        t.close();
        transport = null;
        throw error;
      }
    },
    async stop() {
      if (transport) {
        transport.close();
        transport = null;
        logger.debug('Brevo SMTP transport closed');
      }
    },
  };

  /**
   * @typedef {object} SendOptions
   * @property {string} from
   * @property {string} to
   * @property {string} subject
   * @property {string} body
   * @property {string} [cc]
   * @property {string} [bcc]
   * @property {string} [inReplyTo]
   * @property {string[]} [references]
   */

  /**
   * Send an email through Brevo SMTP relay.
   *
   * @param {SendOptions} opts
   */
  async function send(opts) {
    const t = ensureTransport();
    await t.sendMail({
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      text: opts.body,
      ...(opts.cc ? { cc: opts.cc } : {}),
      ...(opts.bcc ? { bcc: opts.bcc } : {}),
      ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
      ...(opts.references ? { references: opts.references } : {}),
    });
    logger.info(
      { from: opts.from, to: opts.to, subject: opts.subject },
      'Email sent',
    );
  }

  return { service, send };
}
