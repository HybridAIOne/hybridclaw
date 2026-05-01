const INVOICE_PROVIDER_DEFINITIONS = [
  { id: 'stripe', displayName: 'Stripe' },
  { id: 'github', displayName: 'GitHub' },
  { id: 'openai', displayName: 'OpenAI' },
  { id: 'anthropic', displayName: 'Anthropic' },
  { id: 'atlassian', displayName: 'Atlassian' },
  { id: 'linkedin', displayName: 'LinkedIn Campaign Manager' },
  { id: 'google-ads', displayName: 'Google Ads' },
  { id: 'aws', displayName: 'AWS' },
  { id: 'gcp', displayName: 'GCP' },
  { id: 'azure', displayName: 'Azure' },
];

module.exports = {
  INVOICE_PROVIDER_DEFINITIONS,
  ...require('./harvester.cjs'),
  ...require('./helpers/money.cjs'),
  ...require('./helpers/config.cjs'),
  ...require('./helpers/schema.cjs'),
  ...require('./helpers/totp.cjs'),
  ...require('./adapters/stripe.cjs'),
  ...require('./adapters/scrape.cjs'),
  ...require('./adapters/google-ads.cjs'),
  ...require('./adapters/aws.cjs'),
  ...require('./adapters/azure.cjs'),
  ...require('./adapters/recorded-fixture.cjs'),
  ...require('./adapters/datev-unternehmen-online.cjs'),
};
