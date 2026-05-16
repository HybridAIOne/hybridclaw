'use strict';

const fs = require('node:fs');

const COST_MEASUREMENT = {
  system: 'UsageTotals',
  source: 'HybridClaw usage_events',
  scope: 'per assistant run/session',
};

function die(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function popFlag(args, name, fallback = undefined, options = {}) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (
    value === undefined ||
    (!options.allowDashValue && value.startsWith('--'))
  ) {
    die(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function popRepeatedFlag(args, name, options = {}) {
  const values = [];
  let index = args.indexOf(name);
  while (index !== -1) {
    const value = args[index + 1];
    if (
      value === undefined ||
      (!options.allowDashValue && value.startsWith('--'))
    ) {
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

function appendQuery(url, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${url}?${text}` : url;
}

function assertNoUnexpectedArgs(args) {
  if (args.length > 0) {
    die(`Unexpected arguments: ${args.join(' ')}`);
  }
}

function validateOperation(operation, allowedOperations, label) {
  if (!allowedOperations.has(operation)) {
    die(`Unknown ${label} operation: ${operation}`);
  }
}

function requireGrant(args, operation, operationTiers, label) {
  if (operationTiers[operation] === 'green') return false;
  const granted = popBoolean(args, '--operator-grant');
  if (!granted) {
    die(
      `Refusing ${label} ${operation} without --operator-grant. ` +
        'Run plan/read first and get an explicit operator grant.',
    );
  }
  return true;
}

function commandEvalScenarios(evalsPath) {
  const scenarios = JSON.parse(fs.readFileSync(evalsPath, 'utf-8'));
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

function runMain({ showHelp, buildPlan, handlers }) {
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
  } else if (handlers[command]) {
    payload = handlers[command](args);
  } else {
    die(`Unknown command: ${command}`);
  }

  if (format === 'json') {
    printJson(payload);
  } else {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

module.exports = {
  COST_MEASUREMENT,
  appendQuery,
  assertNoUnexpectedArgs,
  commandEvalScenarios,
  die,
  parseInteger,
  popBoolean,
  popFlag,
  popRepeatedFlag,
  requireGrant,
  requireText,
  runMain,
  validateOperation,
};
