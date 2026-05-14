#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const API_BASE = 'https://api.hetzner.cloud/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const TOKEN_SECRET = 'HETZNER_API_TOKEN';
const EVAL_SCENARIOS_PATH = path.join(__dirname, 'evals', 'scenarios.json');

const COST_MEASUREMENT = {
  system: 'UsageTotals',
  source: 'HybridClaw usage_events',
  scope: 'per assistant run/session',
  fields: [
    'total_input_tokens',
    'total_output_tokens',
    'total_tokens',
    'total_cost_usd',
    'call_count',
    'total_tool_calls',
  ],
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

function die(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function popFlag(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    die(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function popRepeatedFlag(args, name) {
  const values = [];
  let index = args.indexOf(name);
  while (index !== -1) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      die(`${name} requires a value.`);
    }
    values.push(value);
    args.splice(index, 2);
    index = args.indexOf(name);
  }
  return values;
}

function popBoolean(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function parseInteger(raw, label) {
  if (!/^\d+$/.test(String(raw ?? ''))) {
    die(`${label} must be a positive integer.`);
  }
  return Number.parseInt(raw, 10);
}

function requireText(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) die(`${label} is required.`);
  return normalized;
}

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

function normalizeRecords(records) {
  if (records.length === 0) die('At least one --record value is required.');
  return records.map((value) => ({ value }));
}

function appendQuery(url, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${url}?${text}` : url;
}

function requireGrant(args, operation) {
  if (OPERATION_TIERS[operation] === 'green') return false;
  const granted = popBoolean(args, '--operator-grant');
  if (!granted) {
    die(
      `Refusing Hetzner DNS ${operation} without --operator-grant. ` +
        'Run plan/read first and get an explicit operator grant.',
    );
  }
  return true;
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
      bearerSecretName: TOKEN_SECRET,
      skillName: 'hetzner-dns',
    },
    costMeasurement: COST_MEASUREMENT,
  };
  if (json !== undefined) payload.httpRequest.json = json;
  return payload;
}

function buildPlan(text) {
  const normalized = text.toLowerCase();
  let operation = 'list-rrsets';
  if (/\b(zones?|domains?)\b/.test(normalized) && /\b(list|show|find)\b/.test(normalized)) {
    operation = 'list-zones';
  } else if (/\b(delete|remove|destroy)\b/.test(normalized) && /\b(zone|domain)\b/.test(normalized)) {
    operation = 'delete-zone';
  } else if (/\b(delete|destroy|tear down)\b/.test(normalized)) {
    operation = 'delete-record';
  } else if (/\b(add)\b/.test(normalized) && /\b(value|record)\b/.test(normalized)) {
    operation = 'add-record';
  } else if (/\b(remove)\b/.test(normalized) && /\b(value|txt|record)\b/.test(normalized)) {
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
      bearerSecretName: TOKEN_SECRET,
      modelSeesToken: false,
    },
    costMeasurement: COST_MEASUREMENT,
  };
}

function rrsetPath(args) {
  const zone = encodeSegment(popFlag(args, '--zone'), '--zone');
  const name = encodeSegment(popFlag(args, '--name'), '--name');
  const type = encodeSegment(normalizeRecordType(popFlag(args, '--type')), '--type');
  return `${API_BASE}/zones/${zone}/rrsets/${name}/${type}`;
}

function rrsetPayload(args) {
  const type = normalizeRecordType(popFlag(args, '--type'));
  const ttlRaw = popFlag(args, '--ttl', '300');
  const ttl = parseInteger(ttlRaw, '--ttl');
  if (ttl < 60) die('--ttl must be at least 60 seconds.');
  const payload = {
    name: requireText(popFlag(args, '--name'), '--name'),
    type,
    ttl,
    records: normalizeRecords(popRepeatedFlag(args, '--record')),
  };
  const comment = popFlag(args, '--comment');
  if (comment) {
    payload.records = payload.records.map((record) => ({
      ...record,
      comment,
    }));
  }
  return payload;
}

function commandHttpRequest(args) {
  const operation = args.shift();
  if (!operation) die('http-request requires an operation.');
  requireGrant(args, operation);

  switch (operation) {
    case 'list-zones': {
      const url = appendQuery(`${API_BASE}/zones`, {
        name: popFlag(args, '--name'),
        label_selector: popFlag(args, '--label-selector'),
      });
      return buildHttpRequest(operation, { url });
    }
    case 'get-zone': {
      const zone = encodeSegment(popFlag(args, '--zone'), '--zone');
      return buildHttpRequest(operation, { url: `${API_BASE}/zones/${zone}` });
    }
    case 'list-rrsets': {
      const zone = encodeSegment(popFlag(args, '--zone'), '--zone');
      const url = appendQuery(`${API_BASE}/zones/${zone}/rrsets`, {
        name: popFlag(args, '--name'),
        type: popFlag(args, '--type')?.toUpperCase(),
      });
      return buildHttpRequest(operation, { url });
    }
    case 'get-rrset':
      return buildHttpRequest(operation, { url: rrsetPath(args) });
    case 'create-rrset': {
      const zone = encodeSegment(popFlag(args, '--zone'), '--zone');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/zones/${zone}/rrsets`,
        method: 'POST',
        json: rrsetPayload(args),
      });
    }
    case 'update-rrset':
      return buildHttpRequest(operation, {
        url: rrsetPath(args),
        method: 'PUT',
        json: {
          ttl: parseInteger(popFlag(args, '--ttl', '300'), '--ttl'),
          records: normalizeRecords(popRepeatedFlag(args, '--record')),
        },
      });
    case 'add-record':
      return buildHttpRequest(operation, {
        url: `${rrsetPath(args)}/actions/add_records`,
        method: 'POST',
        json: {
          records: normalizeRecords(popRepeatedFlag(args, '--record')),
        },
      });
    case 'remove-record':
      return buildHttpRequest(operation, {
        url: `${rrsetPath(args)}/actions/remove_records`,
        method: 'POST',
        json: {
          records: normalizeRecords(popRepeatedFlag(args, '--record')),
        },
      });
    case 'delete-record':
    case 'delete-rrset':
      return buildHttpRequest(operation, {
        url: rrsetPath(args),
        method: 'DELETE',
      });
    case 'delete-zone': {
      const zone = encodeSegment(popFlag(args, '--zone'), '--zone');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/zones/${zone}`,
        method: 'DELETE',
      });
    }
    default:
      die(`Unknown Hetzner DNS operation: ${operation}`);
  }
}

function commandEvalScenarios() {
  const scenarios = JSON.parse(fs.readFileSync(EVAL_SCENARIOS_PATH, 'utf-8'));
  const categories = {};
  let failed = 0;
  for (const scenario of scenarios) {
    categories[scenario.category] = (categories[scenario.category] || 0) + 1;
    if (
      !scenario.expectedOperation ||
      !scenario.expectedTier ||
      scenario.costMeasurement?.system !== 'UsageTotals'
    ) {
      failed += 1;
    }
  }
  return {
    command: 'eval-scenarios',
    scenarioCount: scenarios.length,
    failed,
    categories,
    costMeasurement: COST_MEASUREMENT,
  };
}

function showHelp() {
  process.stdout.write(`Hetzner DNS skill helper

Usage:
  node skills/hetzner-dns/hetzner_dns.cjs [--format json] plan <request>
  node skills/hetzner-dns/hetzner_dns.cjs [--format json] http-request <operation> [flags]
  node skills/hetzner-dns/hetzner_dns.cjs [--format json] eval-scenarios

Read operations:
  list-zones [--name example.com]
  get-zone --zone example.com
  list-rrsets --zone example.com [--name demo] [--type A]
  get-rrset --zone example.com --name demo --type A

Write operations require --operator-grant:
  create-rrset --zone zone --name name --type A --ttl 300 --record value
  update-rrset --zone zone --name name --type A --ttl 300 --record value
  add-record --zone zone --name name --type TXT --record value
  remove-record --zone zone --name name --type TXT --record value
  delete-record --zone zone --name name --type A
  delete-rrset --zone zone --name name --type A
  delete-zone --zone zone
`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    showHelp();
    return;
  }
  const format = popFlag(args, '--format', 'text');
  const command = args.shift();
  let payload;
  if (command === 'plan') {
    payload = buildPlan(args.join(' '));
  } else if (command === 'http-request') {
    payload = commandHttpRequest(args);
  } else if (command === 'eval-scenarios') {
    payload = commandEvalScenarios();
  } else {
    die(`Unknown command: ${command}`);
  }

  if (format === 'json') {
    printJson(payload);
  } else {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

main();
