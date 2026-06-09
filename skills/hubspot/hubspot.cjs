#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  executeGatewayRequest: executeSharedGatewayRequest,
  resolveGatewayToken,
  resolveGatewayUrl,
} = require('../shared/gateway-http.cjs');
const EVAL_SCENARIOS_PATH = path.join(__dirname, 'evals', 'scenarios.json');
const DEFAULT_TIMEOUT_MS = 30_000;
const GATEWAY_TOKEN_ENV_NAMES = [
  'HYBRIDCLAW_GATEWAY_TOKEN',
  'GATEWAY_API_TOKEN',
  'WEB_API_TOKEN',
];
const {
  ACTIVITY_ASSOCIATION_TYPE_IDS,
  WRITE_GRANTS,
  buildHttpRequestCommand,
  parseFlags,
  usageTotalsMeasurement,
} = require('./hubspot-requests.cjs');
const { buildWorkflow, planNaturalLanguage } = require('./hubspot-plan.cjs');
const {
  validatePropertyOption,
  validatePropertyOptionFromFile,
} = require('./hubspot-validation.cjs');

function printHelp() {
  process.stdout.write(`HubSpot skill helper

Usage:
  node skills/hubspot/hubspot.cjs [--format json|text] [--max-response-bytes n] <command> [options]

Commands:
  plan <request>                         Classify a natural-language CRM request
  workflow <request>                     Build ordered lookup/validation/API steps
  validate-option                        Validate a HubSpot property option from saved JSON
  explain-error                          Interpret a saved HubSpot/http_request error
  run <http-request command>             Send a helper-built request through the gateway
  http-request list <object>             Build a list records request
  http-request search <object>           Build a CRM search request
  http-request get <object> <id>         Build a get-by-id request
  http-request properties <object>       Build a properties metadata request
  http-request update-deal-stage <id>    Build a guarded dealstage PATCH
  http-request update-lifecycle-stage <object> <id>
                                          Build a guarded lifecyclestage PATCH
  http-request create-note               Build a guarded note create request
  http-request create-task               Build a guarded task create request
  eval-scenarios                         Run the offline planner fixture suite

Objects:
  contacts, companies, deals

Write grants:
  ${WRITE_GRANTS['update-deal-stage']}
  ${WRITE_GRANTS['update-lifecycle-stage']}
  ${WRITE_GRANTS['create-note']}
  ${WRITE_GRANTS['create-task']}
`);
}

function parseGlobalArgs(argv) {
  const parsed = {
    format: 'text',
    maxResponseBytes: undefined,
    args: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--format') {
      parsed.format = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--format=')) {
      parsed.format = arg.slice('--format='.length);
      continue;
    }
    if (arg === '--max-response-bytes') {
      parsed.maxResponseBytes = parseMaxResponseBytes(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--max-response-bytes=')) {
      parsed.maxResponseBytes = parseMaxResponseBytes(
        arg.slice('--max-response-bytes='.length),
      );
      continue;
    }
    parsed.args.push(arg);
  }
  if (!['json', 'text'].includes(parsed.format)) {
    throw new Error('--format must be "json" or "text".');
  }
  return parsed;
}

function parseMaxResponseBytes(raw) {
  if (raw === undefined || String(raw).trim() === '') {
    throw new Error('Missing value for --max-response-bytes.');
  }
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('--max-response-bytes must be a positive integer.');
  }
  return value;
}

function popFlag(args, name, defaultValue = '') {
  const index = args.findIndex(
    (arg) => arg === name || arg.startsWith(`${name}=`),
  );
  if (index === -1) return defaultValue;
  const arg = args.splice(index, 1)[0];
  if (arg.includes('=')) return arg.slice(name.length + 1);
  const value = args.splice(index, 1)[0];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${name}.`);
  }
  return value;
}

async function gatewayRequest(httpRequest, { gatewayUrl, gatewayToken }) {
  return executeSharedGatewayRequest(httpRequest, {
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    gatewayToken,
    gatewayUrl,
    normalize: false,
    serviceName: 'HubSpot',
  });
}

function buildValidateOptionCommand(args) {
  const { flags } = parseFlags(args, {
    'properties-file': 'string',
    property: 'string',
    value: 'string',
  });
  if (!flags['properties-file'])
    throw new Error('validate-option requires --properties-file.');
  if (!flags.property) throw new Error('validate-option requires --property.');
  if (!flags.value) throw new Error('validate-option requires --value.');
  return {
    command: 'validate-option',
    ...validatePropertyOptionFromFile({
      filePath: flags['properties-file'],
      propertyName: flags.property,
      value: flags.value,
    }),
    costMeasurement: usageTotalsMeasurement(),
  };
}

function explainErrorPayload(payload) {
  const text = JSON.stringify(payload || {}).toLowerCase();
  const status =
    Number(
      payload?.status || payload?.statusCode || payload?.response?.status,
    ) || null;
  let category = 'upstream-error';
  let operatorMessage =
    'HubSpot returned an error. Inspect the response body and retry only after correcting the request.';
  if (
    status === 401 ||
    text.includes('unauthorized') ||
    text.includes('invalid oauth')
  ) {
    category = 'authentication';
    operatorMessage =
      'HubSpot rejected HUBSPOT_ACCESS_TOKEN. Stop after this failed call. Ask the operator to verify or replace the stored HubSpot Service Key or bearer credential. For Service Keys, they must copy the current key from HubSpot Development > Keys > Service keys and store that exact value. Do not infer token age from HubSpot error timestamps.';
  } else if (
    status === 403 ||
    text.includes('scope') ||
    text.includes('forbidden')
  ) {
    category = 'authorization';
    operatorMessage =
      'HubSpot blocked the request. Stop after this failed call. Ask the operator to verify the Service Key scopes, OAuth scopes, app installation, and object permissions for the stored HUBSPOT_ACCESS_TOKEN.';
  } else if (status === 404 || text.includes('not found')) {
    category = 'not-found';
    operatorMessage =
      'The HubSpot record or endpoint was not found. Re-check object type and record ID.';
  } else if (status === 400 && text.includes('lifecyclestage')) {
    category = 'lifecycle-stage';
    operatorMessage =
      'HubSpot rejected the lifecycle stage update. Verify the internal stage value and lifecycle ordering rules.';
  } else if (
    status === 400 &&
    (text.includes('dealstage') || text.includes('pipeline'))
  ) {
    category = 'deal-stage';
    operatorMessage =
      'HubSpot rejected the deal stage or pipeline value. Read deal properties and use internal option values.';
  } else if (status === 429 || text.includes('rate limit')) {
    category = 'rate-limit';
    operatorMessage =
      'HubSpot rate limited the request. Wait for the retry window before trying again.';
  }
  return {
    command: 'explain-error',
    category,
    status,
    operatorMessage,
    retryable: category === 'rate-limit' || (status !== null && status >= 500),
    costMeasurement: usageTotalsMeasurement(),
  };
}

function interpretedHubSpotResponse(response) {
  if (response?.ok !== false) return null;
  return explainErrorPayload(response);
}

async function buildRunCommand(args, options = {}) {
  const gatewayUrl = resolveGatewayUrl(popFlag(args, '--gateway-url'));
  const gatewayToken = resolveGatewayToken(popFlag(args, '--gateway-token'), {
    gatewayTokenEnvNames: GATEWAY_TOKEN_ENV_NAMES,
  });
  const requestPayload = buildHttpRequestCommand(args, options);
  const response = await gatewayRequest(requestPayload.httpRequest, {
    gatewayUrl,
    gatewayToken,
  });
  const interpretedError = interpretedHubSpotResponse(response);

  return {
    command: 'run',
    operation: requestPayload.command,
    stakesTier: requestPayload.stakesTier,
    response,
    ...(interpretedError ? { interpretedError } : {}),
    costMeasurement: usageTotalsMeasurement(),
    liveExecution: requestPayload.liveExecution,
  };
}

function buildExplainErrorCommand(args) {
  const { flags, positional } = parseFlags(args, {
    file: 'string',
    status: 'string',
    body: 'string',
  });
  let payload = {};
  if (flags.file) {
    payload = JSON.parse(fs.readFileSync(path.resolve(flags.file), 'utf-8'));
  } else if (flags.body) {
    payload = JSON.parse(flags.body);
  } else if (positional.length > 0) {
    payload = JSON.parse(positional.join(' '));
  } else {
    throw new Error(
      'explain-error requires --file, --body, or a JSON argument.',
    );
  }
  if (flags.status) payload.status = Number.parseInt(flags.status, 10);
  return explainErrorPayload(payload);
}

function splitStatementAndFlags(args) {
  const statementParts = [];
  const flagArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      statementParts.push(arg);
      continue;
    }
    flagArgs.push(arg);
    if (arg.includes('=')) continue;
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flagArgs.push(next);
      index += 1;
    }
  }
  return {
    statement: statementParts.join(' ').trim(),
    flagArgs,
  };
}

function runEvalScenarios() {
  const scenarios = JSON.parse(fs.readFileSync(EVAL_SCENARIOS_PATH, 'utf-8'));
  let failed = 0;
  const categories = {};
  const failures = [];
  for (const scenario of scenarios) {
    categories[scenario.category] = (categories[scenario.category] || 0) + 1;
    const plan = planNaturalLanguage(scenario.input);
    const expectedActions = Array.isArray(scenario.expectedActions)
      ? scenario.expectedActions
      : [scenario.expectedAction];
    const actualActions = plan.actions.map((action) => action.action);
    const hasExpected = expectedActions.every((expectedAction) =>
      actualActions.includes(expectedAction),
    );
    const costOk = scenario.costMeasurement?.system === 'UsageTotals';
    if (!hasExpected || !costOk) {
      failed += 1;
      failures.push({
        id: scenario.id,
        expectedActions,
        actualActions,
        costOk,
      });
    }
  }
  return {
    command: 'eval-scenarios',
    scenarioCount: scenarios.length,
    failed,
    categories,
    failures,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function renderText(payload) {
  return JSON.stringify(payload, null, 2);
}

async function main() {
  try {
    const global = parseGlobalArgs(process.argv.slice(2));
    if (global.help || global.args.length === 0) {
      printHelp();
      process.exit(0);
    }
    const command = global.args[0];
    const args = global.args.slice(1);
    let payload;
    if (command === 'plan') {
      payload = planNaturalLanguage(args.join(' '));
    } else if (command === 'workflow') {
      const workflow = splitStatementAndFlags(args);
      payload = buildWorkflow(workflow.statement, workflow.flagArgs, {
        maxResponseBytes: global.maxResponseBytes,
      });
    } else if (command === 'validate-option') {
      payload = buildValidateOptionCommand(args);
    } else if (command === 'explain-error') {
      payload = buildExplainErrorCommand(args);
    } else if (command === 'run') {
      payload = await buildRunCommand(args, {
        maxResponseBytes: global.maxResponseBytes,
      });
    } else if (command === 'http-request') {
      payload = buildHttpRequestCommand(args, {
        maxResponseBytes: global.maxResponseBytes,
      });
    } else if (command === 'eval-scenarios') {
      payload = runEvalScenarios();
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
    process.stdout.write(
      global.format === 'json'
        ? `${JSON.stringify(payload)}\n`
        : `${renderText(payload)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ACTIVITY_ASSOCIATION_TYPE_IDS,
  WRITE_GRANTS,
  buildWorkflow,
  buildRunCommand,
  buildHttpRequestCommand,
  explainErrorPayload,
  planNaturalLanguage,
  validatePropertyOption,
  usageTotalsMeasurement,
};
