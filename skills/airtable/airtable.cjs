#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const API_BASE = 'https://api.airtable.com/v0';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAT_SECRET = 'AIRTABLE_PAT';
const EVAL_SCENARIOS_PATH = path.join(__dirname, 'evals', 'scenarios.json');

const COMPUTED_FIELD_TYPES = new Set([
  'aiText',
  'autoNumber',
  'button',
  'count',
  'createdBy',
  'createdTime',
  'externalSyncSource',
  'formula',
  'lastModifiedBy',
  'lastModifiedTime',
  'lookup',
  'multipleLookupValues',
  'rollup',
]);

const NUMERIC_FIELD_TYPES = new Set([
  'number',
  'currency',
  'percent',
  'rating',
  'duration',
]);

const TEXT_FIELD_TYPES = new Set([
  'singleLineText',
  'multilineText',
  'richText',
  'email',
  'url',
  'phoneNumber',
]);

function usageTotalsMeasurement() {
  return {
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
}

function die(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function popFlag(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
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
  if (index === -1) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function parseJsonValue(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    die(`${label} must be valid JSON: ${error.message}`);
  }
}

function loadJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    die(`Cannot read JSON file ${filePath}: ${error.message}`);
  }
}

function encodePathSegment(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    die('Airtable path segment cannot be empty.');
  }
  return encodeURIComponent(text);
}

function appendQuery(url, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        query.append(key, item);
      }
    } else {
      query.set(key, String(value));
    }
  }
  const queryString = query.toString();
  return queryString ? `${url}?${queryString}` : url;
}

function buildHttpRequest({
  url,
  method = 'GET',
  json = undefined,
  bearerSecretName = DEFAULT_PAT_SECRET,
}) {
  const payload = {
    command: 'http-request',
    httpRequest: {
      url,
      method,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      bearerSecretName,
      skillName: 'airtable',
    },
    costMeasurement: usageTotalsMeasurement(),
  };
  if (json !== undefined) {
    payload.httpRequest.json = json;
  }
  return payload;
}

function requireGrant(args, grantName) {
  const granted = popBoolean(args, '--operator-grant');
  if (!granted) {
    die(
      `Refusing Airtable write without --operator-grant (${grantName}). ` +
        'Run plan/validate first and get an explicit operator grant.',
    );
  }
}

function normalizeSchema(schema) {
  if (schema && Array.isArray(schema.tables)) {
    return schema;
  }
  if (schema?.bodyJson && Array.isArray(schema.bodyJson.tables)) {
    return schema.bodyJson;
  }
  if (schema?.body && typeof schema.body === 'string') {
    return normalizeSchema(parseJsonValue(schema.body, 'schema.body'));
  }
  die('Airtable schema JSON must contain a tables array.');
}

function findTable(schema, tableIdOrName) {
  const normalized = normalizeSchema(schema);
  const table = normalized.tables.find(
    (candidate) =>
      candidate.id === tableIdOrName ||
      candidate.name === tableIdOrName ||
      candidate.id?.toLowerCase() === tableIdOrName.toLowerCase() ||
      candidate.name?.toLowerCase() === tableIdOrName.toLowerCase(),
  );
  if (!table) {
    die(`Table not found in schema: ${tableIdOrName}`);
  }
  return table;
}

function findField(table, fieldNameOrId) {
  return table.fields.find(
    (field) =>
      field.id === fieldNameOrId ||
      field.name === fieldNameOrId ||
      field.id?.toLowerCase() === fieldNameOrId.toLowerCase() ||
      field.name?.toLowerCase() === fieldNameOrId.toLowerCase(),
  );
}

function choiceNames(field) {
  return new Set((field.options?.choices ?? []).map((choice) => choice.name));
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isIsoDateTime(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function validateAttachment(value, fieldName, findings) {
  if (!Array.isArray(value)) {
    findings.push(`${fieldName} must be an array of attachment objects.`);
    return;
  }
  value.forEach((attachment, index) => {
    if (
      !attachment ||
      typeof attachment !== 'object' ||
      Array.isArray(attachment)
    ) {
      findings.push(`${fieldName}[${index}] must be an attachment object.`);
      return;
    }
    const hasUrl = typeof attachment.url === 'string' && attachment.url.trim();
    const hasId = typeof attachment.id === 'string' && attachment.id.trim();
    if (!hasUrl && !hasId) {
      findings.push(
        `${fieldName}[${index}] needs a url for new files or id for existing files.`,
      );
    }
    if (hasUrl && !/^https?:\/\//i.test(attachment.url)) {
      findings.push(
        `${fieldName}[${index}].url must be an absolute http(s) URL.`,
      );
    }
    if (
      attachment.filename !== undefined &&
      typeof attachment.filename !== 'string'
    ) {
      findings.push(
        `${fieldName}[${index}].filename must be a string when provided.`,
      );
    }
  });
}

function validateFieldValue(field, value, findings) {
  const label = field.name ?? field.id;
  if (value === null) {
    return;
  }
  if (COMPUTED_FIELD_TYPES.has(field.type)) {
    findings.push(`${label} is a computed/read-only ${field.type} field.`);
    return;
  }
  if (TEXT_FIELD_TYPES.has(field.type)) {
    if (typeof value !== 'string') {
      findings.push(`${label} must be a string for ${field.type}.`);
    }
    return;
  }
  if (NUMERIC_FIELD_TYPES.has(field.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      findings.push(`${label} must be a finite number for ${field.type}.`);
    }
    return;
  }
  if (field.type === 'checkbox') {
    if (typeof value !== 'boolean') {
      findings.push(`${label} must be a boolean.`);
    }
    return;
  }
  if (field.type === 'date') {
    if (!isIsoDate(value)) {
      findings.push(`${label} must be an ISO date string (YYYY-MM-DD).`);
    }
    return;
  }
  if (field.type === 'dateTime') {
    if (!isIsoDateTime(value)) {
      findings.push(`${label} must be an ISO datetime string.`);
    }
    return;
  }
  if (field.type === 'singleSelect') {
    const choices = choiceNames(field);
    if (typeof value !== 'string') {
      findings.push(`${label} must be a single select choice string.`);
      return;
    }
    if (choices.size > 0 && !choices.has(value)) {
      findings.push(
        `${label} must be one of: ${Array.from(choices).join(', ')}.`,
      );
    }
    return;
  }
  if (field.type === 'multipleSelects') {
    const choices = choiceNames(field);
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== 'string')
    ) {
      findings.push(`${label} must be an array of select choice strings.`);
      return;
    }
    const unknown =
      choices.size > 0 ? value.filter((item) => !choices.has(item)) : [];
    if (unknown.length > 0) {
      findings.push(`${label} has unknown choices: ${unknown.join(', ')}.`);
    }
    return;
  }
  if (field.type === 'multipleAttachments') {
    validateAttachment(value, label, findings);
    return;
  }
  if (field.type === 'multipleRecordLinks') {
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== 'string' || !item.startsWith('rec'))
    ) {
      findings.push(`${label} must be an array of Airtable record ids.`);
    }
    return;
  }
  if (field.type === 'multipleCollaborators') {
    if (
      !Array.isArray(value) ||
      value.some(
        (item) => !item || typeof item !== 'object' || Array.isArray(item),
      )
    ) {
      findings.push(`${label} must be an array of collaborator objects.`);
    }
    return;
  }
  if (field.type === 'singleCollaborator') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      findings.push(`${label} must be a collaborator object.`);
    }
    return;
  }
  if (field.type === 'barcode') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      findings.push(`${label} must be a barcode object.`);
    }
    return;
  }
}

function validateFields({
  schema,
  tableIdOrName,
  fields,
  operation = 'write',
}) {
  const table = findTable(schema, tableIdOrName);
  const findings = [];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    findings.push('fields must be a JSON object.');
  } else {
    for (const [fieldNameOrId, value] of Object.entries(fields)) {
      const field = findField(table, fieldNameOrId);
      if (!field) {
        findings.push(`Unknown Airtable field: ${fieldNameOrId}.`);
        continue;
      }
      validateFieldValue(field, value, findings);
    }
  }
  return {
    command: 'validate-fields',
    operation,
    table: { id: table.id, name: table.name },
    allowed: findings.length === 0,
    findings,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function planRequest(request) {
  const text = request.toLowerCase();
  let operation = 'record-read';
  let stakesTier = 'green';
  let requiresEscalation = false;
  let requiredGrant = null;
  let computedFieldRead = false;
  let allowed = true;
  const findings = [];

  if (/\b(base|bases|schema|metadata|inspect|describe)\b/.test(text)) {
    operation = 'schema-read';
  }
  if (/\b(formula|rollup|lookup|computed)\b/.test(text)) {
    computedFieldRead = true;
    operation = 'record-read';
  }
  if (/\b(attach|attachment|file)\b/.test(text)) {
    operation = 'attachment-update';
    stakesTier = 'amber';
    requiresEscalation = true;
    requiredGrant = 'approve-airtable-attachment-update';
  }
  if (
    /\b(create|add|insert|new)\b/.test(text) &&
    /\brecord|row|lead|task|entry|attachment|file\b/.test(text)
  ) {
    operation = /\battach|attachment|file\b/.test(text)
      ? 'attachment-update'
      : 'record-create';
    stakesTier = 'amber';
    requiresEscalation = true;
    requiredGrant =
      operation === 'attachment-update'
        ? 'approve-airtable-attachment-update'
        : 'approve-airtable-record-create';
  }
  if (/\b(update|edit|change|modify|set)\b/.test(text)) {
    operation = /\battach|attachment|file\b/.test(text)
      ? 'attachment-update'
      : 'record-update';
    stakesTier = 'amber';
    requiresEscalation = true;
    requiredGrant =
      operation === 'attachment-update'
        ? 'approve-airtable-attachment-update'
        : 'approve-airtable-record-update';
  }
  if (/\b(delete|remove|destroy)\b/.test(text)) {
    operation = 'record-delete';
    stakesTier = 'red';
    requiresEscalation = true;
    requiredGrant = 'approve-airtable-record-delete';
  }
  if (computedFieldRead && requiresEscalation) {
    allowed = false;
    findings.push(
      'Formula, lookup, rollup, count, and other computed Airtable fields are read-only through this skill.',
    );
  }

  return {
    command: 'plan',
    request,
    operation,
    stakesTier,
    requiresEscalation,
    requiredGrant,
    computedFieldRead,
    allowed,
    findings,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function runEvalScenarios() {
  const scenarios = loadJsonFile(EVAL_SCENARIOS_PATH);
  const failures = [];
  const categories = {};
  for (const scenario of scenarios) {
    categories[scenario.category] = (categories[scenario.category] ?? 0) + 1;
    const plan = planRequest(scenario.request);
    for (const [key, expectedValue] of Object.entries(
      scenario.expected ?? {},
    )) {
      const actualValue =
        key === 'costSystem' ? plan.costMeasurement.system : plan[key];
      if (actualValue !== expectedValue) {
        failures.push({
          id: scenario.id,
          key,
          expected: expectedValue,
          actual: actualValue,
        });
      }
    }
  }
  return {
    command: 'eval-scenarios',
    scenarioCount: scenarios.length,
    failed: failures.length,
    failures,
    categories,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function parseCommonRecordArgs(args) {
  const baseId = popFlag(args, '--base-id');
  const table = popFlag(args, '--table');
  if (!baseId) {
    die('--base-id is required.');
  }
  if (!table) {
    die('--table is required.');
  }
  return { baseId, table };
}

function validateWithOptionalSchema(args, table, fields, operation) {
  const schemaPath = popFlag(args, '--schema-file');
  if (!schemaPath) {
    return null;
  }
  const schema = loadJsonFile(schemaPath);
  const validation = validateFields({
    schema,
    tableIdOrName: table,
    fields,
    operation,
  });
  if (!validation.allowed) {
    die(`Airtable field validation failed: ${validation.findings.join(' ')}`);
  }
  return validation;
}

function handleHttpRequest(args) {
  const operation = args.shift();
  const bearerSecretName = popFlag(args, '--pat-secret', DEFAULT_PAT_SECRET);
  if (!operation) {
    die('http-request requires an operation.');
  }

  if (operation === 'list-bases') {
    return buildHttpRequest({
      url: `${API_BASE}/meta/bases`,
      bearerSecretName,
    });
  }

  if (operation === 'schema') {
    const baseId = popFlag(args, '--base-id');
    if (!baseId) {
      die('--base-id is required.');
    }
    return buildHttpRequest({
      url: `${API_BASE}/meta/bases/${encodePathSegment(baseId)}/tables`,
      bearerSecretName,
    });
  }

  if (operation === 'list-records') {
    const { baseId, table } = parseCommonRecordArgs(args);
    const fields = popRepeatedFlag(args, '--field');
    const pageSize = popFlag(args, '--page-size', '100');
    const offset = popFlag(args, '--offset');
    const view = popFlag(args, '--view');
    const filterByFormula = popFlag(args, '--filter-by-formula');
    const returnFieldsByFieldId = popBoolean(
      args,
      '--return-fields-by-field-id',
    );
    const url = appendQuery(
      `${API_BASE}/${encodePathSegment(baseId)}/${encodePathSegment(table)}`,
      {
        pageSize,
        offset,
        view,
        filterByFormula,
        returnFieldsByFieldId: returnFieldsByFieldId ? 'true' : undefined,
        'fields[]': fields,
      },
    );
    return buildHttpRequest({ url, bearerSecretName });
  }

  if (operation === 'get-record') {
    const { baseId, table } = parseCommonRecordArgs(args);
    const recordId = popFlag(args, '--record-id');
    if (!recordId) {
      die('--record-id is required.');
    }
    return buildHttpRequest({
      url: `${API_BASE}/${encodePathSegment(baseId)}/${encodePathSegment(table)}/${encodePathSegment(recordId)}`,
      bearerSecretName,
    });
  }

  if (operation === 'create-record') {
    requireGrant(args, 'approve-airtable-record-create');
    const { baseId, table } = parseCommonRecordArgs(args);
    const fields = parseJsonValue(
      popFlag(args, '--fields-json'),
      '--fields-json',
    );
    validateWithOptionalSchema(args, table, fields, 'create');
    const typecast = popBoolean(args, '--typecast');
    const payload = { records: [{ fields }] };
    if (typecast) {
      payload.typecast = true;
    }
    return buildHttpRequest({
      url: `${API_BASE}/${encodePathSegment(baseId)}/${encodePathSegment(table)}`,
      method: 'POST',
      json: payload,
      bearerSecretName,
    });
  }

  if (operation === 'update-record') {
    requireGrant(args, 'approve-airtable-record-update');
    const { baseId, table } = parseCommonRecordArgs(args);
    const recordId = popFlag(args, '--record-id');
    const fields = parseJsonValue(
      popFlag(args, '--fields-json'),
      '--fields-json',
    );
    if (!recordId) {
      die('--record-id is required.');
    }
    validateWithOptionalSchema(args, table, fields, 'update');
    const typecast = popBoolean(args, '--typecast');
    const payload = { fields };
    if (typecast) {
      payload.typecast = true;
    }
    return buildHttpRequest({
      url: `${API_BASE}/${encodePathSegment(baseId)}/${encodePathSegment(table)}/${encodePathSegment(recordId)}`,
      method: 'PATCH',
      json: payload,
      bearerSecretName,
    });
  }

  if (operation === 'delete-record') {
    requireGrant(args, 'approve-airtable-record-delete');
    const { baseId, table } = parseCommonRecordArgs(args);
    const recordId = popFlag(args, '--record-id');
    if (!recordId) {
      die('--record-id is required.');
    }
    return buildHttpRequest({
      url: `${API_BASE}/${encodePathSegment(baseId)}/${encodePathSegment(table)}/${encodePathSegment(recordId)}`,
      method: 'DELETE',
      bearerSecretName,
    });
  }

  die(`Unknown http-request operation: ${operation}`);
}

function handleValidateFields(args) {
  const schemaPath = popFlag(args, '--schema-file');
  const table = popFlag(args, '--table');
  const fieldsRaw = popFlag(args, '--fields-json');
  const operation = popFlag(args, '--operation', 'write');
  if (!schemaPath) {
    die('--schema-file is required.');
  }
  if (!table) {
    die('--table is required.');
  }
  if (!fieldsRaw) {
    die('--fields-json is required.');
  }
  return validateFields({
    schema: loadJsonFile(schemaPath),
    tableIdOrName: table,
    fields: parseJsonValue(fieldsRaw, '--fields-json'),
    operation,
  });
}

function handleAttachmentPayload(args) {
  const field = popFlag(args, '--field');
  const urls = popRepeatedFlag(args, '--url');
  const filenames = popRepeatedFlag(args, '--filename');
  if (!field) {
    die('--field is required.');
  }
  if (urls.length === 0) {
    die('At least one --url is required.');
  }
  const attachments = urls.map((url, index) => {
    const attachment = { url };
    if (filenames[index]) {
      attachment.filename = filenames[index];
    }
    return attachment;
  });
  return {
    command: 'attachment-payload',
    fields: {
      [field]: attachments,
    },
    costMeasurement: usageTotalsMeasurement(),
  };
}

function usage() {
  return `Airtable skill helper

Usage:
  node skills/airtable/airtable.cjs --help
  node skills/airtable/airtable.cjs plan "natural language request"
  node skills/airtable/airtable.cjs http-request list-bases [--pat-secret NAME]
  node skills/airtable/airtable.cjs http-request schema --base-id app... [--pat-secret NAME]
  node skills/airtable/airtable.cjs http-request list-records --base-id app... --table tbl... [--field Name] [--view VIEW] [--filter-by-formula FORMULA] [--offset OFFSET] [--page-size N]
  node skills/airtable/airtable.cjs http-request get-record --base-id app... --table tbl... --record-id rec...
  node skills/airtable/airtable.cjs http-request create-record --base-id app... --table tbl... --fields-json JSON [--schema-file PATH] --operator-grant [--typecast]
  node skills/airtable/airtable.cjs http-request update-record --base-id app... --table tbl... --record-id rec... --fields-json JSON [--schema-file PATH] --operator-grant [--typecast]
  node skills/airtable/airtable.cjs http-request delete-record --base-id app... --table tbl... --record-id rec... --operator-grant
  node skills/airtable/airtable.cjs validate-fields --schema-file PATH --table NAME --fields-json JSON
  node skills/airtable/airtable.cjs attachment-payload --field FIELD --url URL [--filename NAME]
  node skills/airtable/airtable.cjs eval-scenarios
`;
}

function main() {
  const args = process.argv.slice(2);
  const format = popFlag(args, '--format', 'json');
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(usage());
    return;
  }

  const command = args.shift();
  let payload;
  if (command === 'plan') {
    const request = args.join(' ').trim();
    if (!request) {
      die('plan requires a request.');
    }
    payload = planRequest(request);
  } else if (command === 'http-request') {
    payload = handleHttpRequest(args);
  } else if (command === 'validate-fields') {
    payload = handleValidateFields(args);
  } else if (command === 'attachment-payload') {
    payload = handleAttachmentPayload(args);
  } else if (command === 'eval-scenarios') {
    payload = runEvalScenarios();
  } else {
    die(`Unknown command: ${command}`);
  }

  if (format === 'json') {
    printJson(payload);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  planRequest,
  runEvalScenarios,
  validateFields,
};
