#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');

const MARKETING_BASIC_AUTH_SECRET = 'MAILCHIMP_MARKETING_BASIC_AUTH';
const MARKETING_OAUTH_TOKEN_SECRET = 'MAILCHIMP_MARKETING_OAUTH_TOKEN';
const MANDRILL_API_KEY_SECRET = 'MANDRILL_API_KEY';
const SERVER_PREFIX_ENV = 'MAILCHIMP_SERVER_PREFIX';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_COUNT = 25;
const MAX_COUNT = 1000;
const COST_MEASUREMENT = {
  system: 'UsageTotals',
  subLimitKey: 'mailchimp',
};

const OPERATION_TIERS = {
  'oauth.metadata': 'green',
  'marketing.root': 'green',
  'audience.list': 'green',
  'audience.members': 'green',
  'audience.member': 'green',
  'audience.member-upsert': 'amber',
  'audience.member-update': 'amber',
  'audience.member-archive': 'amber',
  'audience.tags-update': 'amber',
  'audience.bulk-plan': 'red',
  'audience.merge-fields': 'green',
  'audience.merge-field-create': 'amber',
  'audience.merge-field-update': 'amber',
  'campaign.list': 'green',
  'campaign.create': 'amber',
  'campaign.update': 'amber',
  'campaign.content-get': 'green',
  'campaign.content-set': 'amber',
  'campaign.schedule': 'red',
  'campaign.send': 'red',
  'campaign.report': 'green',
  'automation.list': 'green',
  'automation.get': 'green',
  'journey.list': 'green',
  'journey.get': 'green',
  'mandrill.message-info': 'green',
  'mandrill.send': 'red',
  'mandrill.send-template': 'red',
};

const MARKETING_OPERATIONS = new Set(
  Object.keys(OPERATION_TIERS).filter(
    (operation) =>
      !operation.startsWith('mandrill.') &&
      operation !== 'audience.bulk-plan' &&
      operation !== 'oauth.metadata',
  ),
);
const GUARDED_TIERS = new Set(['amber', 'red']);

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function popFlag(args, name, defaultValue) {
  const index = args.indexOf(name);
  if (index === -1) return defaultValue;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    die(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function popBooleanFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function popRepeatedFlag(args, name) {
  const values = [];
  for (;;) {
    const index = args.indexOf(name);
    if (index === -1) return values;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      die(`${name} requires a value.`);
    }
    values.push(value);
    args.splice(index, 2);
  }
}

function assertNoUnexpectedArgs(args) {
  if (args.length > 0) die(`Unexpected argument: ${args[0]}`);
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    die(`${label} is required.`);
  }
  return value.trim();
}

function requireSecretName(value, label) {
  const secretName = requireText(value, label);
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(secretName)) {
    die(`${label} must be an uppercase runtime secret name.`);
  }
  return secretName;
}

function encodeSegment(value, label) {
  return encodeURIComponent(requireText(value, label));
}

function parseInteger(value, label, { min, max } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number)) die(`${label} must be an integer.`);
  if (min !== undefined && number < min) die(`${label} must be at least ${min}.`);
  if (max !== undefined && number > max) die(`${label} must be at most ${max}.`);
  return number;
}

function parseJsonObject(raw, label) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      die(`${label} must be a JSON object.`);
    }
    return parsed;
  } catch (error) {
    die(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonObjectFlag(args, name, defaultValue) {
  const raw = popFlag(args, name);
  if (raw === undefined) return defaultValue;
  return parseJsonObject(raw, name);
}

function parseOptionalJsonObjectFlag(args, name) {
  const raw = popFlag(args, name);
  if (raw === undefined) return undefined;
  return parseJsonObject(raw, name);
}

function parsePagination(args, query) {
  const count = popFlag(args, '--count', String(DEFAULT_COUNT));
  query.count = parseInteger(count, '--count', { min: 1, max: MAX_COUNT });
  const offset = popFlag(args, '--offset');
  if (offset !== undefined) query.offset = parseInteger(offset, '--offset', { min: 0 });
}

function appendQuery(url, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function subscriberHash(email) {
  return crypto.createHash('md5').update(requireText(email, '--email').toLowerCase()).digest('hex');
}

function resolveSubscriberHash(args) {
  const hash = popFlag(args, '--subscriber-hash');
  const email = popFlag(args, '--email');
  if (hash && email) die('Use only one of --subscriber-hash or --email.');
  if (hash) return requireText(hash, '--subscriber-hash').toLowerCase();
  if (email) return subscriberHash(email);
  die('One of --subscriber-hash or --email is required.');
}

function parseTags(values) {
  if (values.length === 0) die('--tag is required at least once.');
  return values.map((entry) => {
    const [name, status = 'active'] = entry.split(':');
    const normalizedStatus = status.trim().toLowerCase();
    if (!['active', 'inactive'].includes(normalizedStatus)) {
      die('--tag status must be active or inactive, for example --tag VIP:active.');
    }
    return {
      name: requireText(name, '--tag name'),
      status: normalizedStatus,
    };
  });
}

function marketingBaseUrl(args) {
  const serverPrefix = requireText(
    popFlag(args, '--server-prefix', `<env:${SERVER_PREFIX_ENV}>`),
    '--server-prefix or <env:MAILCHIMP_SERVER_PREFIX>',
  );
  if (
    serverPrefix !== `<env:${SERVER_PREFIX_ENV}>` &&
    !/^[a-z0-9-]+$/u.test(serverPrefix.toLowerCase())
  ) {
    die('--server-prefix must contain only lowercase letters, digits, or hyphens.');
  }
  const normalizedPrefix =
    serverPrefix === `<env:${SERVER_PREFIX_ENV}>`
      ? serverPrefix
      : serverPrefix.toLowerCase();
  return `https://${normalizedPrefix}.api.mailchimp.com/3.0`;
}

function resolveMarketingAuth(args) {
  const auth = popFlag(args, '--auth', 'api-key');
  if (!['api-key', 'oauth'].includes(auth)) {
    die('--auth must be api-key or oauth.');
  }
  if (auth === 'api-key') {
    const secretName = requireSecretName(
      popFlag(args, '--basic-auth-secret', MARKETING_BASIC_AUTH_SECRET),
      '--basic-auth-secret',
    );
    return {
      mode: 'api-key',
      headers: {
        Authorization: `Basic <secret:${secretName}>`,
      },
    };
  }
  const secretName = requireSecretName(
    popFlag(args, '--token-secret', MARKETING_OAUTH_TOKEN_SECRET),
    '--token-secret',
  );
  return {
    mode: 'oauth',
    headers: {
      Authorization: `OAuth <secret:${secretName}>`,
    },
  };
}

function marketingRequest(args, operation, stakesTier) {
  const auth = resolveMarketingAuth(args);
  const base = marketingBaseUrl(args);
  const common = {
    method: 'GET',
    headers: {},
  };

  let path = '/';
  let json;
  const query = {};

  switch (operation) {
    case 'marketing.root':
      break;
    case 'audience.list':
      path = '/lists';
      parsePagination(args, query);
      break;
    case 'audience.members': {
      const listId = encodeSegment(popFlag(args, '--list-id'), '--list-id');
      path = `/lists/${listId}/members`;
      parsePagination(args, query);
      const status = popFlag(args, '--status');
      if (status !== undefined) query.status = requireText(status, '--status');
      break;
    }
    case 'audience.member': {
      const listId = encodeSegment(popFlag(args, '--list-id'), '--list-id');
      const hash = encodeSegment(resolveSubscriberHash(args), '--subscriber-hash');
      path = `/lists/${listId}/members/${hash}`;
      break;
    }
    case 'audience.member-upsert': {
      const listId = encodeSegment(popFlag(args, '--list-id'), '--list-id');
      const email = requireText(popFlag(args, '--email'), '--email');
      path = `/lists/${listId}/members/${subscriberHash(email)}`;
      common.method = 'PUT';
      json = {
        email_address: email,
        status_if_new: popFlag(args, '--status-if-new', 'subscribed'),
      };
      const status = popFlag(args, '--status');
      if (status !== undefined) json.status = requireText(status, '--status');
      const mergeFields = parseJsonObjectFlag(args, '--merge-fields-json');
      if (mergeFields !== undefined) json.merge_fields = mergeFields;
      const tags = popRepeatedFlag(args, '--tag');
      if (tags.length > 0) json.tags = tags;
      break;
    }
    case 'audience.member-update': {
      const listId = encodeSegment(popFlag(args, '--list-id'), '--list-id');
      const hash = encodeSegment(resolveSubscriberHash(args), '--subscriber-hash');
      path = `/lists/${listId}/members/${hash}`;
      common.method = 'PATCH';
      json = parseJsonObjectFlag(args, '--body-json');
      if (json === undefined) die('--body-json is required.');
      break;
    }
    case 'audience.member-archive': {
      const listId = encodeSegment(popFlag(args, '--list-id'), '--list-id');
      const hash = encodeSegment(resolveSubscriberHash(args), '--subscriber-hash');
      path = `/lists/${listId}/members/${hash}`;
      common.method = 'DELETE';
      break;
    }
    case 'audience.tags-update': {
      const listId = encodeSegment(popFlag(args, '--list-id'), '--list-id');
      const hash = encodeSegment(resolveSubscriberHash(args), '--subscriber-hash');
      path = `/lists/${listId}/members/${hash}/tags`;
      common.method = 'POST';
      json = { tags: parseTags(popRepeatedFlag(args, '--tag')) };
      break;
    }
    case 'audience.merge-fields': {
      const listId = encodeSegment(popFlag(args, '--list-id'), '--list-id');
      path = `/lists/${listId}/merge-fields`;
      parsePagination(args, query);
      break;
    }
    case 'audience.merge-field-create': {
      const listId = encodeSegment(popFlag(args, '--list-id'), '--list-id');
      path = `/lists/${listId}/merge-fields`;
      common.method = 'POST';
      json = parseJsonObjectFlag(args, '--body-json');
      if (json === undefined) die('--body-json is required.');
      break;
    }
    case 'audience.merge-field-update': {
      const listId = encodeSegment(popFlag(args, '--list-id'), '--list-id');
      const mergeId = encodeSegment(popFlag(args, '--merge-id'), '--merge-id');
      path = `/lists/${listId}/merge-fields/${mergeId}`;
      common.method = 'PATCH';
      json = parseJsonObjectFlag(args, '--body-json');
      if (json === undefined) die('--body-json is required.');
      break;
    }
    case 'campaign.list':
      path = '/campaigns';
      parsePagination(args, query);
      for (const [flag, key] of [
        ['--status', 'status'],
        ['--type', 'type'],
        ['--list-id', 'list_id'],
      ]) {
        const value = popFlag(args, flag);
        if (value !== undefined) query[key] = value;
      }
      break;
    case 'campaign.create':
      path = '/campaigns';
      common.method = 'POST';
      json = parseJsonObjectFlag(args, '--body-json');
      if (json === undefined) die('--body-json is required.');
      break;
    case 'campaign.update': {
      const campaignId = encodeSegment(popFlag(args, '--campaign-id'), '--campaign-id');
      path = `/campaigns/${campaignId}`;
      common.method = 'PATCH';
      json = parseJsonObjectFlag(args, '--body-json');
      if (json === undefined) die('--body-json is required.');
      break;
    }
    case 'campaign.content-get': {
      const campaignId = encodeSegment(popFlag(args, '--campaign-id'), '--campaign-id');
      path = `/campaigns/${campaignId}/content`;
      break;
    }
    case 'campaign.content-set': {
      const campaignId = encodeSegment(popFlag(args, '--campaign-id'), '--campaign-id');
      path = `/campaigns/${campaignId}/content`;
      common.method = 'PUT';
      json = parseJsonObjectFlag(args, '--body-json');
      if (json === undefined) die('--body-json is required.');
      break;
    }
    case 'campaign.schedule': {
      const campaignId = encodeSegment(popFlag(args, '--campaign-id'), '--campaign-id');
      const scheduleTime = requireText(popFlag(args, '--schedule-time'), '--schedule-time');
      path = `/campaigns/${campaignId}/actions/schedule`;
      common.method = 'POST';
      json = { schedule_time: scheduleTime };
      break;
    }
    case 'campaign.send': {
      const campaignId = encodeSegment(popFlag(args, '--campaign-id'), '--campaign-id');
      path = `/campaigns/${campaignId}/actions/send`;
      common.method = 'POST';
      break;
    }
    case 'campaign.report': {
      const campaignId = encodeSegment(popFlag(args, '--campaign-id'), '--campaign-id');
      const kind = popFlag(args, '--kind', 'overview');
      const reportPaths = {
        overview: `/reports/${campaignId}`,
        bounces: `/reports/${campaignId}`,
        opens: `/reports/${campaignId}/open-details`,
        clicks: `/reports/${campaignId}/click-details`,
        'email-activity': `/reports/${campaignId}/email-activity`,
        'sent-to': `/reports/${campaignId}/sent-to`,
        unsubscribed: `/reports/${campaignId}/unsubscribed`,
        advice: `/reports/${campaignId}/advice`,
        'domain-performance': `/reports/${campaignId}/domain-performance`,
      };
      path = reportPaths[kind];
      if (!path) die('--kind must be one of overview, bounces, opens, clicks, email-activity, sent-to, unsubscribed, advice, domain-performance.');
      if (kind === 'bounces') {
        query.fields =
          'id,campaign_title,emails_sent,bounces,send_time,list_id,list_name';
      }
      if (!['overview', 'bounces'].includes(kind)) {
        parsePagination(args, query);
      }
      break;
    }
    case 'automation.list':
      path = '/automations';
      parsePagination(args, query);
      break;
    case 'automation.get':
      path = `/automations/${encodeSegment(popFlag(args, '--workflow-id'), '--workflow-id')}`;
      break;
    case 'journey.list':
      path = '/customer-journeys/journeys';
      parsePagination(args, query);
      break;
    case 'journey.get':
      path = `/customer-journeys/journeys/${encodeSegment(popFlag(args, '--journey-id'), '--journey-id')}`;
      break;
    default:
      die(`Unsupported operation: ${operation}`);
  }

  assertNoUnexpectedArgs(args);
  const httpRequest = {
    url: appendQuery(`${base}${path}`, query),
    method: common.method,
    headers: {
      ...common.headers,
      ...auth.headers,
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skillName: 'mailchimp',
    stakesTier,
    authMode: auth.mode,
  };
  if (json !== undefined) httpRequest.json = json;
  return httpRequest;
}

function oauthMetadataRequest(args, stakesTier) {
  const auth = popFlag(args, '--auth', 'oauth');
  if (auth !== 'oauth') {
    die('oauth.metadata requires --auth oauth.');
  }
  const tokenSecret = requireSecretName(
    popFlag(args, '--token-secret', MARKETING_OAUTH_TOKEN_SECRET),
    '--token-secret',
  );
  assertNoUnexpectedArgs(args);
  return {
    url: 'https://login.mailchimp.com/oauth2/metadata',
    method: 'GET',
    headers: {
      Authorization: `OAuth <secret:${tokenSecret}>`,
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skillName: 'mailchimp',
    stakesTier,
  };
}

function bulkMemberPlan(args) {
  const listId = requireText(popFlag(args, '--list-id'), '--list-id');
  const operation = requireText(popFlag(args, '--operation'), '--operation');
  if (
    ![
      'member-upsert',
      'member-update',
      'member-archive',
      'tags-update',
    ].includes(operation)
  ) {
    die('--operation must be one of member-upsert, member-update, member-archive, tags-update.');
  }
  const count = parseInteger(popFlag(args, '--count'), '--count', {
    min: 2,
    max: 50_000,
  });
  const source = requireText(popFlag(args, '--source-label'), '--source-label');
  const sample = parseOptionalJsonObjectFlag(args, '--sample-json');
  assertNoUnexpectedArgs(args);
  const requiredGrant = `mailchimp:audience.bulk-plan:list:${listId}:operation:${operation}:count:${count}`;
  const approvedHelperCommand = [
    'node',
    'skills/mailchimp/mailchimp.cjs',
    '--format',
    'json',
    'approval-plan',
    'audience.bulk-plan',
    '--list-id',
    listId,
    '--operation',
    operation,
    '--count',
    String(count),
    '--source-label',
    source,
  ];
  if (sample) {
    approvedHelperCommand.push('--sample-json', JSON.stringify(sample));
  }
  return {
    command: 'approval-plan',
    operation: 'audience.bulk-plan',
    stakesTier: 'red',
    approvalRequired: true,
    approval: {
      requiredGrant,
      boundary:
        'This is a planning and approval boundary for bulk subscriber changes. Do not execute per-member helper commands until the operator approves this exact list, operation, source, count, and rollback plan.',
      approvedHelperCommand,
      approvedHelperCommandText: approvedHelperCommand.map(shellQuote).join(' '),
    },
    preview: {
      listId,
      memberOperation: operation,
      count,
      source,
      sample: sample ? redactBulkSample(sample) : undefined,
      sendsExternalEmail: false,
      subscriberMutation: true,
      execution:
        'After approval, generate exact per-member approved helper commands and run them with --operator-grant. The helper does not expose Mailchimp batch endpoints.',
    },
    approvalText: [
      'Mailchimp red operation: audience.bulk-plan',
      `Audience: ${listId}`,
      `Operation: ${operation}`,
      `Member count: ${count}`,
      `Source: ${source}`,
      'Confirm consent basis, source file, sample rows, expected count, and rollback strategy before any per-member execution.',
    ].join('\n'),
  };
}

function redactBulkSample(sample) {
  const copy = { ...sample };
  for (const key of Object.keys(copy)) {
    if (/email|address|phone|name/i.test(key)) {
      copy[key] = `<redacted:${key}>`;
    }
  }
  return copy;
}

function mandrillRequest(args, operation, stakesTier) {
  const secretName = requireSecretName(
    popFlag(args, '--mandrill-secret', MANDRILL_API_KEY_SECRET),
    '--mandrill-secret',
  );
  let path;
  let json;
  switch (operation) {
    case 'mandrill.message-info':
      path = '/messages/info.json';
      json = { id: requireText(popFlag(args, '--id'), '--id') };
      break;
    case 'mandrill.send':
      path = '/messages/send.json';
      json = parseJsonObjectFlag(args, '--body-json');
      if (json === undefined) die('--body-json is required.');
      break;
    case 'mandrill.send-template':
      path = '/messages/send-template.json';
      json = parseJsonObjectFlag(args, '--body-json');
      if (json === undefined) die('--body-json is required.');
      break;
    default:
      die(`Unsupported operation: ${operation}`);
  }
  if (Object.hasOwn(json, 'key')) die('--body-json must not include Mandrill key.');
  assertNoUnexpectedArgs(args);
  return {
    url: `https://mandrillapp.com/api/1.0${path}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    json: {
      key: `<secret:${secretName}>`,
      ...json,
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skillName: 'mailchimp',
    stakesTier,
  };
}

function targetDescription(operation, httpRequest) {
  const url = new URL(httpRequest.url);
  if (operation.startsWith('mandrill.')) return `${operation}:${url.pathname}`;
  return `${operation}:${url.hostname}${url.pathname}`;
}

function redactPreviewBody(json) {
  if (json === undefined) return undefined;
  return redactPreviewValue(json);
}

function redactPreviewValue(value, key = '') {
  if (typeof value === 'string') {
    if (['email_address', 'html', 'plain_text', 'text'].includes(key)) {
      return `<redacted:${key}:length=${value.length}>`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (key === 'to') return `<${value.length} recipients>`;
    return value.map((entry) => redactPreviewValue(entry));
  }
  if (!value || typeof value !== 'object') return value;
  if (key === 'merge_fields') {
    return Object.fromEntries(
      Object.keys(value).map((entryKey) => [
        entryKey,
        '<redacted:merge-field>',
      ]),
    );
  }
  const redacted = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === 'key') {
      redacted[entryKey] =
        typeof entryValue === 'string' && /^<secret:[A-Z][A-Z0-9_]{0,127}>$/u.test(entryValue)
          ? entryValue
          : '<secret:MANDRILL_API_KEY>';
    } else {
      redacted[entryKey] = redactPreviewValue(entryValue, entryKey);
    }
  }
  return redacted;
}

function buildHttpRequest(operation, args, options = {}) {
  const op = requireText(operation, 'operation');
  const stakesTier = OPERATION_TIERS[op];
  if (!stakesTier) die(`Unsupported operation: ${op}`);
  if (op === 'audience.bulk-plan') {
    die('audience.bulk-plan is an approval-plan only operation.');
  }
  const localArgs = [...args];
  const operatorGrant = popBooleanFlag(localArgs, '--operator-grant');
  popBooleanFlag(localArgs, '--request');
  const httpRequest =
    op === 'oauth.metadata'
      ? oauthMetadataRequest(localArgs, stakesTier)
      : MARKETING_OPERATIONS.has(op)
        ? marketingRequest(localArgs, op, stakesTier)
        : mandrillRequest(localArgs, op, stakesTier);
  const guarded = GUARDED_TIERS.has(stakesTier);
  if (guarded && !operatorGrant && !options.allowGuarded) {
    die(`${op} is a ${stakesTier} operation. Run approval-plan ${op} first, wait for explicit operator approval, then rerun the approved helper command with --operator-grant.`);
  }
  const payload = {
    command: 'http-request',
    operation: op,
    stakesTier,
    approvalRequired: guarded,
    httpRequest,
    credentialPolicy: {
      marketingBasicAuthSecret: MARKETING_BASIC_AUTH_SECRET,
      marketingOAuthTokenSecret: MARKETING_OAUTH_TOKEN_SECRET,
      mandrillApiKeySecret: MANDRILL_API_KEY_SECRET,
      serverPrefixEnv: SERVER_PREFIX_ENV,
      missingCredentialBehavior:
        'If the gateway reports a missing runtime secret or Mailchimp returns 401/403, stop after the first failure and ask the operator to set or verify the named credential.',
    },
    auditPolicy: {
      pii:
        'Summaries should prefer ids, subscriber_hash values, counts, and status fields. Do not log subscriber emails, Mandrill recipient lists, campaign HTML, or raw payload bodies beyond the minimum operator-approved context.',
      automationContext:
        'Automation and journey reads are for status and audit-safe context capture only; summarize ids, names, status, timestamps, and counts unless the operator asks for specific fields.',
    },
    costMeasurement: COST_MEASUREMENT,
  };
  if (guarded) {
    payload.approval = {
      requiredGrant: `mailchimp:${targetDescription(op, httpRequest)}`,
      boundary:
        'Stop after producing this request or approval plan. Execute only after explicit operator approval for the named Mailchimp or Mandrill target.',
    };
  }
  return payload;
}

function buildApprovalPlan(operation, args) {
  if (operation === 'audience.bulk-plan') {
    return bulkMemberPlan(args);
  }
  const cleanArgs = args.filter((entry) => entry !== '--operator-grant');
  const payload = buildHttpRequest(operation, cleanArgs, { allowGuarded: true });
  if (!payload.approvalRequired) {
    die(`${operation} is read-only and does not need approval-plan.`);
  }
  const approvedHelperCommand = [
    'node',
    'skills/mailchimp/mailchimp.cjs',
    '--format',
    'json',
    'http-request',
    operation,
    ...cleanArgs,
    '--operator-grant',
  ];
  return {
    command: 'approval-plan',
    operation,
    stakesTier: payload.stakesTier,
    approvalRequired: true,
    approval: {
      ...payload.approval,
      approvedHelperCommand,
      approvedHelperCommandText: approvedHelperCommand.map(shellQuote).join(' '),
    },
    preview: {
      method: payload.httpRequest.method,
      url: payload.httpRequest.url,
      body: redactPreviewBody(payload.httpRequest.json),
      sendsExternalEmail:
        operation === 'campaign.send' ||
        operation === 'campaign.schedule' ||
        operation === 'mandrill.send' ||
        operation === 'mandrill.send-template',
      subscriberMutation: operation.startsWith('audience.member') || operation === 'audience.tags-update',
    },
    approvalText: [
      `Mailchimp ${payload.stakesTier} operation: ${operation}`,
      `Target: ${targetDescription(operation, payload.httpRequest)}`,
      'Confirm the audience/campaign/message target, recipient impact, and rollback path before running the approved helper command unchanged.',
    ].join('\n'),
  };
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@=-]+$/u.test(value)) return value;
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

function credentialCheck(args) {
  const auth = popFlag(args, '--auth', 'api-key');
  if (!['api-key', 'oauth'].includes(auth)) {
    die('--auth must be api-key or oauth.');
  }
  const serverPrefix = popFlag(args, '--server-prefix', `<env:${SERVER_PREFIX_ENV}>`);
  if (
    serverPrefix !== `<env:${SERVER_PREFIX_ENV}>` &&
    !/^[a-z0-9-]+$/u.test(serverPrefix.toLowerCase())
  ) {
    die('--server-prefix must contain only lowercase letters, digits, or hyphens.');
  }
  assertNoUnexpectedArgs(args);
  const requiredSecret =
    auth === 'oauth' ? MARKETING_OAUTH_TOKEN_SECRET : MARKETING_BASIC_AUTH_SECRET;
  const optionalMarketingSecret =
    auth === 'oauth' ? MARKETING_BASIC_AUTH_SECRET : MARKETING_OAUTH_TOKEN_SECRET;
  return {
    command: 'credential-check',
    authMode: auth,
    ok: true,
    missing: [],
    gatewayResolution:
      'The helper emits <env:...> and <secret:...> placeholders. The gateway resolves them from the runtime env and secret stores when the http_request runs.',
    diagnosticPolicy:
      'Do not run hybridclaw secret/env list, grep stores, or inspect local files from the agent sandbox to decide whether these values are set. Treat this placeholder plan as ready; only the gateway placeholder resolver or upstream 401/403 can prove a missing or invalid value.',
    requiredPlaceholders: [
      `<env:${SERVER_PREFIX_ENV}>`,
      `<secret:${requiredSecret}>`,
    ],
    requiredConfigVariables: [
      {
        name: SERVER_PREFIX_ENV,
        placeholder: `<env:${SERVER_PREFIX_ENV}>`,
        reason:
          'Marketing API host prefix, normally the suffix after the last hyphen in a Mailchimp API key such as us21.',
      },
    ],
    requiredRuntimeSecrets: [
      {
        name: requiredSecret,
        placeholder: `<secret:${requiredSecret}>`,
        requiredFor:
          'Mailchimp Marketing API audiences, campaigns, automations, journeys, and reports.',
      },
    ],
    optionalRuntimeSecrets: [
      {
        name: optionalMarketingSecret,
        placeholder: `<secret:${optionalMarketingSecret}>`,
        requiredFor:
          'Alternative Mailchimp Marketing auth mode selected with --auth api-key or --auth oauth.',
      },
      {
        name: MANDRILL_API_KEY_SECRET,
        placeholder: `<secret:${MANDRILL_API_KEY_SECRET}>`,
        requiredFor: 'Mailchimp Transactional / Mandrill message send and lookup operations.',
      },
    ],
    secretVisibility:
      'This helper does not read runtime env or secret values. Missing values are reported by the HybridClaw gateway placeholder resolver or by a 401/403 upstream response.',
  };
}

function classifyResponse(args) {
  const gatewayError = popFlag(args, '--gateway-error');
  const rawStatus = popFlag(args, '--status', gatewayError ? '0' : undefined);
  const status =
    rawStatus === '0'
      ? 0
      : parseInteger(rawStatus, '--status', { min: 100, max: 599 });
  const body = parseJsonObjectFlag(args, '--body-json', {});
  assertNoUnexpectedArgs(args);
  let layer = 'upstream-api';
  let action = 'Report the Mailchimp response body and stop if the request was a write.';
  if (
    gatewayError &&
    /Stored secret [A-Z0-9_]+ is not set|Missing required runtime secrets?|Missing runtime secrets?/u.test(
      gatewayError,
    )
  ) {
    layer = 'missing-runtime-secret';
    action = `Stop. Ask the operator to set the missing credential with hybridclaw secret set ${MARKETING_BASIC_AUTH_SECRET} "<base64-user-colon-api-key>", hybridclaw secret set ${MARKETING_OAUTH_TOKEN_SECRET} "<oauth-token>", or hybridclaw secret set ${MANDRILL_API_KEY_SECRET} "<mandrill-key>", then rerun the same helper command.`;
  } else if (gatewayError && /policy|allowlist|blocked/i.test(gatewayError)) {
    layer = 'gateway-policy-denied';
    action =
      'Stop. Report the gateway policy denial and ask the operator to approve the exact emitted host, method, and path.';
  } else if (gatewayError) {
    layer = 'gateway-or-network';
    action =
      'Stop. Inspect hybridclaw gateway status, current logs, and the gateway error before retrying.';
  } else if (status === 401 || status === 403) {
    layer = 'credential-or-permission';
    action = `Stop after the first failure. Ask the operator to verify ${MARKETING_BASIC_AUTH_SECRET} or ${MARKETING_OAUTH_TOKEN_SECRET}, ${MANDRILL_API_KEY_SECRET}, the Mailchimp user role, and ${SERVER_PREFIX_ENV}.`;
  } else if (status === 429) {
    layer = 'rate-limit';
    action = 'Stop and report retry guidance from Retry-After or Mailchimp rate-limit headers when present.';
  } else if (status >= 500) {
    layer = 'mailchimp-service';
    action = 'Report the outage-class failure and avoid retry loops unless the operator asks for a later retry.';
  } else if (status >= 400) {
    layer = 'request-validation';
    action = 'Fix the helper flags or request body before retrying.';
  }
  return {
    command: 'classify-response',
    status,
    layer,
    action,
    upstream: {
      title: body.title || body.name || body.status || '',
      detail: gatewayError || body.detail || body.message || body.error || '',
    },
  };
}

function printHelp() {
  process.stdout.write(`Mailchimp skill helper

Usage:
  node skills/mailchimp/mailchimp.cjs --format json credential-check [--server-prefix us21]
  node skills/mailchimp/mailchimp.cjs --format json http-request <operation> [flags]
  node skills/mailchimp/mailchimp.cjs --format json approval-plan <operation> [flags]
  node skills/mailchimp/mailchimp.cjs --format json classify-response --status 401 --body-json '{}'

Marketing read operations:
  oauth.metadata
  marketing.root
  audience.list | audience.members | audience.member
  audience.merge-fields
  campaign.list | campaign.content-get | campaign.report
  automation.list | automation.get | journey.list | journey.get

Guarded Marketing writes:
  audience.member-upsert | audience.member-update | audience.member-archive
  audience.tags-update | audience.bulk-plan | audience.merge-field-create | audience.merge-field-update
  campaign.create | campaign.update | campaign.content-set | campaign.schedule | campaign.send

Transactional operations:
  mandrill.message-info
  mandrill.send | mandrill.send-template

Common flags:
  --server-prefix us21          Mailchimp data center prefix or MAILCHIMP_SERVER_PREFIX
  --auth api-key|oauth          Marketing auth mode (default api-key)
  --basic-auth-secret NAME      Runtime secret containing base64 username:api-key (default MAILCHIMP_MARKETING_BASIC_AUTH)
  --token-secret NAME           OAuth bearer token secret (default MAILCHIMP_MARKETING_OAUTH_TOKEN)
  --mandrill-secret NAME        Runtime secret for Mandrill key (default MANDRILL_API_KEY)
  --body-json JSON              Structured Mailchimp/Mandrill request body
  --operator-grant              Required only after explicit approval for amber/red operations
`);
}

function parseGlobalArgs(argv) {
  const args = [...argv];
  const format = popFlag(args, '--format', 'pretty');
  if (!['json', 'pretty'].includes(format)) die('--format must be json or pretty.');
  return { args, format };
}

function buildRequest(argv) {
  const { args } = parseGlobalArgs(argv);
  if (args.length === 0 || args[0] === '--help' || args[0] === 'help') {
    return { command: 'help' };
  }
  const command = args.shift();
  if (command === 'credential-check') return credentialCheck(args);
  if (command === 'classify-response') return classifyResponse(args);
  const operation = args.shift();
  if (!operation) die(`${command} requires an operation.`);
  if (command === 'http-request') return buildHttpRequest(operation, args);
  if (command === 'approval-plan') return buildApprovalPlan(operation, args);
  die(`Unknown command: ${command}`);
}

async function main() {
  if (process.argv.includes('--help')) {
    printHelp();
    return;
  }
  const { format } = parseGlobalArgs(process.argv.slice(2));
  const payload = buildRequest(process.argv.slice(2));
  if (payload.command === 'help') {
    printHelp();
    return;
  }
  const output = format === 'json' ? JSON.stringify(payload, null, 2) : `${JSON.stringify(payload, null, 2)}\n`;
  process.stdout.write(output);
  if (format === 'json') process.stdout.write('\n');
}

if (require.main === module) {
  main().catch((error) => die(error instanceof Error ? error.message : String(error)));
}

module.exports = {
  buildRequest,
  classifyResponse,
  credentialCheck,
  subscriberHash,
};
