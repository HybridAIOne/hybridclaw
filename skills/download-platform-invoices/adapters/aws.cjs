const { createHash, createHmac } = require('node:crypto');
const { invoiceIssuePeriod, isoDate, moneyFromDecimal, vatRate } = require('../helpers/money.cjs');

class AwsInvoiceAdapter {
  id = 'aws';
  displayName = 'AWS';

  constructor(options = {}) {
    this.fetch = options.fetch || fetch;
  }

  async login(credentials) {
    for (const key of ['accessKeyId', 'secretAccessKey', 'accountId']) {
      if (!credentials[key]) {
        throw new Error(`AWS invoice adapter requires credentials.${key}.`);
      }
    }
    return { credentials };
  }

  async listInvoices(session, options = {}) {
    const period = invoiceIssuePeriod(options);
    const payload = await this.awsJson(session.credentials, 'ListInvoiceSummaries', {
      Selector: { ResourceType: 'ACCOUNT_ID', Value: session.credentials.accountId },
      Filter: { BillingPeriod: { Month: period.month, Year: period.year } },
      MaxResults: 100,
    });
    return (payload.InvoiceSummaries || []).map((summary) => {
      const invoiceNo = String(summary.InvoiceId || '');
      if (!invoiceNo) throw new Error('AWS invoice summary is missing InvoiceId.');
      const amount = summary.PaymentCurrencyAmount || {};
      const net = moneyFromDecimal(amount.TotalAmountBeforeTax);
      const gross = moneyFromDecimal(amount.TotalAmount);
      const vat = moneyFromDecimal(amount.AmountBreakdown?.Taxes?.TotalAmount);
      const currency = String(amount.CurrencyCode || '');
      if (!/^[A-Z]{3}$/u.test(currency)) {
        throw new Error(`AWS invoice ${invoiceNo} is missing CurrencyCode.`);
      }
      return {
        vendor: 'aws',
        invoice_no: invoiceNo,
        period:
          summary.BillingPeriod?.Year && summary.BillingPeriod?.Month
            ? `${String(summary.BillingPeriod.Year).padStart(4, '0')}-${String(
                summary.BillingPeriod.Month,
              ).padStart(2, '0')}`
            : isoDate(summary.IssuedDate, 'IssuedDate').slice(0, 7),
        issue_date: isoDate(summary.IssuedDate, 'IssuedDate'),
        due_date: isoDate(summary.DueDate, 'DueDate'),
        net,
        vat_rate: vatRate(net, vat),
        vat,
        gross,
        currency,
        source_url: `aws-invoicing://${invoiceNo}`,
      };
    });
  }

  async download(session, invoice) {
    const payload = await this.awsJson(session.credentials, 'GetInvoicePDF', {
      InvoiceId: invoice.invoice_no,
    });
    const documentUrl = String(payload.InvoicePDF?.DocumentUrl || '');
    if (!documentUrl) {
      throw new Error(`AWS invoice ${invoice.invoice_no} PDF response is missing DocumentUrl.`);
    }
    const response = await this.fetch(documentUrl);
    if (!response.ok) {
      throw new Error(
        `AWS invoice ${invoice.invoice_no} PDF download failed with HTTP ${response.status}.`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async awsJson(credentials, action, payload) {
    const region = credentials.region || 'us-east-1';
    const endpoint = new URL(
      credentials.endpointUrl || `https://invoicing.${region}.amazonaws.com`,
    );
    const body = JSON.stringify(payload);
    const headers = signAwsJsonRequest({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      region,
      service: 'invoicing',
      host: endpoint.host,
      target: `${credentials.targetPrefix || 'AWSInvoicingService'}.${action}`,
      body,
      now: new Date(),
    });
    const response = await this.fetch(endpoint, { method: 'POST', headers, body });
    if (!response.ok) throw new Error(`AWS ${action} failed with HTTP ${response.status}.`);
    return response.json();
  }
}

function signAwsJsonRequest(input) {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update(input.body).digest('hex');
  const baseHeaders = {
    'content-type': 'application/x-amz-json-1.1',
    host: input.host,
    'x-amz-date': amzDate,
    'x-amz-target': input.target,
  };
  if (input.sessionToken) baseHeaders['x-amz-security-token'] = input.sessionToken;
  const signedHeaders = Object.keys(baseHeaders).sort().join(';');
  const canonicalHeaders = Object.keys(baseHeaders)
    .sort()
    .map((key) => `${key}:${baseHeaders[key]}\n`)
    .join('');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), input.service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    ...baseHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

module.exports = {
  AwsInvoiceAdapter,
  createAwsInvoiceAdapter: (options) => new AwsInvoiceAdapter(options),
};
