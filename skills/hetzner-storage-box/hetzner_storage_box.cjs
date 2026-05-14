#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const API_BASE = 'https://api.hetzner.com/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const TOKEN_SECRET = 'HETZNER_API_TOKEN';
const WEBDAV_AUTH_SECRET = 'HETZNER_STORAGE_BOX_BASIC_AUTH';
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
  'list-storage-boxes': 'green',
  'get-storage-box': 'green',
  'list-snapshots': 'green',
  'list-files': 'green',
  'download-file': 'green',
  'public-url': 'green',
  'share-public-link': 'amber',
  'create-storage-box': 'amber',
  'update-storage-box': 'amber',
  'create-snapshot': 'amber',
  'upload-text': 'amber',
  'create-directory': 'amber',
  'archive-text': 'amber',
  'delete-storage-box': 'red',
  'delete-snapshot': 'red',
  'delete-path': 'red',
};

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

function cleanWebdavPath(rawPath) {
  const normalized = requireText(rawPath, '--path').replace(/\\/g, '/');
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    die('--path must not contain control characters.');
  }
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '..')) {
    die('--path must not contain parent directory segments.');
  }
  return `/${normalized.replace(/^\/+/, '')}`;
}

function encodeWebdavPath(webdavPath) {
  return webdavPath
    .split('/')
    .map((segment, index) => (index === 0 ? '' : encodeURIComponent(segment)))
    .join('/');
}

function normalizeHost(rawHost) {
  const host = requireText(rawHost, '--host').toLowerCase();
  if (!/^[a-z0-9-]+\.your-storagebox\.de$/.test(host)) {
    die('--host must be a Hetzner Storage Box host like u00000.your-storagebox.de.');
  }
  return host;
}

function requireGrant(args, operation) {
  if (OPERATION_TIERS[operation] === 'green') return false;
  const granted = popBoolean(args, '--operator-grant');
  if (!granted) {
    die(
      `Refusing Hetzner Storage Box ${operation} without --operator-grant. ` +
        'Run plan/read first and get an explicit operator grant.',
    );
  }
  return true;
}

function buildApiRequest(operation, { url, method = 'GET', json }) {
  const payload = {
    command: 'http-request',
    operation,
    stakesTier: OPERATION_TIERS[operation],
    httpRequest: {
      url,
      method,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      bearerSecretName: TOKEN_SECRET,
      skillName: 'hetzner-storage-box',
    },
    costMeasurement: COST_MEASUREMENT,
  };
  if (json !== undefined) payload.httpRequest.json = json;
  return payload;
}

function buildWebdavRequest(operation, { host, path: webdavPath, method, body }) {
  const payload = {
    command: 'webdav-request',
    operation,
    stakesTier: OPERATION_TIERS[operation],
    httpRequest: {
      url: `https://${host}${encodeWebdavPath(webdavPath)}`,
      method,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      secretHeaders: [
        {
          name: 'Authorization',
          secretName: WEBDAV_AUTH_SECRET,
          prefix: 'Basic',
        },
      ],
      skillName: 'hetzner-storage-box',
    },
    costMeasurement: COST_MEASUREMENT,
  };
  if (body !== undefined) payload.httpRequest.body = body;
  if (operation === 'list-files') {
    payload.httpRequest.headers = { Depth: '1' };
    payload.httpRequest.body = '<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>';
  }
  return payload;
}

function buildPlan(text) {
  const normalized = text.toLowerCase();
  let operation = 'list-storage-boxes';
  if (/\b(files?|folder|directory|archive)\b/.test(normalized) && /\b(list|show|inspect)\b/.test(normalized)) {
    operation = 'list-files';
  } else if (/\b(download|get)\b/.test(normalized) && /\b(file|manifest|invoice)\b/.test(normalized)) {
    operation = 'download-file';
  } else if (/\b(public link|share)\b/.test(normalized)) {
    operation = 'share-public-link';
  } else if (/\b(snapshot)\b/.test(normalized) && /\b(delete|remove|destroy)\b/.test(normalized)) {
    operation = 'delete-snapshot';
  } else if (/\b(snapshot)\b/.test(normalized)) {
    operation = 'create-snapshot';
  } else if (/\b(archive|upload)\b/.test(normalized)) {
    operation = 'archive-text';
  } else if (/\b(delete|remove|destroy)\b/.test(normalized) && /\b(file|path|folder|directory)\b/.test(normalized)) {
    operation = 'delete-path';
  } else if (/\b(delete|remove|destroy)\b/.test(normalized)) {
    operation = 'delete-storage-box';
  } else if (/\b(create|order|new)\b/.test(normalized) && /\bbox\b/.test(normalized)) {
    operation = 'create-storage-box';
  } else if (/\b(update|change|enable|disable)\b/.test(normalized)) {
    operation = 'update-storage-box';
  }
  const tier = OPERATION_TIERS[operation];
  return {
    command: 'plan',
    operation,
    stakesTier: tier,
    requiresEscalation: tier !== 'green',
    requiredGrant:
      tier === 'green' ? null : `approve-hetzner-storage-box-${operation}`,
    secretPolicy: {
      bearerSecretName: TOKEN_SECRET,
      webdavAuthSecretName: WEBDAV_AUTH_SECRET,
      modelSeesSecrets: false,
    },
    costMeasurement: COST_MEASUREMENT,
  };
}

function commandHttpRequest(args) {
  const operation = args.shift();
  if (!operation) die('http-request requires an operation.');
  requireGrant(args, operation);

  switch (operation) {
    case 'list-storage-boxes':
      return buildApiRequest(operation, { url: `${API_BASE}/storage_boxes` });
    case 'get-storage-box': {
      const boxId = parseInteger(popFlag(args, '--box-id'), '--box-id');
      return buildApiRequest(operation, {
        url: `${API_BASE}/storage_boxes/${boxId}`,
      });
    }
    case 'list-snapshots': {
      const boxId = parseInteger(popFlag(args, '--box-id'), '--box-id');
      return buildApiRequest(operation, {
        url: `${API_BASE}/storage_boxes/${boxId}/snapshots`,
      });
    }
    case 'create-snapshot': {
      const boxId = parseInteger(popFlag(args, '--box-id'), '--box-id');
      return buildApiRequest(operation, {
        url: `${API_BASE}/storage_boxes/${boxId}/snapshots`,
        method: 'POST',
        json: { description: popFlag(args, '--description', 'snapshot') },
      });
    }
    case 'delete-snapshot': {
      const boxId = parseInteger(popFlag(args, '--box-id'), '--box-id');
      const snapshotId = parseInteger(popFlag(args, '--snapshot-id'), '--snapshot-id');
      return buildApiRequest(operation, {
        url: `${API_BASE}/storage_boxes/${boxId}/snapshots/${snapshotId}`,
        method: 'DELETE',
      });
    }
    case 'create-storage-box': {
      const product = requireText(popFlag(args, '--product'), '--product');
      const location = popFlag(args, '--location');
      const name = popFlag(args, '--name');
      const json = { product };
      if (location) json.location = location;
      if (name) json.name = name;
      return buildApiRequest(operation, {
        url: `${API_BASE}/storage_boxes`,
        method: 'POST',
        json,
      });
    }
    case 'update-storage-box': {
      const boxId = parseInteger(popFlag(args, '--box-id'), '--box-id');
      const json = {};
      const name = popFlag(args, '--name');
      const externalReachability = popFlag(args, '--external-reachability');
      if (name) json.name = name;
      if (externalReachability) {
        if (!['true', 'false'].includes(externalReachability)) {
          die('--external-reachability must be true or false.');
        }
        json.external_reachability = externalReachability === 'true';
      }
      if (Object.keys(json).length === 0) {
        die('update-storage-box requires at least one setting flag.');
      }
      return buildApiRequest(operation, {
        url: `${API_BASE}/storage_boxes/${boxId}`,
        method: 'PUT',
        json,
      });
    }
    case 'delete-storage-box': {
      const boxId = parseInteger(popFlag(args, '--box-id'), '--box-id');
      return buildApiRequest(operation, {
        url: `${API_BASE}/storage_boxes/${boxId}`,
        method: 'DELETE',
      });
    }
    default:
      die(`Unknown Hetzner Storage Box API operation: ${operation}`);
  }
}

function commandWebdavRequest(args) {
  const operation = args.shift();
  if (!operation) die('webdav-request requires an operation.');
  requireGrant(args, operation);
  const host = normalizeHost(popFlag(args, '--host'));
  const webdavPath = cleanWebdavPath(popFlag(args, '--path'));

  switch (operation) {
    case 'list-files':
      return buildWebdavRequest(operation, {
        host,
        path: webdavPath,
        method: 'PROPFIND',
      });
    case 'download-file':
      return buildWebdavRequest(operation, {
        host,
        path: webdavPath,
        method: 'GET',
      });
    case 'upload-text':
    case 'archive-text':
      return buildWebdavRequest(operation, {
        host,
        path: webdavPath,
        method: 'PUT',
        body: requireText(popFlag(args, '--body'), '--body'),
      });
    case 'create-directory':
      return buildWebdavRequest(operation, {
        host,
        path: webdavPath,
        method: 'MKCOL',
      });
    case 'delete-path':
      return buildWebdavRequest(operation, {
        host,
        path: webdavPath,
        method: 'DELETE',
      });
    default:
      die(`Unknown Hetzner Storage Box WebDAV operation: ${operation}`);
  }
}

function commandPublicUrl(args) {
  const host = normalizeHost(popFlag(args, '--host'));
  const webdavPath = cleanWebdavPath(popFlag(args, '--path'));
  return {
    command: 'public-url',
    operation: 'public-url',
    stakesTier: OPERATION_TIERS['public-url'],
    url: `https://${host}${encodeWebdavPath(webdavPath)}`,
    note:
      'This only constructs a URL for an already public Storage Box path; it does not change permissions.',
    costMeasurement: COST_MEASUREMENT,
  };
}

function commandSharePublicLink(args) {
  const alreadyPublic = popBoolean(args, '--already-public');
  if (!alreadyPublic) {
    requireGrant(args, 'share-public-link');
  }
  const host = normalizeHost(popFlag(args, '--host'));
  const webdavPath = cleanWebdavPath(popFlag(args, '--path'));
  const expiresAt = popFlag(args, '--expires-at');
  return {
    command: 'share-public-link',
    operation: 'share-public-link',
    stakesTier: OPERATION_TIERS['share-public-link'],
    requiresOperatorAction: !alreadyPublic,
    publicUrl: `https://${host}${encodeWebdavPath(webdavPath)}`,
    expiresAt: expiresAt || null,
    operatorChecklist: alreadyPublic
      ? []
      : [
          'Confirm the Storage Box path is intended to be public.',
          'Enable public HTTPS/WebDAV serving or publish the file through the operator-approved web front end.',
          'Record the intended expiration or retention date.',
        ],
    note:
      'Storage Box file access is credentialed by default; this helper only emits a public-link handoff after explicit grant unless --already-public is used.',
    costMeasurement: COST_MEASUREMENT,
  };
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
  process.stdout.write(`Hetzner Storage Box skill helper

Usage:
  node skills/hetzner-storage-box/hetzner_storage_box.cjs [--format json] plan <request>
  node skills/hetzner-storage-box/hetzner_storage_box.cjs [--format json] http-request <operation> [flags]
  node skills/hetzner-storage-box/hetzner_storage_box.cjs [--format json] webdav-request <operation> [flags]
  node skills/hetzner-storage-box/hetzner_storage_box.cjs [--format json] public-url --host host --path path
  node skills/hetzner-storage-box/hetzner_storage_box.cjs [--format json] share-public-link --host host --path path [--already-public] [--expires-at date]
  node skills/hetzner-storage-box/hetzner_storage_box.cjs [--format json] eval-scenarios

API operations:
  list-storage-boxes
  get-storage-box --box-id id
  list-snapshots --box-id id
  create-snapshot --box-id id [--description text] --operator-grant
  create-storage-box --product product [--location fsn1] [--name name] --operator-grant
  update-storage-box --box-id id [--name name] [--external-reachability true|false] --operator-grant
  delete-snapshot --box-id id --snapshot-id id --operator-grant
  delete-storage-box --box-id id --operator-grant

WebDAV operations:
  list-files --host u00000.your-storagebox.de --path /path
  download-file --host u00000.your-storagebox.de --path /path/file
  upload-text --host u00000.your-storagebox.de --path /path/file --body text --operator-grant
  archive-text --host u00000.your-storagebox.de --path /archive/file --body text --operator-grant
  create-directory --host u00000.your-storagebox.de --path /path --operator-grant
  delete-path --host u00000.your-storagebox.de --path /path --operator-grant

Sharing operations:
  public-url --host u00000.your-storagebox.de --path /public/file
  share-public-link --host u00000.your-storagebox.de --path /public/file --operator-grant
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
  } else if (command === 'webdav-request') {
    payload = commandWebdavRequest(args);
  } else if (command === 'public-url') {
    payload = commandPublicUrl(args);
  } else if (command === 'share-public-link') {
    payload = commandSharePublicLink(args);
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
