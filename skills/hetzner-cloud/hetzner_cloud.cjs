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
  popBoolean,
  popFlag,
  popRepeatedFlag,
  requireGrant,
  runMain,
  validateOperation,
} = require('./hetzner-shared.cjs');

const API_BASE = 'https://api.hetzner.cloud/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const TOKEN_SECRET = 'HETZNER_API_TOKEN';
const EVAL_SCENARIOS_PATH = path.join(__dirname, 'evals', 'scenarios.json');
const LIVE_EXECUTION = {
  mode: 'live-hetzner-api',
  requiresConfiguredSecrets: [TOKEN_SECRET],
  dryRunSafe:
    'For prompt/user testing, stop after producing this payload; do not call http_request.',
  approvalPolicy:
    'Changing actions that delete, upgrade, downgrade, buy, create, restore, attach, detach, snapshot, or modify resources require an explicit operator approval before --operator-grant may be used.',
  callPolicy:
    'Use this CJS helper as the API wrapper. For real user requests that need live Hetzner data, pass the emitted httpRequest object unchanged to http_request and let the gateway inject the token server-side.',
  secretRefPolicy:
    'Do not preflight, inspect, print, or ask the model for HETZNER_API_TOKEN. The bearerSecretName field is the credential reference.',
  requestShape:
    'Do not handcraft Hetzner API calls. The helper owns the endpoint, method, payload, tier, and bearerSecretName.',
  unauthorizedPolicy:
    'If a live call returns 401 or 403, stop after the first failure. Do not retry or call additional Hetzner endpoints; ask the operator to set or verify HETZNER_API_TOKEN.',
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
  'change-server-type': 'amber',
  'upgrade-server': 'amber',
  'downgrade-server': 'amber',
  'restore-snapshot': 'red',
  'delete-server': 'red',
  'delete-vps': 'red',
  'delete-snapshot': 'red',
  'destroy-snapshot': 'red',
  'delete-volume': 'red',
};
const HTTP_OPERATIONS = new Set(Object.keys(OPERATION_TIERS));

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

function readProjectFlag(args) {
  const project = popFlag(args, '--project');
  if (!project) return null;
  const normalized = project.trim();
  if (!normalized) die('--project requires a value.');
  return normalized;
}

function mergeProjectLabelSelector(labelSelector, project) {
  if (!project) return labelSelector;
  if (!labelSelector) return `project=${project}`;
  if (/(^|,)project(?:[!<>=]|$)/.test(labelSelector)) return labelSelector;
  return `project=${project},${labelSelector}`;
}

function parseLabelsWithProject(values, project) {
  const normalizedValues = [...values];
  if (
    project &&
    !normalizedValues.some((value) => String(value).startsWith('project='))
  ) {
    normalizedValues.push(`project=${project}`);
  }
  return parseLabels(normalizedValues);
}

function parseOptionalInteger(value, flagName) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  return parseInteger(normalized, flagName);
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
    liveExecution: LIVE_EXECUTION,
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
  } else if (
    /\b(locations?|datacenters?|falkenstein|fsn1|nuremberg|nbg1|helsinki|hel1)\b/.test(
      normalized,
    ) &&
    /\b(list|show|find|which|available|can i use)\b/.test(normalized)
  ) {
    operation = 'list-locations';
  } else if (
    /\b(network|private ip|subnet)\b/.test(normalized) &&
    /\b(list|show|find)\b/.test(normalized)
  ) {
    operation = 'list-networks';
  } else if (
    /\b(network|private ip|subnet)\b/.test(normalized) &&
    /\b(detach|remove)\b/.test(normalized)
  ) {
    operation = 'detach-network';
  } else if (
    /\b(network|private ip|subnet)\b/.test(normalized) &&
    /\b(attach|configure|connect)\b/.test(normalized)
  ) {
    operation = 'attach-network';
  } else if (
    /\b(volume|disk)\b/.test(normalized) &&
    /\b(list|show|find)\b/.test(normalized)
  ) {
    operation = 'list-volumes';
  } else if (
    /\b(volume|disk)\b/.test(normalized) &&
    /\b(create|add|new)\b/.test(normalized)
  ) {
    operation = 'create-volume';
  } else if (
    /\b(volume|disk)\b/.test(normalized) &&
    /\b(delete|destroy|remove)\b/.test(normalized)
  ) {
    operation = 'delete-volume';
  } else if (
    /\b(volume|disk)\b/.test(normalized) &&
    /\b(detach|unmount)\b/.test(normalized)
  ) {
    operation = 'detach-volume';
  } else if (/\b(upgrade|downgrade|change type|resize)\b/.test(normalized)) {
    operation = normalized.includes('upgrade')
      ? 'upgrade-server'
      : normalized.includes('downgrade')
        ? 'downgrade-server'
        : 'change-server-type';
  } else if (
    /\b(create|spin up|provision|launch|new vps|sandbox|buy|purchase)\b/.test(
      normalized,
    )
  ) {
    operation = 'create-server';
  } else if (
    /\b(snapshot|backup image)\b/.test(normalized) &&
    /\b(delete|remove|destroy)\b/.test(normalized)
  ) {
    operation = 'destroy-snapshot';
  } else if (/\b(snapshot|pre-deploy|before deploy)\b/.test(normalized)) {
    operation = 'create-snapshot';
  } else if (/\b(restore|rollback)\b/.test(normalized)) {
    operation = 'restore-snapshot';
  } else if (
    /\bvps\b/.test(normalized) &&
    /\b(delete|destroy|tear down|remove)\b/.test(normalized)
  ) {
    operation = 'delete-vps';
  } else if (
    /\b(attach|mount)\b/.test(normalized) &&
    /\b(volume|disk)\b/.test(normalized)
  ) {
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
    requiredGrant:
      tier === 'green' ? null : `approve-hetzner-cloud-${operation}`,
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
  validateOperation(operation, HTTP_OPERATIONS, 'Hetzner Cloud');
  requireGrant(args, operation, OPERATION_TIERS, 'Hetzner Cloud');
  const project = readProjectFlag(args);

  let payload;
  switch (operation) {
    case 'list-servers': {
      const url = appendQuery(`${API_BASE}/servers`, {
        label_selector: mergeProjectLabelSelector(
          popFlag(args, '--label-selector'),
          project,
        ),
        name: popFlag(args, '--name'),
        sort: popFlag(args, '--sort'),
      });
      payload = buildHttpRequest(operation, { url });
      break;
    }
    case 'get-server': {
      const serverId = parseInteger(
        popFlag(args, '--server-id'),
        '--server-id',
      );
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}`,
      });
      break;
    }
    case 'list-server-types': {
      const url = appendQuery(`${API_BASE}/server_types`, {
        name: popFlag(args, '--name'),
      });
      payload = buildHttpRequest(operation, {
        url,
      });
      break;
    }
    case 'list-locations':
      payload = buildHttpRequest(operation, { url: `${API_BASE}/locations` });
      break;
    case 'list-images': {
      const url = appendQuery(`${API_BASE}/images`, {
        type: popFlag(args, '--type'),
        label_selector: mergeProjectLabelSelector(
          popFlag(args, '--label-selector'),
          project,
        ),
      });
      payload = buildHttpRequest(operation, { url });
      break;
    }
    case 'list-prices':
      payload = buildHttpRequest(operation, { url: `${API_BASE}/pricing` });
      break;
    case 'list-volumes': {
      const url = appendQuery(`${API_BASE}/volumes`, {
        label_selector: mergeProjectLabelSelector(
          popFlag(args, '--label-selector'),
          project,
        ),
        name: popFlag(args, '--name'),
        sort: popFlag(args, '--sort'),
      });
      payload = buildHttpRequest(operation, { url });
      break;
    }
    case 'get-volume': {
      const volumeId = parseInteger(
        popFlag(args, '--volume-id'),
        '--volume-id',
      );
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/volumes/${volumeId}`,
      });
      break;
    }
    case 'list-networks': {
      const url = appendQuery(`${API_BASE}/networks`, {
        label_selector: mergeProjectLabelSelector(
          popFlag(args, '--label-selector'),
          project,
        ),
        name: popFlag(args, '--name'),
        sort: popFlag(args, '--sort'),
      });
      payload = buildHttpRequest(operation, { url });
      break;
    }
    case 'get-network': {
      const networkId = parseInteger(
        popFlag(args, '--network-id'),
        '--network-id',
      );
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/networks/${networkId}`,
      });
      break;
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
        labels: parseLabelsWithProject(
          popRepeatedFlag(args, '--label'),
          project,
        ),
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
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/servers`,
        method: 'POST',
        json,
      });
      break;
    }
    case 'create-snapshot': {
      const serverId = parseInteger(
        popFlag(args, '--server-id'),
        '--server-id',
      );
      const description = popFlag(args, '--description', 'snapshot', {
        allowDashValue: true,
      });
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}/actions/create_image`,
        method: 'POST',
        json: {
          type: 'snapshot',
          description,
          labels: parseLabelsWithProject(
            popRepeatedFlag(args, '--label'),
            project,
          ),
        },
      });
      break;
    }
    case 'create-volume': {
      const name = popFlag(args, '--name');
      const size = parseInteger(popFlag(args, '--size-gb'), '--size-gb');
      if (!name) die('create-volume requires --name.');
      const json = {
        name,
        size,
        labels: parseLabelsWithProject(
          popRepeatedFlag(args, '--label'),
          project,
        ),
      };
      const location = popFlag(args, '--location');
      const server = popFlag(args, '--server-id');
      if (location) json.location = location;
      if (server) json.server = parseInteger(server, '--server-id');
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/volumes`,
        method: 'POST',
        json,
      });
      break;
    }
    case 'restore-snapshot': {
      const serverId = parseInteger(
        popFlag(args, '--server-id'),
        '--server-id',
      );
      const snapshotId =
        popFlag(args, '--snapshot-id') || popFlag(args, '--image-id');
      if (!snapshotId) die('restore-snapshot requires --snapshot-id.');
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}/actions/rebuild`,
        method: 'POST',
        json: { image: parseInteger(snapshotId, '--snapshot-id') },
      });
      break;
    }
    case 'attach-volume': {
      const volumeId = parseInteger(
        popFlag(args, '--volume-id'),
        '--volume-id',
      );
      const serverId = parseInteger(
        popFlag(args, '--server-id'),
        '--server-id',
      );
      const automount = popBoolean(args, '--automount');
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/volumes/${volumeId}/actions/attach`,
        method: 'POST',
        json: { server: serverId, automount },
      });
      break;
    }
    case 'detach-volume': {
      const volumeId = parseInteger(
        popFlag(args, '--volume-id'),
        '--volume-id',
      );
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/volumes/${volumeId}/actions/detach`,
        method: 'POST',
        json: {},
      });
      break;
    }
    case 'attach-network': {
      const serverId = parseInteger(
        popFlag(args, '--server-id'),
        '--server-id',
      );
      const networkId = parseInteger(
        popFlag(args, '--network-id'),
        '--network-id',
      );
      const json = { network: networkId };
      const ip = popFlag(args, '--ip');
      if (ip) json.ip = ip;
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}/actions/attach_to_network`,
        method: 'POST',
        json,
      });
      break;
    }
    case 'detach-network': {
      const serverId = parseInteger(
        popFlag(args, '--server-id'),
        '--server-id',
      );
      const networkId = parseInteger(
        popFlag(args, '--network-id'),
        '--network-id',
      );
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}/actions/detach_from_network`,
        method: 'POST',
        json: { network: networkId },
      });
      break;
    }
    case 'change-server-type':
    case 'upgrade-server':
    case 'downgrade-server': {
      const serverId = parseInteger(
        popFlag(args, '--server-id'),
        '--server-id',
      );
      const serverTypeIdFlag = popFlag(args, '--server-type-id');
      const serverTypeName = popFlag(args, '--server-type');
      const serverType =
        parseOptionalInteger(serverTypeIdFlag, '--server-type-id') ??
        parseOptionalInteger(serverTypeName, '--server-type');
      if (!serverType) {
        if (serverTypeName) {
          die(
            `${operation} requires a numeric --server-type-id for change_type. Run list-server-types --name ${serverTypeName} first, then rerun with the returned id.`,
          );
        }
        die(`${operation} requires --server-type-id.`);
      }
      const upgradeDisk = popBoolean(args, '--upgrade-disk');
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}/actions/change_type`,
        method: 'POST',
        json: {
          server_type: serverType,
          upgrade_disk: upgradeDisk,
        },
      });
      break;
    }
    case 'delete-server':
    case 'delete-vps': {
      const serverId = parseInteger(
        popFlag(args, '--server-id'),
        '--server-id',
      );
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/servers/${serverId}`,
        method: 'DELETE',
      });
      break;
    }
    case 'delete-snapshot':
    case 'destroy-snapshot': {
      const imageId = parseInteger(popFlag(args, '--image-id'), '--image-id');
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/images/${imageId}`,
        method: 'DELETE',
      });
      break;
    }
    case 'delete-volume': {
      const volumeId = parseInteger(
        popFlag(args, '--volume-id'),
        '--volume-id',
      );
      payload = buildHttpRequest(operation, {
        url: `${API_BASE}/volumes/${volumeId}`,
        method: 'DELETE',
      });
      break;
    }
    default:
      die(`Unknown Hetzner Cloud operation: ${operation}`);
  }
  assertNoUnexpectedArgs(args);
  return payload;
}

function commandEvalScenarios() {
  return buildEvalScenarios(EVAL_SCENARIOS_PATH);
}

function showHelp() {
  process.stdout.write(`Hetzner Cloud skill helper

Usage:
  node skills/hetzner-cloud/hetzner_cloud.cjs [--format json] plan <request>
  node skills/hetzner-cloud/hetzner_cloud.cjs [--format json] http-request <operation> [flags]
  node skills/hetzner-cloud/hetzner_cloud.cjs [--format json] eval-scenarios

Read operations:
  list-servers [--project name] [--label-selector key=value] [--name name]
  get-server --server-id id
  list-server-types [--name name]
  list-locations
  list-images [--project name] [--type system|snapshot|backup] [--label-selector key=value]
  list-prices [--project name]
  list-volumes [--project name] [--label-selector key=value] [--name name]
  get-volume --volume-id id
  list-networks [--project name] [--label-selector key=value] [--name name]
  get-network --network-id id

Write operations require --operator-grant:
  create-server --project name --name name --server-type type --image image [--location fsn1] [--label key=value]
  create-volume --project name --name name --size-gb 10 [--location fsn1] [--server-id id] [--label key=value]
  create-snapshot --project name --server-id id [--description text] [--label key=value]
  restore-snapshot --server-id id --snapshot-id id
  attach-volume --volume-id id --server-id id [--automount]
  detach-volume --volume-id id
  attach-network --server-id id --network-id id [--ip 10.0.0.2]
  detach-network --server-id id --network-id id
  change-server-type --server-id id --server-type-id id [--upgrade-disk]
  upgrade-server --server-id id --server-type-id id [--upgrade-disk]
  downgrade-server --server-id id --server-type-id id
  delete-server --server-id id
  delete-vps --server-id id
  delete-snapshot --image-id id
  destroy-snapshot --image-id id
  delete-volume --volume-id id

Change type flow:
  1. list-server-types --name cpx32
  2. downgrade-server --server-id id --server-type-id <numeric id> --operator-grant
  The emitted change_type request uses json.server_type and json.upgrade_disk.
  Do not send json.type or hand-built secretHeaders.
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
