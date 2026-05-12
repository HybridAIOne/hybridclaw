class InvoiceOperatorEscalationError extends Error {
  constructor(input) {
    super(input.message);
    this.name = 'InvoiceOperatorEscalationError';
    this.code = 'F8_OPERATOR_ESCALATION';
    this.providerId = input.providerId;
    this.reason = input.reason;
    this.escalation = {
      type: 'escalation.interaction_needed',
      domain: 'invoice_harvester',
      provider: input.providerId,
      reason: input.reason,
      modality: input.modality || 'operator',
      message: input.message,
    };
  }
}

function isInvoiceOperatorEscalation(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      error.code === 'F8_OPERATOR_ESCALATION' &&
      error.escalation,
  );
}

function createCaptchaEscalation(providerId, selector) {
  return new InvoiceOperatorEscalationError({
    providerId,
    reason: 'captcha',
    modality: 'captcha',
    message: `Captcha detected during ${providerId} invoice portal login at ${selector}; F8 operator escalation required.`,
  });
}

function createPushMfaEscalation(providerId, selector) {
  return new InvoiceOperatorEscalationError({
    providerId,
    reason: 'push_mfa',
    modality: 'push',
    message: `Interactive MFA detected during ${providerId} invoice portal login at ${selector}; F8 operator escalation required.`,
  });
}

module.exports = {
  InvoiceOperatorEscalationError,
  createCaptchaEscalation,
  createPushMfaEscalation,
  isInvoiceOperatorEscalation,
};
