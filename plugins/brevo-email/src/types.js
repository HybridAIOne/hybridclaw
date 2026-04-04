/**
 * @typedef {object} BrevoEmailConfig
 * @property {string} domain
 * @property {string} smtpHost
 * @property {number} smtpPort
 * @property {string} smtpLogin
 * @property {string} smtpKey
 * @property {string} webhookSecret
 * @property {number} maxBodyBytes
 */

/**
 * @typedef {object} BrevoInboundItem
 * @property {string[]} [Uuid]
 * @property {string} [MessageId]
 * @property {string} [InReplyTo]
 * @property {{ Address: string; Name?: string }} From
 * @property {{ Address: string; Name?: string }[]} To
 * @property {{ Address: string; Name?: string }[]} [Cc]
 * @property {string} [Subject]
 * @property {string} [RawTextBody]
 * @property {string} [RawHtmlBody]
 * @property {BrevoAttachment[]} [Attachments]
 */

/**
 * @typedef {object} BrevoAttachment
 * @property {string} Name
 * @property {string} ContentType
 * @property {number} ContentLength
 * @property {string} [DownloadToken]
 * @property {string} [Base64Content]
 */

/**
 * @typedef {object} BrevoInboundPayload
 * @property {BrevoInboundItem[]} items
 */

export {};
