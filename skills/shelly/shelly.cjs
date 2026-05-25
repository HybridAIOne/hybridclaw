#!/usr/bin/env node
'use strict';

const DEFAULT_TIMEOUT_MS = 15_000;
const CLOUD_AUTH_SECRET = 'SHELLY_CLOUD_AUTH_KEY';
const COST_MEASUREMENT = {
  system: 'UsageTotals',
  subLimitKey: 'shelly',
};

const OPERATION_TIERS = {
  'local-gen1-shelly': 'green',
  'local-gen1-status': 'green',
  'local-gen1-relay-status': 'green',
  'local-gen1-relay-set': 'amber',
  'local-gen2-info': 'green',
  'local-gen2-status': 'green',
  'local-gen2-config': 'green',
  'local-gen2-methods': 'green',
  'local-gen2-components': 'green',
  'local-gen2-switch-status': 'green',
  'local-gen2-switch-set': 'amber',
  'local-gen2-switch-toggle': 'amber',
  'cloud-get-state': 'green',
  'cloud-set-switch': 'amber',
  'cloud-set-light': 'amber',
  'cloud-set-cover': 'amber',
};

const HTTP_OPERATIONS = new Set(Object.keys(OPERATION_TIERS));

function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function printHelp() {
  console.log(`Shelly skill helper

Usage:
  node skills/shelly/shelly.cjs [--format json|pretty] http-request <operation> [flags]

Local Gen2+ reads:
  local-gen2-info --device-url http://192.0.2.10 [--ident]
  local-gen2-status --device-url http://192.0.2.10
  local-gen2-config --device-url http://192.0.2.10
  local-gen2-methods --device-url http://192.0.2.10
  local-gen2-components --device-url http://192.0.2.10 [--include status] [--include config] [--key switch:0]
  local-gen2-switch-status --device-url http://192.0.2.10 --id 0

Local Gen2+ control:
  local-gen2-switch-set --device-url http://192.0.2.10 --id 0 --on true --operator-grant
  local-gen2-switch-toggle --device-url http://192.0.2.10 --id 0 --operator-grant

Local Gen1 reads/control:
  local-gen1-shelly --device-url http://192.0.2.10
  local-gen1-status --device-url http://192.0.2.10
  local-gen1-relay-status --device-url http://192.0.2.10 --id 0
  local-gen1-relay-set --device-url http://192.0.2.10 --id 0 --turn on|off|toggle --operator-grant

Cloud Control API v2:
  cloud-get-state --cloud-host https://<HOST> --device-id abc123 --select status --select settings
  cloud-set-switch --cloud-host https://<HOST> --device-id abc123 --channel 0 --on true --operator-grant
  cloud-set-light --cloud-host https://<HOST> --device-id abc123 --on true --brightness 50 --operator-grant
  cloud-set-cover --cloud-host https://<HOST> --device-id abc123 --position open --operator-grant

Environment:
  SHELLY_DEVICE_URL        default local device base URL
  SHELLY_CLOUD_HOST        default Shelly Cloud tenant server URI
  SHELLY_CLOUD_AUTH_KEY    stored HybridClaw secret name used through <secret:SHELLY_CLOUD_AUTH_KEY>
`);
}

function popFlag(args, name, defaultValue = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return defaultValue;
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
  if (args.length > 0) {
    die(`Unexpected argument: ${args[0]}`);
  }
}

function requireText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) die(`${label} is required.`);
  return normalized;
}

function parseInteger(value, label) {
  const raw = requireText(value, label);
  if (!/^-?\d+$/.test(raw)) die(`${label} must be an integer.`);
  return Number(raw);
}

function parseNonNegativeInteger(value, label) {
  const parsed = parseInteger(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    die(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function parseNumber(value, label) {
  const raw = requireText(value, label);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) die(`${label} must be a number.`);
  return parsed;
}

function parseBooleanValue(value, label) {
  const normalized = requireText(value, label).toLowerCase();
  if (['true', 'on', '1', 'yes'].includes(normalized)) return true;
  if (['false', 'off', '0', 'no'].includes(normalized)) return false;
  die(`${label} must be true or false.`);
}

function requireGrant(args, operation) {
  if (OPERATION_TIERS[operation] === 'green') return;
  if (!popBoolean(args, '--operator-grant')) {
    die(
      `${operation} is ${OPERATION_TIERS[operation]}; pass --operator-grant only after explicit operator approval.`,
    );
  }
}

function normalizeBaseUrl(
  raw,
  label,
  { defaultProtocol, requireHttps = false },
) {
  let value = requireText(raw, label);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `${defaultProtocol}://${value}`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    die(`${label} must be an absolute http or https URL.`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    die(`${label} must use http or https.`);
  }
  if (requireHttps && parsed.protocol !== 'https:') {
    die(`${label} must use https for Shelly Cloud requests.`);
  }
  if (parsed.username || parsed.password) {
    die(`${label} must not embed credentials.`);
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  return parsed;
}

function resolveDeviceBase(args) {
  const value = popFlag(args, '--device-url') || process.env.SHELLY_DEVICE_URL;
  return normalizeBaseUrl(value, '--device-url', { defaultProtocol: 'http' });
}

function resolveCloudBase(args) {
  const value = popFlag(args, '--cloud-host') || process.env.SHELLY_CLOUD_HOST;
  return normalizeBaseUrl(value, '--cloud-host', {
    defaultProtocol: 'https',
    requireHttps: true,
  });
}

function appendPath(base, path) {
  const next = new URL(base.toString());
  next.pathname = `${base.pathname}${path}`.replace(/\/{2,}/gu, '/');
  return next;
}

function appendQuery(url, params) {
  const next = new URL(url.toString());
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      next.searchParams.set(key, String(value));
    }
  }
  return next.toString();
}

function rpcGetUrl(base, method, params = {}) {
  return appendQuery(appendPath(base, `/rpc/${method}`), params);
}

function buildPayload(
  operation,
  { url, method = 'GET', json, maxResponseBytes },
) {
  const tier = OPERATION_TIERS[operation];
  const payload = {
    command: 'http-request',
    operation,
    stakesTier: tier,
    httpRequest: {
      url,
      method,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxResponseBytes: maxResponseBytes || 1_000_000,
      skillName: 'shelly',
      stakesTier: tier,
    },
    costMeasurement: COST_MEASUREMENT,
  };
  if (json !== undefined) payload.httpRequest.json = json;
  if (operation.startsWith('cloud-')) {
    payload.secretRefPolicy =
      'The auth_key is emitted as <secret:SHELLY_CLOUD_AUTH_KEY>; never paste the real Shelly cloud authorization key into chat or helper arguments.';
    payload.liveExecution = {
      mode: 'live-shelly-cloud-control-api',
      requiresConfiguredSecrets: [CLOUD_AUTH_SECRET],
      rateLimit:
        'Shelly Cloud Control API requests are limited to 1 request/second.',
    };
  }
  return payload;
}

function buildRpcPost(operation, base, method, params) {
  return buildPayload(operation, {
    url: appendPath(base, '/rpc').toString(),
    method: 'POST',
    json: {
      id: 1,
      method,
      params,
    },
  });
}

function buildLocalGen2(operation, args) {
  const base = resolveDeviceBase(args);

  if (operation === 'local-gen2-info') {
    const params = popBoolean(args, '--ident') ? { ident: true } : {};
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: rpcGetUrl(base, 'Shelly.GetDeviceInfo', params),
    });
  }

  if (operation === 'local-gen2-status') {
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: rpcGetUrl(base, 'Shelly.GetStatus'),
    });
  }

  if (operation === 'local-gen2-config') {
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: rpcGetUrl(base, 'Shelly.GetConfig'),
    });
  }

  if (operation === 'local-gen2-methods') {
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: rpcGetUrl(base, 'Shelly.ListMethods'),
    });
  }

  if (operation === 'local-gen2-components') {
    const params = {};
    const include = popRepeatedFlag(args, '--include');
    if (include.length > 0) {
      const allowed = new Set(['status', 'config']);
      for (const value of include) {
        if (!allowed.has(value)) die('--include must be status or config.');
      }
      params.include = include;
    }
    const keys = popRepeatedFlag(args, '--key');
    if (keys.length > 0) params.keys = keys;
    if (popBoolean(args, '--dynamic-only')) params.dynamic_only = true;
    const offset = popFlag(args, '--offset');
    if (offset !== undefined)
      params.offset = parseNonNegativeInteger(offset, '--offset');
    assertNoUnexpectedArgs(args);
    return buildRpcPost(operation, base, 'Shelly.GetComponents', params);
  }

  if (operation === 'local-gen2-switch-status') {
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: rpcGetUrl(base, 'Switch.GetStatus', { id }),
    });
  }

  if (operation === 'local-gen2-switch-set') {
    requireGrant(args, operation);
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    const on = parseBooleanValue(popFlag(args, '--on'), '--on');
    const params = { id, on };
    const toggleAfter = popFlag(args, '--toggle-after');
    if (toggleAfter !== undefined) {
      const parsed = parseNumber(toggleAfter, '--toggle-after');
      if (parsed <= 0) die('--toggle-after must be greater than 0.');
      params.toggle_after = parsed;
    }
    assertNoUnexpectedArgs(args);
    return buildRpcPost(operation, base, 'Switch.Set', params);
  }

  if (operation === 'local-gen2-switch-toggle') {
    requireGrant(args, operation);
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    assertNoUnexpectedArgs(args);
    return buildRpcPost(operation, base, 'Switch.Toggle', { id });
  }

  die(`Unsupported local Gen2 operation: ${operation}`);
}

function buildLocalGen1(operation, args) {
  const base = resolveDeviceBase(args);

  if (operation === 'local-gen1-shelly') {
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: appendPath(base, '/shelly').toString(),
    });
  }

  if (operation === 'local-gen1-status') {
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: appendPath(base, '/status').toString(),
    });
  }

  if (operation === 'local-gen1-relay-status') {
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: appendPath(base, `/relay/${id}`).toString(),
    });
  }

  if (operation === 'local-gen1-relay-set') {
    requireGrant(args, operation);
    const id = parseNonNegativeInteger(popFlag(args, '--id', '0'), '--id');
    const turn = requireText(popFlag(args, '--turn'), '--turn').toLowerCase();
    if (!['on', 'off', 'toggle'].includes(turn)) {
      die('--turn must be on, off, or toggle.');
    }
    const params = { turn };
    const timer = popFlag(args, '--timer');
    if (timer !== undefined) {
      const parsed = parseNumber(timer, '--timer');
      if (parsed <= 0) die('--timer must be greater than 0.');
      params.timer = parsed;
    }
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: appendQuery(appendPath(base, `/relay/${id}`), params),
    });
  }

  die(`Unsupported local Gen1 operation: ${operation}`);
}

function cloudUrl(base, path) {
  return `${appendPath(base, path).toString()}?auth_key=<secret:${CLOUD_AUTH_SECRET}>`;
}

function parseDeviceId(args) {
  return requireText(
    popFlag(args, '--device-id') || popFlag(args, '--id'),
    '--device-id',
  );
}

function buildCloud(operation, args) {
  const base = resolveCloudBase(args);

  if (operation === 'cloud-get-state') {
    const ids = popRepeatedFlag(args, '--device-id');
    const aliasId = popFlag(args, '--id');
    if (aliasId) ids.push(aliasId);
    if (ids.length < 1 || ids.length > 10) {
      die('cloud-get-state requires between 1 and 10 --device-id values.');
    }
    const select = popRepeatedFlag(args, '--select');
    const pickStatus = popRepeatedFlag(args, '--pick-status');
    const pickSettings = popRepeatedFlag(args, '--pick-settings');
    const json = { ids };
    if (select.length > 0) {
      const allowed = new Set(['status', 'settings']);
      for (const value of select) {
        if (!allowed.has(value)) die('--select must be status or settings.');
      }
      json.select = select;
    }
    const pick = {};
    if (pickStatus.length > 0) pick.status = pickStatus;
    if (pickSettings.length > 0) pick.settings = pickSettings;
    if (Object.keys(pick).length > 0) json.pick = pick;
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: cloudUrl(base, '/v2/devices/api/get'),
      method: 'POST',
      json,
      maxResponseBytes: 2_000_000,
    });
  }

  if (operation === 'cloud-set-switch') {
    requireGrant(args, operation);
    const json = {
      id: parseDeviceId(args),
      on: parseBooleanValue(popFlag(args, '--on'), '--on'),
    };
    const channel = popFlag(args, '--channel');
    if (channel !== undefined)
      json.channel = parseNonNegativeInteger(channel, '--channel');
    const toggleAfter = popFlag(args, '--toggle-after');
    if (toggleAfter !== undefined) {
      const parsed = parseNumber(toggleAfter, '--toggle-after');
      if (parsed <= 0) die('--toggle-after must be greater than 0.');
      json.toggle_after = parsed;
    }
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: cloudUrl(base, '/v2/devices/api/set/switch'),
      method: 'POST',
      json,
    });
  }

  if (operation === 'cloud-set-light') {
    requireGrant(args, operation);
    const json = { id: parseDeviceId(args) };
    const channel = popFlag(args, '--channel');
    if (channel !== undefined)
      json.channel = parseNonNegativeInteger(channel, '--channel');
    const on = popFlag(args, '--on');
    if (on !== undefined) json.on = parseBooleanValue(on, '--on');
    const toggleAfter = popFlag(args, '--toggle-after');
    if (toggleAfter !== undefined)
      json.toggle_after = parsePositiveNumber(toggleAfter, '--toggle-after');
    const mode = popFlag(args, '--mode');
    if (mode !== undefined) {
      if (!['color', 'white'].includes(mode))
        die('--mode must be color or white.');
      json.mode = mode;
    }
    for (const [flag, property, min, max] of [
      ['--temperature', 'temperature', 2700, 7000],
      ['--brightness', 'brightness', 0, 100],
      ['--red', 'red', 0, 255],
      ['--green', 'green', 0, 255],
      ['--blue', 'blue', 0, 255],
      ['--white', 'white', 0, 255],
      ['--gain', 'gain', 0, 100],
      ['--effect', 'effect', 0, 6],
    ]) {
      const value = popFlag(args, flag);
      if (value !== undefined)
        json[property] = parseBoundedNumber(value, flag, min, max);
    }
    if (Object.keys(json).length <= 1) {
      die('cloud-set-light requires at least one light command field.');
    }
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: cloudUrl(base, '/v2/devices/api/set/light'),
      method: 'POST',
      json,
    });
  }

  if (operation === 'cloud-set-cover') {
    requireGrant(args, operation);
    const json = { id: parseDeviceId(args) };
    const channel = popFlag(args, '--channel');
    if (channel !== undefined)
      json.channel = parseNonNegativeInteger(channel, '--channel');
    const position = popFlag(args, '--position');
    if (position !== undefined) {
      const normalized = String(position).trim().toLowerCase();
      if (['open', 'close', 'stop'].includes(normalized)) {
        json.position = normalized;
      } else {
        json.position = parseBoundedNumber(position, '--position', 0, 100);
      }
    }
    const relative = popFlag(args, '--relative');
    if (relative !== undefined)
      json.relative = parseBoundedNumber(relative, '--relative', -100, 100);
    const duration = popFlag(args, '--duration');
    if (duration !== undefined)
      json.duration = parsePositiveNumber(duration, '--duration');
    const slatPosition = popFlag(args, '--slat-position');
    if (slatPosition !== undefined)
      json.slatPosition = parseBoundedNumber(
        slatPosition,
        '--slat-position',
        0,
        100,
      );
    const slatRelative = popFlag(args, '--slat-relative');
    if (slatRelative !== undefined)
      json.slatRelative = parseBoundedNumber(
        slatRelative,
        '--slat-relative',
        -100,
        100,
      );
    if (json.position !== undefined && json.relative !== undefined) {
      die('--position and --relative cannot be used together.');
    }
    if (json.slatPosition !== undefined && json.slatRelative !== undefined) {
      die('--slat-position and --slat-relative cannot be used together.');
    }
    if (Object.keys(json).length <= 1) {
      die('cloud-set-cover requires at least one cover command field.');
    }
    assertNoUnexpectedArgs(args);
    return buildPayload(operation, {
      url: cloudUrl(base, '/v2/devices/api/set/cover'),
      method: 'POST',
      json,
    });
  }

  die(`Unsupported cloud operation: ${operation}`);
}

function parsePositiveNumber(value, label) {
  const parsed = parseNumber(value, label);
  if (parsed <= 0) die(`${label} must be greater than 0.`);
  return parsed;
}

function parseBoundedNumber(value, label, min, max) {
  const parsed = parseNumber(value, label);
  if (parsed < min || parsed > max) {
    die(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function buildRequest(argv) {
  const args = [...argv];
  const format = popFlag(args, '--format', 'pretty');
  if (!['json', 'pretty'].includes(format))
    die('--format must be json or pretty.');
  const command = args.shift();
  if (command !== 'http-request') {
    die('Only the http-request command is supported.');
  }
  const operation = args.shift();
  if (!HTTP_OPERATIONS.has(operation)) {
    die(`Unsupported operation: ${operation || '(missing)'}`);
  }

  if (operation.startsWith('local-gen2-'))
    return buildLocalGen2(operation, args);
  if (operation.startsWith('local-gen1-'))
    return buildLocalGen1(operation, args);
  if (operation.startsWith('cloud-')) return buildCloud(operation, args);
  die(`Unsupported operation: ${operation}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  const format = args.includes('--format')
    ? args[args.indexOf('--format') + 1]
    : 'pretty';
  const payload = buildRequest(args);
  process.stdout.write(
    JSON.stringify(payload, null, format === 'pretty' ? 2 : 0),
  );
  process.stdout.write('\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  buildRequest,
};
