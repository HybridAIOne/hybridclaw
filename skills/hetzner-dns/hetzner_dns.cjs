#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  COST_MEASUREMENT,
  appendQuery,
  assertNoUnexpectedArgs,
  commandEvalScenarios: buildEvalScenarios,
  die,
  parseInteger,
  popFlag,
  popRepeatedFlag,
  requireGrant,
  requireText,
  runMain,
  validateOperation,
} = require('./hetzner-shared.cjs');

const API_BASE = 'https://dns.hetzner.com/api/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const TOKEN_SECRET = 'HETZNER_DNS_API_TOKEN';
const EVAL_SCENARIOS_PATH = path.join(__dirname, 'evals', 'scenarios.json');
const LIVE_EXECUTION = {
  mode: 'live-hetzner-dns-api',
  requiresConfiguredSecrets: [TOKEN_SECRET],
  dryRunSafe:
    'For prompt/user testing, stop after producing this payload; do not call http_request.',
  callPolicy:
    'Use this CJS helper as the API wrapper. For real user requests that need live Hetzner DNS data, pass the emitted httpRequest object unchanged to http_request and let the gateway inject the token server-side.',
  secretRefPolicy:
    'Do not preflight, inspect, print, or ask the model for HETZNER_DNS_API_TOKEN. The secretHeaders entry is the credential reference.',
  requestShape:
    'Do not handcraft Hetzner DNS API calls. The helper owns the endpoint, method, payload, tier, and Auth-API-Token secret header.',
  unauthorizedPolicy:
    'If a live call returns 401 or 403, stop after the first failure. Do not retry or call additional Hetzner DNS endpoints; ask the operator to set or verify HETZNER_DNS_API_TOKEN.',
};

const OPERATION_TIERS = {
  'list-zones': 'green',
  'get-zone': 'green',
  'list-rrsets': 'green',
  'get-rrset': 'green',
  'create-rrset': 'amber',
  'update-rrset': 'amber',
  'add-record': 'amber',
  'remove-record': 'amber',
  'delete-record': 'red',
  'delete-rrset': 'red',
  'delete-zone': 'red',
};
const HTTP_OPERATIONS = new Set(Object.keys(OPERATION_TIERS));

const RECORD_TYPES = new Set([
  'A',
  'AAAA',
  'CAA',
  'CNAME',
  'DS',
  'HINFO',
  'HTTPS',
  'MX',
  'NS',
  'PTR',
  'RP',
  'SOA',
  'SRV',
  'SVCB',
  'TLSA',
  'TXT',
]);

function encodeSegment(value, label) {
  return encodeURIComponent(requireText(value, label));
}

function normalizeRecordType(raw) {
  const type = requireText(raw, '--type').toUpperCase();
  if (!RECORD_TYPES.has(type)) {
    die(`Unsupported DNS record type: ${type}`);
  }
  return type;
}

function buildHttpRequest(operation, { url, method = 'GET', json }) {
  const payload = {
    command: 'http-request',
    operation,
    stakesTier: OPERATION_TIERS[operation],
    httpRequest: {
      url,
      method,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      secretHeaders: [
        {
          name: 'Auth-API-Token',
          secretName: TOKEN_SECRET,
          prefix: 'none',
        },
      ],
      skillName: 'hetzner-dns',
      stakesTier: OPERATION_TIERS[operation],
    },
    costMeasurement: COST_MEASUREMENT,
    liveExecution: LIVE_EXECUTION,
  };
  if (json !== undefined) payload.httpRequest.json = json;
  return payload;
}

function buildPlan(text) {
  const normalized = text.toLowerCase();
  let operation = 'list-rrsets';
  if (
    /\b(zones?|domains?)\b/.test(normalized) &&
    /\b(list|show|find)\b/.test(normalized)
  ) {
    operation = 'list-zones';
  } else if (
    /\b(delete|remove|destroy)\b/.test(normalized) &&
    /\b(zone|domain)\b/.test(normalized)
  ) {
    operation = 'delete-zone';
  } else if (/\b(delete|destroy|tear down)\b/.test(normalized)) {
    operation = 'delete-record';
  } else if (
    /\b(add)\b/.test(normalized) &&
    /\b(value|record)\b/.test(normalized)
  ) {
    operation = 'add-record';
  } else if (
    /\b(remove)\b/.test(normalized) &&
    /\b(value|txt|record)\b/.test(normalized)
  ) {
    operation = 'remove-record';
  } else if (/\b(update|change|point|replace|set)\b/.test(normalized)) {
    operation = 'update-rrset';
  } else if (/\b(create|add|new)\b/.test(normalized)) {
    operation = 'create-rrset';
  } else if (/\b(check|get|current)\b/.test(normalized)) {
    operation = 'get-rrset';
  }
  const tier = OPERATION_TIERS[operation];
  return {
    command: 'plan',
    operation,
    stakesTier: tier,
    requiresEscalation: tier !== 'green',
    requiredGrant: tier === 'green' ? null : `approve-hetzner-dns-${operation}`,
    secretPolicy: {
      authHeaderSecretName: TOKEN_SECRET,
      authHeaderName: 'Auth-API-Token',
      modelSeesToken: false,
    },
    costMeasurement: COST_MEASUREMENT,
  };
}

function dnsRecordPayload(args) {
  const zoneId = requireText(
    popFlag(args, '--zone-id') || popFlag(args, '--zone'),
    '--zone-id',
  );
  const type = normalizeRecordType(popFlag(args, '--type'));
  const ttlRaw = popFlag(args, '--ttl', '300');
  const ttl = parseInteger(ttlRaw, '--ttl');
  if (ttl < 60) die('--ttl must be at least 60 seconds.');
  const records = popRepeatedFlag(args, '--record', { allowDashValue: true });
  if (records.length !== 1) {
    die('Hetzner DNS API record writes require exactly one --record value.');
  }
  const payload = {
    zone_id: zoneId,
    name: requireText(popFlag(args, '--name'), '--name'),
    type,
    value: records[0],
    ttl,
  };
  const comment = popFlag(args, '--comment');
  if (comment) {
    die('--comment is not supported by the Hetzner DNS API record endpoint.');
  }
  return payload;
}

function recordId(args) {
  return encodeSegment(popFlag(args, '--record-id'), '--record-id');
}

function recordListUrl(args) {
  return appendQuery(`${API_BASE}/records`, {
    zone_id: popFlag(args, '--zone-id') || popFlag(args, '--zone'),
    name: popFlag(args, '--name'),
    type: popFlag(args, '--type')?.toUpperCase(),
  });
}

function commandHttpRequest(args) {
  const operation = args.shift();
  if (!operation) die('http-request requires an operation.');
  validateOperation(operation, HTTP_OPERATIONS, 'Hetzner DNS');
  requireGrant(args, operation, OPERATION_TIERS, 'Hetzner DNS');

  let payload;
  switch (operation) {
    case 'list-zones': {
      const url = appendQuery(`${API_BASE}/zones`, {
        name: popFlag(args, '--name'),
      });
      payload = buildHttpRequest(operation, { url });
      break;
    }
    case 'get-zone': {
      const zone = encodeSegment(
        popFlag(args, '--zone-id') || popFlag(args, '--zone'),
        '--zone-id',
      );
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/zones/${zone}`,
      });
      break;
    }
    case 'list-rrsets':
      payload = buildHttpRequest(operation, { url: recordListUrl(args) });
      break;
    case 'get-rrset': {
      const id = popFlag(args, '--record-id');
      if (id) {
        payload = buildHttpRequest(operation, {
          url: `${API_BASE}/records/${encodeSegment(id, '--record-id')}`,
        });
        break;
      }
      payload = buildHttpRequest(operation, { url: recordListUrl(args) });
      break;
    }
    case 'create-rrset':
    case 'add-record':
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/records`,
        method: 'POST',
        json: dnsRecordPayload(args),
      });
      break;
    case 'update-rrset':
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/records/${recordId(args)}`,
        method: 'PUT',
        json: dnsRecordPayload(args),
      });
      break;
    case 'remove-record':
    case 'delete-record':
    case 'delete-rrset':
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/records/${recordId(args)}`,
        method: 'DELETE',
      });
      break;
    case 'delete-zone': {
      const zone = encodeSegment(
        popFlag(args, '--zone-id') || popFlag(args, '--zone'),
        '--zone-id',
      );
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/zones/${zone}`,
        method: 'DELETE',
      });
      break;
    }
    default:
      die(`Unknown Hetzner DNS operation: ${operation}`);
  }
  assertNoUnexpectedArgs(args);
  return payload;
}

function commandEvalScenarios() {
  return buildEvalScenarios(EVAL_SCENARIOS_PATH);
}

function showHelp() {
  process.stdout.write(`Hetzner DNS skill helper

Usage:
  node skills/hetzner-dns/hetzner_dns.cjs [--format json] plan <request>
  node skills/hetzner-dns/hetzner_dns.cjs [--format json] http-request <operation> [flags]
  node skills/hetzner-dns/hetzner_dns.cjs [--format json] eval-scenarios

Read operations:
  list-zones [--name example.com]
  get-zone --zone-id zone-id
  list-rrsets --zone-id zone-id [--name demo] [--type A]
  get-rrset --record-id record-id

Write operations require --operator-grant:
  create-rrset --zone-id zone-id --name name --type A --ttl 300 --record value
  update-rrset --record-id record-id --zone-id zone-id --name name --type A --ttl 300 --record value
  add-record --zone-id zone-id --name name --type TXT --record value
  remove-record --record-id record-id
  delete-record --record-id record-id
  delete-rrset --record-id record-id
  delete-zone --zone-id zone-id
`);
}

runMain({
  showHelp,
  buildPlan,
  handlers: {
    'http-request': commandHttpRequest,
    'eval-scenarios': commandEvalScenarios,
  },
});
