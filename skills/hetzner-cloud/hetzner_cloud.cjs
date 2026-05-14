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
  'list-servers': 'green',
  'get-server': 'green',
  'list-server-types': 'green',
  'list-locations': 'green',
  'list-images': 'green',
  'list-prices': 'green',
  'list-volumes': 'green',
  'get-volume': 'green',
  'list-networks': 'green',
  'get-network': 'green',
  'create-server': 'amber',
  'create-volume': 'amber',
  'create-snapshot': 'amber',
  'attach-volume': 'amber',
  'detach-volume': 'amber',
  'attach-network': 'amber',
  'detach-network': 'amber',
  'rebuild-server': 'red',
  'restore-snapshot': 'red',
  'delete-server': 'red',
  'delete-vps': 'red',
  'delete-snapshot': 'red',
  'destroy-snapshot': 'red',
  'delete-volume': 'red',
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

function parseLabels(values) {
  const labels = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      die('--label must use key=value format.');
    }
    const key = value.slice(0, separator).trim();
    const labelValue = value.slice(separator + 1).trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(key)) {
      die(`Invalid label key: ${key}`);
    }
    labels[key] = labelValue;
  }
  return labels;
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
      `Refusing Hetzner Cloud ${operation} without --operator-grant. ` +
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
      skillName: 'hetzner-cloud',
    },
    costMeasurement: COST_MEASUREMENT,
  };
  if (json !== undefined) payload.httpRequest.json = json;
  return payload;
}

function buildPlan(text) {
  const normalized = text.toLowerCase();
  let operation = 'list-servers';
  if (/\b(price|cost|spend|monthly|tariff)\b/.test(normalized)) {
    operation = 'list-prices';
  } else if (/\b(server types?|plans?|sizes?)\b/.test(normalized)) {
    operation = 'list-server-types';
  } else if (/\b(locations?|datacenters?|falkenstein|fsn1|nuremberg|nbg1|helsinki|hel1)\b/.test(normalized)) {
    operation = 'list-locations';
  } else if (/\b(network|private ip|subnet)\b/.test(normalized) && /\b(list|show|find)\b/.test(normalized)) {
    operation = 'list-networks';
  } else if (/\b(network|private ip|subnet)\b/.test(normalized) && /\b(detach|remove)\b/.test(normalized)) {
    operation = 'detach-network';
  } else if (/\b(network|private ip|subnet)\b/.test(normalized) && /\b(attach|configure|connect)\b/.test(normalized)) {
    operation = 'attach-network';
  } else if (/\b(volume|disk)\b/.test(normalized) && /\b(list|show|find)\b/.test(normalized)) {
    operation = 'list-volumes';
  } else if (/\b(volume|disk)\b/.test(normalized) && /\b(create|add|new)\b/.test(normalized)) {
    operation = 'create-volume';
  } else if (/\b(volume|disk)\b/.test(normalized) && /\b(delete|destroy|remove)\b/.test(normalized)) {
    operation = 'delete-volume';
  } else if (/\b(volume|disk)\b/.test(normalized) && /\b(detach|unmount)\b/.test(normalized)) {
    operation = 'detach-volume';
  } else if (/\b(create|spin up|provision|launch|new vps|sandbox)\b/.test(normalized)) {
    operation = 'create-server';
  } else if (/\b(snapshot|backup image)\b/.test(normalized) && /\b(delete|remove|destroy)\b/.test(normalized)) {
    operation = 'destroy-snapshot';
  } else if (/\b(snapshot|pre-deploy|before deploy)\b/.test(normalized)) {
    operation = 'create-snapshot';
  } else if (/\b(rebuild|restore|rollback)\b/.test(normalized)) {
    operation = 'restore-snapshot';
  } else if (/\b(attach|mount)\b/.test(normalized) && /\b(volume|disk)\b/.test(normalized)) {
    operation = 'attach-volume';
  } else if (/\b(delete|destroy|tear down|remove)\b/.test(normalized)) {
    operation = 'delete-server';
  }
  const tier = OPERATION_TIERS[operation];
  return {
    command: 'plan',
    operation,
    stakesTier: tier,
    requiresEscalation: tier !== 'green',
    requiredGrant: tier === 'green' ? null : `approve-hetzner-cloud-${operation}`,
    secretPolicy: {
      bearerSecretName: TOKEN_SECRET,
      modelSeesToken: false,
    },
    costMeasurement: COST_MEASUREMENT,
  };
}

function commandHttpRequest(args) {
  const operation = args.shift();
  if (!operation) die('http-request requires an operation.');
  requireGrant(args, operation);

  switch (operation) {
    case 'list-servers': {
      const url = appendQuery(`${API_BASE}/servers`, {
        label_selector: popFlag(args, '--label-selector'),
        name: popFlag(args, '--name'),
        sort: popFlag(args, '--sort'),
      });
      return buildHttpRequest(operation, { url });
    }
    case 'get-server': {
      const serverId = parseInteger(popFlag(args, '--server-id'), '--server-id');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}`,
      });
    }
    case 'list-server-types':
      return buildHttpRequest(operation, { url: `${API_BASE}/server_types` });
    case 'list-locations':
      return buildHttpRequest(operation, { url: `${API_BASE}/locations` });
    case 'list-images': {
      const url = appendQuery(`${API_BASE}/images`, {
        type: popFlag(args, '--type'),
        label_selector: popFlag(args, '--label-selector'),
      });
      return buildHttpRequest(operation, { url });
    }
    case 'list-prices':
      return buildHttpRequest(operation, { url: `${API_BASE}/pricing` });
    case 'list-volumes': {
      const url = appendQuery(`${API_BASE}/volumes`, {
        label_selector: popFlag(args, '--label-selector'),
        name: popFlag(args, '--name'),
        sort: popFlag(args, '--sort'),
      });
      return buildHttpRequest(operation, { url });
    }
    case 'get-volume': {
      const volumeId = parseInteger(popFlag(args, '--volume-id'), '--volume-id');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/volumes/${volumeId}`,
      });
    }
    case 'list-networks': {
      const url = appendQuery(`${API_BASE}/networks`, {
        label_selector: popFlag(args, '--label-selector'),
        name: popFlag(args, '--name'),
        sort: popFlag(args, '--sort'),
      });
      return buildHttpRequest(operation, { url });
    }
    case 'get-network': {
      const networkId = parseInteger(popFlag(args, '--network-id'), '--network-id');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/networks/${networkId}`,
      });
    }
    case 'create-server': {
      const name = popFlag(args, '--name');
      const serverType = popFlag(args, '--server-type');
      const image = popFlag(args, '--image');
      if (!name || !serverType || !image) {
        die('create-server requires --name, --server-type, and --image.');
      }
      const json = {
        name,
        server_type: serverType,
        image,
        labels: parseLabels(popRepeatedFlag(args, '--label')),
      };
      const location = popFlag(args, '--location');
      const datacenter = popFlag(args, '--datacenter');
      const sshKeys = popRepeatedFlag(args, '--ssh-key');
      const networks = popRepeatedFlag(args, '--network').map((item) =>
        parseInteger(item, '--network'),
      );
      if (location) json.location = location;
      if (datacenter) json.datacenter = datacenter;
      if (sshKeys.length > 0) json.ssh_keys = sshKeys;
      if (networks.length > 0) json.networks = networks;
      return buildHttpRequest(operation, {
        url: `${API_BASE}/servers`,
        method: 'POST',
        json,
      });
    }
    case 'create-snapshot': {
      const serverId = parseInteger(popFlag(args, '--server-id'), '--server-id');
      const description = popFlag(args, '--description', 'snapshot');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}/actions/create_image`,
        method: 'POST',
        json: {
          type: 'snapshot',
          description,
          labels: parseLabels(popRepeatedFlag(args, '--label')),
        },
      });
    }
    case 'create-volume': {
      const name = popFlag(args, '--name');
      const size = parseInteger(popFlag(args, '--size-gb'), '--size-gb');
      if (!name) die('create-volume requires --name.');
      const json = {
        name,
        size,
        labels: parseLabels(popRepeatedFlag(args, '--label')),
      };
      const location = popFlag(args, '--location');
      const server = popFlag(args, '--server-id');
      if (location) json.location = location;
      if (server) json.server = parseInteger(server, '--server-id');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/volumes`,
        method: 'POST',
        json,
      });
    }
    case 'rebuild-server': {
      const serverId = parseInteger(popFlag(args, '--server-id'), '--server-id');
      const image = popFlag(args, '--image');
      if (!image) die('rebuild-server requires --image.');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}/actions/rebuild`,
        method: 'POST',
        json: { image },
      });
    }
    case 'restore-snapshot': {
      const serverId = parseInteger(popFlag(args, '--server-id'), '--server-id');
      const snapshotId =
        popFlag(args, '--snapshot-id') || popFlag(args, '--image-id');
      if (!snapshotId) die('restore-snapshot requires --snapshot-id.');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}/actions/rebuild`,
        method: 'POST',
        json: { image: parseInteger(snapshotId, '--snapshot-id') },
      });
    }
    case 'attach-volume': {
      const volumeId = parseInteger(popFlag(args, '--volume-id'), '--volume-id');
      const serverId = parseInteger(popFlag(args, '--server-id'), '--server-id');
      const automount = popBoolean(args, '--automount');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/volumes/${volumeId}/actions/attach`,
        method: 'POST',
        json: { server: serverId, automount },
      });
    }
    case 'detach-volume': {
      const volumeId = parseInteger(popFlag(args, '--volume-id'), '--volume-id');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/volumes/${volumeId}/actions/detach`,
        method: 'POST',
        json: {},
      });
    }
    case 'attach-network': {
      const serverId = parseInteger(popFlag(args, '--server-id'), '--server-id');
      const networkId = parseInteger(popFlag(args, '--network-id'), '--network-id');
      const json = { network: networkId };
      const ip = popFlag(args, '--ip');
      if (ip) json.ip = ip;
      return buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}/actions/attach_to_network`,
        method: 'POST',
        json,
      });
    }
    case 'detach-network': {
      const serverId = parseInteger(popFlag(args, '--server-id'), '--server-id');
      const networkId = parseInteger(popFlag(args, '--network-id'), '--network-id');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}/actions/detach_from_network`,
        method: 'POST',
        json: { network: networkId },
      });
    }
    case 'delete-server':
    case 'delete-vps': {
      const serverId = parseInteger(popFlag(args, '--server-id'), '--server-id');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}`,
        method: 'DELETE',
      });
    }
    case 'delete-snapshot':
    case 'destroy-snapshot': {
      const imageId = parseInteger(popFlag(args, '--image-id'), '--image-id');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/images/${imageId}`,
        method: 'DELETE',
      });
    }
    case 'delete-volume': {
      const volumeId = parseInteger(popFlag(args, '--volume-id'), '--volume-id');
      return buildHttpRequest(operation, {
        url: `${API_BASE}/volumes/${volumeId}`,
        method: 'DELETE',
      });
    }
    default:
      die(`Unknown Hetzner Cloud operation: ${operation}`);
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
  process.stdout.write(`Hetzner Cloud skill helper

Usage:
  node skills/hetzner-cloud/hetzner_cloud.cjs [--format json] plan <request>
  node skills/hetzner-cloud/hetzner_cloud.cjs [--format json] http-request <operation> [flags]
  node skills/hetzner-cloud/hetzner_cloud.cjs [--format json] eval-scenarios

Read operations:
  list-servers [--label-selector key=value] [--name name]
  get-server --server-id id
  list-server-types
  list-locations
  list-images [--type system|snapshot|backup] [--label-selector key=value]
  list-prices
  list-volumes [--label-selector key=value] [--name name]
  get-volume --volume-id id
  list-networks [--label-selector key=value] [--name name]
  get-network --network-id id

Write operations require --operator-grant:
  create-server --name name --server-type type --image image [--location fsn1] [--label key=value]
  create-volume --name name --size-gb 10 [--location fsn1] [--server-id id] [--label key=value]
  create-snapshot --server-id id [--description text] [--label key=value]
  restore-snapshot --server-id id --snapshot-id id
  rebuild-server --server-id id --image image
  attach-volume --volume-id id --server-id id [--automount]
  detach-volume --volume-id id
  attach-network --server-id id --network-id id [--ip 10.0.0.2]
  detach-network --server-id id --network-id id
  delete-server --server-id id
  delete-vps --server-id id
  delete-snapshot --image-id id
  destroy-snapshot --image-id id
  delete-volume --volume-id id
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
