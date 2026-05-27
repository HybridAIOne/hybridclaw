#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');

const SKILL_NAME = 'alexa';
const ASK_SIGNATURE_WINDOW_SECONDS = 150;
const ASK_CERT_HOST = 's3.amazonaws.com';
const ASK_CERT_PATH_PREFIX = '/echo.api/';
const ASK_CERT_SAN_HOST = 'echo-api.amazon.com';
const DEFAULT_SMARTHOME_REGION_HOST = 'api.amazonalexa.com';
const DEFAULT_AMAZON_DOMAIN = 'amazon.com';
const SMARTHOME_BEARER_SECRET = 'ALEXA_SMARTHOME_ACCESS_TOKEN';
const COMMUNITY_COOKIE_SECRET = 'ALEXA_REFRESH_COOKIE';
const MAX_TEXT_BYTES = 4096;
const AUTH_STOP = {
  stopOnStatuses: [401, 403],
  stopOnErrorTypes: ['INVALID_AUTHORIZATION_CREDENTIAL'],
};
const STARFIELD_SERVICES_ROOT_CA_G2_PEM = `-----BEGIN CERTIFICATE-----
MIID7zCCAtegAwIBAgIBADANBgkqhkiG9w0BAQsFADCBmDELMAkGA1UEBhMCVVMxEDAOBgNV
BAgTB0FyaXpvbmExEzARBgNVBAcTClNjb3R0c2RhbGUxJTAjBgNVBAoTHFN0YXJmaWVsZCBU
ZWNobm9sb2dpZXMsIEluYy4xOzA5BgNVBAMTMlN0YXJmaWVsZCBTZXJ2aWNlcyBSb290IENl
cnRpZmljYXRlIEF1dGhvcml0eSAtIEcyMB4XDTA5MDkwMTAwMDAwMFoXDTM3MTIzMTIzNTk1
OVowgZgxCzAJBgNVBAYTAlVTMRAwDgYDVQQIEwdBcml6b25hMRMwEQYDVQQHEwpTY290dHNk
YWxlMSUwIwYDVQQKExxTdGFyZmllbGQgVGVjaG5vbG9naWVzLCBJbmMuMTswOQYDVQQDEzJT
dGFyZmllbGQgU2VydmljZXMgUm9vdCBDZXJ0aWZpY2F0ZSBBdXRob3JpdHkgLSBHMjCCASIw
DQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANUMOsQq+U7i9b4Zl1+OiFOxHz/Lz58gE20p
OsgPfTz3a3Y4Y9k2YKibXlwAgLIvWX/2h/klQ4bnaRtSmpDhcePYLQ1Ob/bISdm28xpWriu2
dBTrz/sm4xq6HZYuajtYlIlHVv8loJNwU4PahHQUw2eeBGg6345AWh1KTs9DkTvnVtYAcMtS
7nt9rjrnvDH5RfbCYM8TWQIrgMw0R9+53pBlbQLPLJGmpufehRhJfGZOozptqbXuNC66DQO4
M99H67FrjSXZm86B0UVGMpZwh94CDklDhbZsc7tk6mFBrMnUVN+HL8cisibMn1lUaJ/8viov
xFUcdUBgF4UCVTmLfwUCAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC
AQYwHQYDVR0OBBYEFJxfAN+qAdcwKziIorhtSpzyEZGDMA0GCSqGSIb3DQEBCwUAA4IBAQBL
NqaEd2ndOxmfZyMIbw5hyf2E3F/YNoHN2BtBLZ9g3ccaaNnRbobhiCPPE95Dz+I0swSdHynV
v/heyNXBve6SbzJ08pGCL72CQnqtKrcgfU28elUSwhXqvfdqlS5sdJ/PHLTyxQGjhdByPq1z
qwubdQxtRbeOlKyWN7Wg0I8VRw7j6IPdj/3vQQF3zCepYoUz8jcI73HPdwbeyBkdiEDPfUYd
/x7H4c7/I9vG+o1VTqkC50cRRj70/b17KSa7qWFiNyi2LSr2EIZkyXCn0q23KXB56jzaYyWf
/Wi3MOxw+3WKt21gZ7IeyLnp2KhvAotnDU0mV3HaIPzBSlCNsSi6
-----END CERTIFICATE-----`;
const STARFIELD_SERVICES_ROOT_CA_G2 = new crypto.X509Certificate(
  STARFIELD_SERVICES_ROOT_CA_G2_PEM,
);

const SECRET_FLAGS = new Set([
  '--access-token',
  '--authorization',
  '--authorization-header',
  '--bearer',
  '--client-secret',
  '--cookie',
  '--email',
  '--password',
  '--refresh-cookie',
  '--refresh-token',
  '--token',
]);

const READ_HTTP_COMMANDS = new Set([
  'smarthome-discover',
  'smarthome-state',
  'devices',
  'shopping-list',
  'todo-list',
  'last-commands',
  'dnd-state',
]);

const PLAN_COMMANDS = new Set([
  'smarthome-control',
  'announce',
  'shopping-list-add',
  'shopping-list-complete',
  'todo-list-add',
  'todo-list-complete',
  'routine-trigger',
]);

const COMMAND_OPTION_FLAGS = [
  '--action',
  '--amazon-domain',
  '--brightness',
  '--color',
  '--device',
  '--endpoint-id',
  '--item',
  '--item-id',
  '--region-host',
  '--routine',
  '--temperature',
  '--text',
];

const SMARTHOME_ACTIONS = new Map([
  [
    'TurnOn',
    { namespace: 'Alexa.PowerController', name: 'TurnOn', tier: 'amber' },
  ],
  [
    'TurnOff',
    { namespace: 'Alexa.PowerController', name: 'TurnOff', tier: 'amber' },
  ],
  [
    'SetBrightness',
    {
      namespace: 'Alexa.BrightnessController',
      name: 'SetBrightness',
      tier: 'amber',
    },
  ],
  [
    'SetColor',
    { namespace: 'Alexa.ColorController', name: 'SetColor', tier: 'amber' },
  ],
  [
    'SetTargetTemperature',
    {
      namespace: 'Alexa.ThermostatController',
      name: 'SetTargetTemperature',
      tier: 'red',
    },
  ],
]);

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(payload, format = 'pretty') {
  const indent = format === 'pretty' ? 2 : undefined;
  process.stdout.write(`${JSON.stringify(payload, null, indent)}\n`);
}

function usage() {
  return `Alexa skill helper

Usage:
  node skills/alexa/alexa.cjs --format json verify-request --request-body request.json --signature-cert-url URL --signature BASE64
  node skills/alexa/alexa.cjs --format json account-link-session --request-body request.json
  node skills/alexa/alexa.cjs --format json parse-request --request-body request.json
  node skills/alexa/alexa.cjs --format json build-response --speech "On it." --reprompt "Anything else?"
  node skills/alexa/alexa.cjs --format json http-request smarthome-discover
  node skills/alexa/alexa.cjs --format json http-request smarthome-state --endpoint-id endpoint-1
  node skills/alexa/alexa.cjs --format json plan smarthome-control --endpoint-id endpoint-1 --action TurnOn
  node skills/alexa/alexa.cjs --format json http-request smarthome-control --endpoint-id endpoint-1 --action TurnOn --operator-grant approve-alexa-write
  node skills/alexa/alexa.cjs --format json http-request devices --amazon-domain amazon.de
  node skills/alexa/alexa.cjs --format json http-request shopping-list
  node skills/alexa/alexa.cjs --format json plan announce --device living-room --text "Package delivered."
  node skills/alexa/alexa.cjs --format json http-request announce --device living-room --text "Package delivered." --operator-grant approve-alexa-write
  node skills/alexa/alexa.cjs --format json plan shopping-list-add --item milk
  node skills/alexa/alexa.cjs --format json http-request shopping-list-complete --item-id item-1 --operator-grant approve-alexa-write

Global options:
  --format json|pretty          json emits compact output; pretty emits indented output. Defaults to pretty.
  --now ISO_OR_EPOCH_MS         Deterministic clock for ASK validation tests.
  --help                        Show this help.

ASK validation options:
  --request-body FILE           Raw ASK request JSON body exactly as received.
  --signature-cert-url URL      SignatureCertChainUrl header value.
  --signature BASE64            Signature header value.
  --cert-pem FILE               Local certificate chain PEM for tests/offline validation.
  --expected-skill-id ID        Optional applicationId check. Use SecretRef in production.

Commands:
  verify-request
  account-link-session
  parse-request
  build-response
  http-request smarthome-discover|smarthome-state|devices|shopping-list|todo-list|last-commands|dnd-state
  http-request smarthome-control|announce|shopping-list-add|shopping-list-complete|todo-list-add|todo-list-complete|routine-trigger
  plan smarthome-control|announce|shopping-list-add|shopping-list-complete|todo-list-add|todo-list-complete|routine-trigger
  relink-required

Secret values are not accepted on the command line. Store Alexa credentials with:
  hybridclaw secret set ALEXA_ASK_SKILL_ID "amzn1.ask.skill.<uuid>"
  hybridclaw secret set ALEXA_LWA_CLIENT_ID "amzn1.application-oa2-client.<id>"
  hybridclaw secret set ALEXA_LWA_CLIENT_SECRET "<client secret>"
  hybridclaw secret set ALEXA_SMARTHOME_REFRESH_TOKEN "<refresh token>"
  hybridclaw secret set ALEXA_REFRESH_COOKIE "<persistent refresh cookie>"`;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function parseGlobalArgs(argv) {
  const opts = { format: 'pretty' };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    rejectSecretFlag(arg);
    if (
      [
        '--cert-pem',
        '--expected-skill-id',
        '--format',
        '--now',
        '--request-body',
        '--signature',
        '--signature-cert-url',
      ].includes(arg)
    ) {
      const value = argv[index + 1];
      if (
        value === undefined ||
        value.startsWith('--') ||
        !String(value).trim()
      ) {
        fail(`${arg} requires a value.`);
      }
      if (arg === '--format' && !['json', 'pretty'].includes(value)) {
        fail('--format must be json or pretty.');
      }
      opts[toCamel(arg.slice(2))] = value;
      index += 1;
      continue;
    }
    positional.push(arg);
  }

  return { opts, positional };
}

function parseCommandOptions(args, spec = {}) {
  // CLI flags use --kebab-case and are stored as camelCase option keys.
  const values = new Set(spec.values || []);
  const booleans = new Set(spec.booleans || []);
  const result = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    rejectSecretFlag(arg);
    if (booleans.has(arg)) {
      result[toCamel(arg.slice(2))] = true;
      continue;
    }
    if (values.has(arg)) {
      const value = args[index + 1];
      if (
        value === undefined ||
        value.startsWith('--') ||
        !String(value).trim()
      ) {
        fail(`${arg} requires a value.`);
      }
      result[toCamel(arg.slice(2))] = value;
      index += 1;
      continue;
    }
    fail(`Unknown option or argument: ${arg}`);
  }

  return result;
}

function rejectSecretFlag(arg) {
  if (SECRET_FLAGS.has(arg)) {
    fail(
      `${arg} is not supported. Store Alexa credentials in HybridClaw secrets.`,
    );
  }
}

function normalizeText(value) {
  return String(value || '').trim();
}

function requireText(value, label) {
  const text = normalizeText(value);
  if (!text) fail(`${label} is required.`);
  return text;
}

function requireBoundedText(value, label, maxBytes = MAX_TEXT_BYTES) {
  const text = requireText(value, label);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    fail(`${label} must be ${maxBytes} bytes or fewer.`);
  }
  return text;
}

function requireIdentifier(value, label) {
  const text = requireText(value, label);
  if (!/^[A-Za-z0-9_.:-]+$/.test(text)) {
    fail(
      `${label} may contain only letters, numbers, underscore, dot, colon, and dash.`,
    );
  }
  return text;
}

function parseBoolean(value, label, fallback = false) {
  if (value === undefined) return fallback;
  const text = normalizeText(value);
  if (text === 'true') return true;
  if (text === 'false') return false;
  fail(`${label} must be true or false.`);
}

function parseNumber(value, label, min, max) {
  const text = requireText(value, label);
  if (!/^-?(?:\d+|\d+\.\d+)$/.test(text)) {
    fail(`${label} must be a number between ${min} and ${max}.`);
  }
  const number = Number.parseFloat(text);
  if (number < min || number > max) {
    fail(`${label} must be between ${min} and ${max}.`);
  }
  return number;
}

function parseHsvColor(value) {
  const text = requireText(value, '--color');
  let color;
  try {
    color = JSON.parse(text);
  } catch {
    fail(
      '--color must be JSON: {"hue":0-360,"saturation":0-1,"brightness":0-1}.',
    );
  }
  if (!color || typeof color !== 'object' || Array.isArray(color)) {
    fail('--color must be a JSON object.');
  }
  const hue = Number(color.hue);
  const saturation = Number(color.saturation);
  const brightness = Number(color.brightness);
  if (
    !Number.isFinite(hue) ||
    hue < 0 ||
    hue > 360 ||
    !Number.isFinite(saturation) ||
    saturation < 0 ||
    saturation > 1 ||
    !Number.isFinite(brightness) ||
    brightness < 0 ||
    brightness > 1
  ) {
    fail('--color hue must be 0-360 and saturation/brightness must be 0-1.');
  }
  return { hue, saturation, brightness };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readRequestBody(filePath) {
  const path = requireText(filePath, '--request-body');
  let body;
  try {
    body = fs.readFileSync(path, 'utf8');
  } catch (error) {
    fail(`Unable to read request body: ${error.message}`);
  }
  return body;
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    fail('Request body must be valid JSON.');
  }
}

function nowFromOptions(opts) {
  if (!opts.now) return new Date();
  const numeric = Number(opts.now);
  const date = Number.isFinite(numeric)
    ? new Date(numeric)
    : new Date(opts.now);
  if (Number.isNaN(date.getTime()))
    fail('--now must be an ISO timestamp or epoch milliseconds.');
  return date;
}

function validateAskTimestamp(envelope, now) {
  const timestamp = envelope?.request?.timestamp;
  const requestTime = new Date(timestamp);
  if (!timestamp || Number.isNaN(requestTime.getTime())) {
    fail('ASK request timestamp is missing or invalid.');
  }
  const driftSeconds = Math.abs(now.getTime() - requestTime.getTime()) / 1000;
  if (driftSeconds >= ASK_SIGNATURE_WINDOW_SECONDS) {
    fail(
      `ASK request timestamp drift ${Math.round(driftSeconds)}s exceeds 150s.`,
    );
  }
  return { timestamp, driftSeconds };
}

function validateExpectedSkillId(envelope, expectedSkillId) {
  if (!expectedSkillId) return { checked: false };
  const applicationId =
    envelope?.context?.System?.application?.applicationId ||
    envelope?.session?.application?.applicationId;
  if (applicationId !== expectedSkillId) {
    fail('ASK applicationId did not match the expected skill id.');
  }
  return { checked: true, applicationId };
}

function validateAskCertUrl(rawUrl) {
  const text = requireText(rawUrl, '--signature-cert-url');
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('SignatureCertChainUrl must be a valid URL.');
  }
  if (url.protocol !== 'https:') {
    fail('SignatureCertChainUrl must use https.');
  }
  if (url.hostname !== ASK_CERT_HOST) {
    fail(`SignatureCertChainUrl host must be ${ASK_CERT_HOST}.`);
  }
  if (url.port && url.port !== '443') {
    fail('SignatureCertChainUrl must use the default HTTPS port.');
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    fail('SignatureCertChainUrl path must use valid percent-encoding.');
  }
  if (!decodedPath.startsWith(ASK_CERT_PATH_PREFIX)) {
    fail(`SignatureCertChainUrl path must start with ${ASK_CERT_PATH_PREFIX}.`);
  }
  return url;
}

function readCertPem(certPath) {
  if (!certPath) return null;
  try {
    return fs.readFileSync(certPath, 'utf8');
  } catch (error) {
    fail(`Unable to read certificate PEM: ${error.message}`);
  }
}

function fetchCertPem(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        timeout: 10_000,
        headers: { 'user-agent': 'hybridclaw-alexa-skill/1' },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              `Certificate fetch failed with HTTP ${response.statusCode}.`,
            ),
          );
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 200_000) {
            request.destroy(new Error('Certificate chain is too large.'));
          }
        });
        response.on('end', () => resolve(body));
      },
    );
    request.on('timeout', () =>
      request.destroy(new Error('Certificate fetch timed out.')),
    );
    request.on('error', reject);
  });
}

function splitPemChain(pem) {
  const matches = String(pem || '').match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  );
  if (!matches || matches.length === 0)
    fail('Certificate chain PEM did not contain a certificate.');
  return matches;
}

function parseCertificate(pem) {
  try {
    return new crypto.X509Certificate(pem);
  } catch (error) {
    fail(`Unable to parse certificate: ${error.message}`);
  }
}

function validateCertificateTime(cert, now, label) {
  const validFrom = new Date(cert.validFrom);
  const validTo = new Date(cert.validTo);
  if (now < validFrom || now > validTo) {
    fail(`${label} is not valid for the request time.`);
  }
}

function validateCertificateChain(certs, now, allowSingleCert) {
  if (certs.length === 1 && !allowSingleCert) {
    fail(
      'ASK certificate chain must include at least the leaf and issuing certificate.',
    );
  }
  certs.forEach((cert, index) => {
    validateCertificateTime(cert, now, `ASK certificate chain entry ${index}`);
  });
  for (let index = 0; index < certs.length - 1; index += 1) {
    const child = certs[index];
    const issuer = certs[index + 1];
    if (!child.verify(issuer.publicKey)) {
      fail(`ASK certificate chain entry ${index} is not signed by its issuer.`);
    }
  }
  if (certs.length > 1) {
    const root = certs[certs.length - 1];
    if (!root.verify(root.publicKey)) {
      fail('ASK certificate chain root is not self-signed.');
    }
    if (
      !allowSingleCert &&
      root.fingerprint256 !== STARFIELD_SERVICES_ROOT_CA_G2.fingerprint256
    ) {
      fail(
        'ASK certificate chain root is not the pinned Starfield Services Root CA - G2.',
      );
    }
  }
}

function validateAskCertificate(pem, now, { allowSingleCert = false } = {}) {
  const certs = splitPemChain(pem).map(parseCertificate);
  const cert = certs[0];
  validateCertificateChain(certs, now, allowSingleCert);
  const subjectAltName = cert.subjectAltName || '';
  const askSanPattern = new RegExp(
    `(?:^|,\\s*)DNS:${escapeRegExp(ASK_CERT_SAN_HOST)}\\.?(?:,|$)`,
    'i',
  );
  if (!askSanPattern.test(subjectAltName)) {
    fail(
      `ASK signing certificate SAN validation failed: expected DNS:${ASK_CERT_SAN_HOST}.`,
    );
  }
  return cert;
}

function verifyAskSignature(body, signature, cert) {
  const b64 = requireText(signature, '--signature');
  let ok = false;
  try {
    ok = crypto
      .createVerify('RSA-SHA1')
      .update(body, 'utf8')
      .verify(cert.publicKey, b64, 'base64');
  } catch {
    ok = false;
  }
  if (!ok) {
    fail('ASK request signature validation failed.');
  }
  return true;
}

async function verifyRequest(opts) {
  const body = readRequestBody(opts.requestBody);
  const envelope = parseJsonBody(body);
  const now = nowFromOptions(opts);
  const certUrl = validateAskCertUrl(opts.signatureCertUrl);
  const timestamp = validateAskTimestamp(envelope, now);
  const skillId = validateExpectedSkillId(envelope, opts.expectedSkillId);
  const pem = readCertPem(opts.certPem) || (await fetchCertPem(certUrl));
  const cert = validateAskCertificate(pem, now, {
    allowSingleCert: Boolean(opts.certPem),
  });
  verifyAskSignature(body, opts.signature, cert);

  return {
    skill: SKILL_NAME,
    command: 'verify-request',
    valid: true,
    checks: {
      certUrl: 'pass',
      certificateSan: ASK_CERT_SAN_HOST,
      signature: 'pass',
      timestamp: {
        status: 'pass',
        driftSeconds: Number(timestamp.driftSeconds.toFixed(3)),
        maxDriftSeconds: ASK_SIGNATURE_WINDOW_SECONDS,
      },
      applicationId: skillId.checked ? 'pass' : 'not_checked',
    },
    request: summarizeAskRequest(envelope),
  };
}

function summarizeAskRequest(envelope) {
  const request = envelope?.request || {};
  const intent = request.intent || {};
  return {
    type: request.type || 'Unknown',
    requestId: request.requestId || null,
    locale: request.locale || null,
    applicationId:
      envelope?.context?.System?.application?.applicationId ||
      envelope?.session?.application?.applicationId ||
      null,
    intentName: intent.name || null,
  };
}

function parseAskSlots(intent) {
  const slots = intent?.slots || {};
  const result = {};
  for (const [name, slot] of Object.entries(slots)) {
    result[name] = {
      name,
      value: slot?.value ?? null,
      confirmationStatus: slot?.confirmationStatus || 'NONE',
      resolutions: slot?.resolutions?.resolutionsPerAuthority || [],
    };
  }
  return result;
}

function parseRequest(opts) {
  const body = readRequestBody(opts.requestBody);
  const envelope = parseJsonBody(body);
  const request = envelope?.request || {};
  const type = request.type || 'Unknown';
  const payload = {
    skill: SKILL_NAME,
    command: 'parse-request',
    request: summarizeAskRequest(envelope),
    session: {
      new: Boolean(envelope?.session?.new),
      sessionId: envelope?.session?.sessionId || null,
      linkedAccountTokenPresent: Boolean(
        envelope?.context?.System?.user?.accessToken,
      ),
    },
    agentBridge: null,
  };

  if (type === 'LaunchRequest') {
    payload.agentBridge = {
      action: 'launch',
      stakesTier: 'green',
      args: {},
      asyncAllowed: false,
    };
  } else if (type === 'IntentRequest') {
    const intent = request.intent || {};
    payload.intent = {
      name: intent.name || null,
      confirmationStatus: intent.confirmationStatus || 'NONE',
      slots: parseAskSlots(intent),
    };
    payload.agentBridge = bridgeIntent(intent);
  } else if (type === 'SessionEndedRequest') {
    payload.reason = request.reason || null;
    payload.agentBridge = {
      action: 'session-ended',
      stakesTier: 'green',
      args: { reason: request.reason || null },
      asyncAllowed: false,
    };
  } else if (type === 'System.ExceptionEncountered') {
    payload.error = {
      message: request.error?.message || null,
      type: request.error?.type || null,
      causeRequestId: request.cause?.requestId || null,
    };
    payload.agentBridge = {
      action: 'exception',
      stakesTier: 'amber',
      args: payload.error,
      asyncAllowed: false,
      event: 'alexa.exception_encountered',
    };
  } else {
    payload.agentBridge = {
      action: 'unsupported-request',
      stakesTier: 'green',
      args: { type },
      asyncAllowed: false,
    };
  }

  return payload;
}

function accountLinkSession(opts) {
  const body = readRequestBody(opts.requestBody);
  const envelope = parseJsonBody(body);
  const accessTokenPresent = Boolean(
    envelope?.context?.System?.user?.accessToken,
  );
  if (!accessTokenPresent) {
    fail('ASK account linking access_token is missing.');
  }
  return {
    skill: SKILL_NAME,
    command: 'account-link-session',
    request: summarizeAskRequest(envelope),
    linkedAccountTokenPresent: true,
    tokenVisibleToModel: false,
    persistLwaToken: false,
    sessionExchange: {
      source: 'context.System.user.accessToken',
      tokenType: 'LoginWithAmazonAccessToken',
      exchange: 'hybridclaw-operator-session',
      secretRail: 'F13 SecretRef',
      output: '<opaque:hybridclaw-operator-session>',
    },
  };
}

function bridgeIntent(intent) {
  const name = intent?.name || 'UnknownIntent';
  const slots = parseAskSlots(intent);
  const args = Object.fromEntries(
    Object.entries(slots).map(([slotName, slot]) => [slotName, slot.value]),
  );
  if (name === 'AskHybridClawIntent') {
    return {
      action: 'agent-question',
      stakesTier: 'green',
      args,
      asyncAllowed: true,
    };
  }
  if (name === 'RunSkillIntent') {
    return {
      action: 'run-skill',
      stakesTier: 'amber',
      args,
      asyncAllowed: true,
    };
  }
  if (name === 'StatusReportIntent') {
    return {
      action: 'status-report',
      stakesTier: 'green',
      args,
      asyncAllowed: false,
    };
  }
  return {
    action: 'intent',
    intentName: name,
    stakesTier: 'green',
    args,
    asyncAllowed: true,
  };
}

function stripMarkdownForTts(input) {
  let text = String(input || '');
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/!\[[^\]]*]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]+)]\(([^)]+)\)/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^>\s?/gm, '');
  text = text.replace(/https?:\/\/\S+/gi, (url) => {
    const clean = url.replace(/[),.;!?]+$/, '');
    return clean.length > 60 ? '[link omitted]' : clean;
  });
  return text.replace(/\s+/g, ' ').trim();
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text) {
  const sanitized = stripMarkdownForTts(text);
  return `<speak>${escapeXml(sanitized)}</speak>`;
}

function buildResponse(args) {
  const options = parseCommandOptions(args, {
    values: [
      '--speech',
      '--reprompt',
      '--card-title',
      '--card-text',
      '--should-end-session',
    ],
  });
  const shouldEndSession = parseBoolean(
    options.shouldEndSession,
    '--should-end-session',
    true,
  );
  const response = {
    outputSpeech: {
      type: 'SSML',
      ssml: buildSsml(requireText(options.speech, '--speech')),
    },
    shouldEndSession,
  };
  if (options.reprompt) {
    response.reprompt = {
      outputSpeech: {
        type: 'SSML',
        ssml: buildSsml(options.reprompt),
      },
    };
  }
  if (options.cardTitle || options.cardText) {
    response.card = {
      type: 'Simple',
      title: stripMarkdownForTts(options.cardTitle || 'HybridClaw'),
      content: stripMarkdownForTts(options.cardText || options.speech),
    };
  }
  return {
    version: '1.0',
    sessionAttributes: {},
    response,
  };
}

function endpointBasePayload(surface, operation, stakesTier) {
  return {
    skill: SKILL_NAME,
    surface,
    operation,
    stakesTier,
    costMeasurement: {
      system: 'UsageTotals',
      subLimitKey: 'alexa',
    },
  };
}

function smarthomeEventGatewayUrl(opts) {
  const host = opts.regionHost || DEFAULT_SMARTHOME_REGION_HOST;
  if (
    ![
      'api.amazonalexa.com',
      'api.eu.amazonalexa.com',
      'api.fe.amazonalexa.com',
    ].includes(host)
  ) {
    fail(
      '--region-host must be one of api.amazonalexa.com, api.eu.amazonalexa.com, api.fe.amazonalexa.com.',
    );
  }
  return `https://${host}/v3/events`;
}

function smarthomeEndpoint(endpointId) {
  return {
    scope: {
      type: 'BearerToken',
      token: `<secret:${SMARTHOME_BEARER_SECRET}>`,
    },
    endpointId: requireIdentifier(endpointId, '--endpoint-id'),
  };
}

function directiveHeader(namespace, name) {
  return {
    namespace,
    name,
    messageId: crypto.randomUUID(),
    payloadVersion: '3',
  };
}

function smarthomeDiscoverRequest(opts) {
  return {
    ...endpointBasePayload('smart-home', 'smarthome-discover', 'green'),
    httpRequest: {
      method: 'POST',
      url: smarthomeEventGatewayUrl(opts),
      headers: {
        'Content-Type': 'application/json',
      },
      bearerSecretName: SMARTHOME_BEARER_SECRET,
      bodyJson: {
        event: {
          header: directiveHeader('Alexa.Discovery', 'Discover.Response'),
          payload: {
            endpoints: [],
          },
        },
      },
    },
    allowedHosts: [
      'api.amazonalexa.com',
      'api.eu.amazonalexa.com',
      'api.fe.amazonalexa.com',
    ],
    authFailureEvent: relinkRequired('smart-home', 'discovery'),
    ...AUTH_STOP,
  };
}

function smarthomeStateRequest(opts) {
  const endpointId = requireIdentifier(opts.endpointId, '--endpoint-id');
  return {
    ...endpointBasePayload('smart-home', 'smarthome-state', 'green'),
    httpRequest: {
      method: 'POST',
      url: smarthomeEventGatewayUrl(opts),
      headers: {
        'Content-Type': 'application/json',
      },
      bearerSecretName: SMARTHOME_BEARER_SECRET,
      bodyJson: {
        context: {
          properties: [],
        },
        event: {
          header: directiveHeader('Alexa', 'StateReport'),
          endpoint: smarthomeEndpoint(endpointId),
          payload: {},
        },
      },
    },
    authFailureEvent: relinkRequired('smart-home', endpointId),
    ...AUTH_STOP,
  };
}

function communityHost(domain) {
  const normalized = normalizeText(
    domain || DEFAULT_AMAZON_DOMAIN,
  ).toLowerCase();
  if (!['amazon.com', 'amazon.de'].includes(normalized)) {
    fail('--amazon-domain must be amazon.com or amazon.de.');
  }
  return `alexa.${normalized}`;
}

function communityPath(operation, opts) {
  if (operation === 'devices') return '/api/devices-v2/device';
  if (operation === 'shopping-list') return '/api/namedLists';
  if (operation === 'todo-list') return '/api/todos';
  if (operation === 'last-commands')
    return '/api/activities?startTime=&size=10&offset=1';
  if (operation === 'dnd-state') {
    const device = requireIdentifier(opts.device, '--device');
    return `/api/dnd/status?deviceSerialNumber=${encodeURIComponent(device)}`;
  }
  fail(`Unsupported community operation: ${operation}`);
}

function communityReadRequest(operation, opts) {
  const host = communityHost(opts.amazonDomain);
  return {
    ...endpointBasePayload('community', operation, 'green'),
    httpRequest: {
      method: 'GET',
      url: `https://${host}${communityPath(operation, opts)}`,
      headers: {
        Accept: 'application/json',
      },
      cookieSecretName: COMMUNITY_COOKIE_SECRET,
      maxResponseBytes: 200_000,
    },
    authFailureEvent: relinkRequired('community', operation),
    ...AUTH_STOP,
    driftRisk:
      'community-cookie surface is reverse-engineered and may require re-link after Amazon changes.',
  };
}

function httpRequest(commandArgs) {
  const operation = commandArgs[0];
  if (!READ_HTTP_COMMANDS.has(operation) && !PLAN_COMMANDS.has(operation)) {
    fail(`Unsupported http-request command: ${operation || '(missing)'}`);
  }
  const opts = parseCommandOptions(commandArgs.slice(1), {
    values: [...COMMAND_OPTION_FLAGS, '--operator-grant'],
  });
  if (operation === 'smarthome-discover') return smarthomeDiscoverRequest(opts);
  if (operation === 'smarthome-state') return smarthomeStateRequest(opts);
  if (operation === 'smarthome-control') return smarthomeControlRequest(opts);
  if (operation === 'announce') return announceRequest(opts);
  if (operation === 'shopping-list-add')
    return listAddRequest('shopping-list-add', opts);
  if (operation === 'shopping-list-complete')
    return listCompleteRequest('shopping-list-complete', opts);
  if (operation === 'todo-list-add')
    return listAddRequest('todo-list-add', opts);
  if (operation === 'todo-list-complete')
    return listCompleteRequest('todo-list-complete', opts);
  if (operation === 'routine-trigger') return routineTriggerRequest(opts);
  return communityReadRequest(operation, opts);
}

function plan(commandArgs) {
  const operation = commandArgs[0];
  if (!PLAN_COMMANDS.has(operation)) {
    fail(`Unsupported plan command: ${operation || '(missing)'}`);
  }
  const opts = parseCommandOptions(commandArgs.slice(1), {
    values: COMMAND_OPTION_FLAGS,
  });
  if (operation === 'smarthome-control') return planSmarthomeControl(opts);
  if (operation === 'announce') return planAnnounce(opts);
  if (operation === 'shopping-list-add')
    return planListAdd('shopping-list-add', opts);
  if (operation === 'shopping-list-complete')
    return planListComplete('shopping-list-complete', opts);
  if (operation === 'todo-list-add') return planListAdd('todo-list-add', opts);
  if (operation === 'todo-list-complete')
    return planListComplete('todo-list-complete', opts);
  return planRoutineTrigger(opts);
}

function approvalPayload(
  operation,
  target,
  action,
  stakesTier,
  approvedCommand,
) {
  const grant = grantForTier(stakesTier);
  return {
    requiredApproval: {
      framework: 'F8/F14',
      stakesTier,
      requiredGrant: grant,
      approvalText: [
        `Approve Alexa ${operation}.`,
        `Target: ${target}.`,
        `Action: ${action}.`,
        'This may change a physical device, list, routine, or audible announcement.',
        `Only continue if the operator grants ${grant} for this exact target and action.`,
      ].join(' '),
    },
    approvedCommand,
  };
}

function grantForTier(stakesTier) {
  return stakesTier === 'red'
    ? 'approve-alexa-red-write'
    : 'approve-alexa-write';
}

function requireOperatorGrant(operation, stakesTier, value) {
  const requiredGrant = grantForTier(stakesTier);
  if (value !== requiredGrant) {
    fail(`${operation} requires --operator-grant ${requiredGrant}.`);
  }
}

function plannedWritePayload({
  surface,
  operation,
  stakesTier,
  httpRequest,
  approvalOperation,
  approvalTarget,
  approvalAction,
  approvedCommand,
  authSurface,
  authTarget,
  extra = {},
}) {
  return {
    ...endpointBasePayload(surface, operation, stakesTier),
    ...extra,
    httpRequestTemplate: httpRequest,
    authFailureEvent: relinkRequired(authSurface, authTarget),
    ...AUTH_STOP,
    ...approvalPayload(
      approvalOperation,
      approvalTarget,
      approvalAction,
      stakesTier,
      approvedCommand,
    ),
  };
}

function executableWritePayload({
  surface,
  operation,
  stakesTier,
  httpRequest,
  authSurface,
  authTarget,
}) {
  return {
    ...endpointBasePayload(surface, operation, stakesTier),
    httpRequest,
    authFailureEvent: relinkRequired(authSurface, authTarget),
    ...AUTH_STOP,
  };
}

function smarthomeControlDirective(opts) {
  const endpointId = requireIdentifier(opts.endpointId, '--endpoint-id');
  const action = requireText(opts.action, '--action');
  const actionSpec = SMARTHOME_ACTIONS.get(action);
  if (!actionSpec) {
    fail(
      `--action must be one of ${[...SMARTHOME_ACTIONS.keys()].join(', ')}.`,
    );
  }
  const payload = {};
  if (action === 'SetBrightness') {
    payload.brightness = parseNumber(opts.brightness, '--brightness', 0, 100);
  }
  if (action === 'SetColor') {
    payload.color = parseHsvColor(opts.color);
  }
  if (action === 'SetTargetTemperature') {
    payload.targetSetpoint = {
      value: parseNumber(opts.temperature, '--temperature', 5, 35),
      scale: 'CELSIUS',
    };
  }
  return {
    endpointId,
    action,
    actionSpec,
    directive: {
      header: directiveHeader(actionSpec.namespace, actionSpec.name),
      endpoint: smarthomeEndpoint(endpointId),
      payload,
    },
  };
}

function planSmarthomeControl(opts) {
  const { endpointId, action, actionSpec, directive } =
    smarthomeControlDirective(opts);
  return plannedWritePayload({
    surface: 'smart-home',
    operation: 'smarthome-control',
    stakesTier: actionSpec.tier,
    httpRequest: smarthomeControlHttpRequest(opts, directive),
    approvalOperation: 'smart-home control',
    approvalTarget: `${endpointId} via ${opts.regionHost || DEFAULT_SMARTHOME_REGION_HOST}`,
    approvalAction: action,
    approvedCommand: approvedCommand('http-request smarthome-control', {
      '--endpoint-id': endpointId,
      '--action': action,
      '--region-host': opts.regionHost,
      '--brightness': opts.brightness,
      '--color': opts.color,
      '--temperature': opts.temperature,
      '--operator-grant': grantForTier(actionSpec.tier),
    }),
    authSurface: 'smart-home',
    authTarget: endpointId,
    extra: { directive },
  });
}

function smarthomeControlHttpRequest(opts, directive) {
  return {
    method: 'POST',
    url: smarthomeEventGatewayUrl(opts),
    headers: {
      'Content-Type': 'application/json',
    },
    bearerSecretName: SMARTHOME_BEARER_SECRET,
    bodyJson: {
      directive,
    },
  };
}

function smarthomeControlRequest(opts) {
  const { actionSpec, directive } = smarthomeControlDirective(opts);
  requireOperatorGrant(
    'smarthome-control',
    actionSpec.tier,
    opts.operatorGrant,
  );
  return executableWritePayload({
    surface: 'smart-home',
    operation: 'smarthome-control',
    stakesTier: actionSpec.tier,
    httpRequest: smarthomeControlHttpRequest(opts, directive),
    authSurface: 'smart-home',
    authTarget: directive.endpoint.endpointId,
  });
}

function announceHttpRequest(opts, device, text) {
  return {
    method: 'POST',
    url: `https://${communityHost(opts.amazonDomain)}/api/behaviors/preview`,
    headers: {
      'Content-Type': 'application/json',
    },
    cookieSecretName: COMMUNITY_COOKIE_SECRET,
    bodyJson: {
      behaviorId: 'PREVIEW',
      sequenceJson: JSON.stringify({
        '@type': 'com.amazon.alexa.behaviors.model.Sequence',
        startNode: {
          '@type':
            'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
          type: 'Alexa.Speak',
          operationPayload: {
            deviceType: 'ALEXA_CURRENT_DEVICE_TYPE',
            deviceSerialNumber: device,
            locale: 'en-US',
            customerId: '<resolved-by-alexa-account>',
            textToSpeak: text,
          },
        },
      }),
      status: 'ENABLED',
    },
  };
}

function planAnnounce(opts) {
  const device = requireIdentifier(opts.device, '--device');
  const text = stripMarkdownForTts(requireBoundedText(opts.text, '--text'));
  return plannedWritePayload({
    surface: 'community',
    operation: 'announce',
    stakesTier: 'amber',
    httpRequest: announceHttpRequest(opts, device, text),
    approvalOperation: 'announce',
    approvalTarget: device,
    approvalAction: `speak "${text}"`,
    approvedCommand: approvedCommand('http-request announce', {
      '--device': device,
      '--text': text,
      '--amazon-domain': opts.amazonDomain,
      '--operator-grant': grantForTier('amber'),
    }),
    authSurface: 'community',
    authTarget: device,
  });
}

function announceRequest(opts) {
  const device = requireIdentifier(opts.device, '--device');
  const text = stripMarkdownForTts(requireBoundedText(opts.text, '--text'));
  requireOperatorGrant('announce', 'amber', opts.operatorGrant);
  return executableWritePayload({
    surface: 'community',
    operation: 'announce',
    stakesTier: 'amber',
    httpRequest: announceHttpRequest(opts, device, text),
    authSurface: 'community',
    authTarget: device,
  });
}

function listAddHttpRequest(listType, opts, item) {
  return {
    method: 'POST',
    url: `https://${communityHost(opts.amazonDomain)}/api/namedLists/${listType}/items`,
    headers: {
      'Content-Type': 'application/json',
    },
    cookieSecretName: COMMUNITY_COOKIE_SECRET,
    bodyJson: {
      value: item,
      completed: false,
    },
  };
}

function planListAdd(operation, opts) {
  const item = stripMarkdownForTts(requireBoundedText(opts.item, '--item'));
  const listType = operation === 'shopping-list-add' ? 'shopping' : 'todo';
  return plannedWritePayload({
    surface: 'community',
    operation,
    stakesTier: 'amber',
    httpRequest: listAddHttpRequest(listType, opts, item),
    approvalOperation: operation,
    approvalTarget: `${listType} list`,
    approvalAction: `add "${item}"`,
    approvedCommand: approvedCommand(`http-request ${operation}`, {
      '--item': item,
      '--amazon-domain': opts.amazonDomain,
      '--operator-grant': grantForTier('amber'),
    }),
    authSurface: 'community',
    authTarget: listType,
  });
}

function listAddRequest(operation, opts) {
  const item = stripMarkdownForTts(requireBoundedText(opts.item, '--item'));
  const listType = operation === 'shopping-list-add' ? 'shopping' : 'todo';
  requireOperatorGrant(operation, 'amber', opts.operatorGrant);
  return executableWritePayload({
    surface: 'community',
    operation,
    stakesTier: 'amber',
    httpRequest: listAddHttpRequest(listType, opts, item),
    authSurface: 'community',
    authTarget: listType,
  });
}

function listCompleteHttpRequest(listType, opts, itemId) {
  return {
    method: 'PUT',
    url: `https://${communityHost(opts.amazonDomain)}/api/namedLists/${listType}/items/${encodeURIComponent(itemId)}`,
    headers: {
      'Content-Type': 'application/json',
    },
    cookieSecretName: COMMUNITY_COOKIE_SECRET,
    bodyJson: {
      completed: true,
    },
  };
}

function planListComplete(operation, opts) {
  const itemId = requireIdentifier(opts.itemId, '--item-id');
  const listType = operation === 'shopping-list-complete' ? 'shopping' : 'todo';
  return plannedWritePayload({
    surface: 'community',
    operation,
    stakesTier: 'amber',
    httpRequest: listCompleteHttpRequest(listType, opts, itemId),
    approvalOperation: operation,
    approvalTarget: `${listType} list item ${itemId}`,
    approvalAction: 'complete item',
    approvedCommand: approvedCommand(`http-request ${operation}`, {
      '--item-id': itemId,
      '--amazon-domain': opts.amazonDomain,
      '--operator-grant': grantForTier('amber'),
    }),
    authSurface: 'community',
    authTarget: listType,
  });
}

function listCompleteRequest(operation, opts) {
  const itemId = requireIdentifier(opts.itemId, '--item-id');
  const listType = operation === 'shopping-list-complete' ? 'shopping' : 'todo';
  requireOperatorGrant(operation, 'amber', opts.operatorGrant);
  return executableWritePayload({
    surface: 'community',
    operation,
    stakesTier: 'amber',
    httpRequest: listCompleteHttpRequest(listType, opts, itemId),
    authSurface: 'community',
    authTarget: listType,
  });
}

function routineTriggerHttpRequest(opts, routine) {
  return {
    method: 'POST',
    url: `https://${communityHost(opts.amazonDomain)}/api/behaviors/preview`,
    headers: {
      'Content-Type': 'application/json',
    },
    cookieSecretName: COMMUNITY_COOKIE_SECRET,
    bodyJson: {
      behaviorId: routine,
      status: 'ENABLED',
    },
  };
}

function planRoutineTrigger(opts) {
  const routine = requireIdentifier(opts.routine, '--routine');
  return plannedWritePayload({
    surface: 'community',
    operation: 'routine-trigger',
    stakesTier: 'amber',
    httpRequest: routineTriggerHttpRequest(opts, routine),
    approvalOperation: 'routine trigger',
    approvalTarget: routine,
    approvalAction: 'trigger routine',
    approvedCommand: approvedCommand('http-request routine-trigger', {
      '--routine': routine,
      '--amazon-domain': opts.amazonDomain,
      '--operator-grant': grantForTier('amber'),
    }),
    authSurface: 'community',
    authTarget: routine,
  });
}

function routineTriggerRequest(opts) {
  const routine = requireIdentifier(opts.routine, '--routine');
  requireOperatorGrant('routine-trigger', 'amber', opts.operatorGrant);
  return executableWritePayload({
    surface: 'community',
    operation: 'routine-trigger',
    stakesTier: 'amber',
    httpRequest: routineTriggerHttpRequest(opts, routine),
    authSurface: 'community',
    authTarget: routine,
  });
}

function approvedCommand(base, flags) {
  const parts = [
    'node',
    'skills/alexa/alexa.cjs',
    '--format',
    'json',
    ...base.split(' '),
  ];
  for (const [flag, value] of Object.entries(flags)) {
    if (value !== undefined && value !== null && String(value).trim()) {
      parts.push(flag, String(value));
    }
  }
  return parts;
}

function relinkRequired(surface = 'community', target = null) {
  return {
    event: 'alexa.relink_required',
    surface,
    target,
    message:
      'Alexa authorization failed. Stop this flow and ask the operator to re-link the Alexa account.',
  };
}

async function main() {
  const { opts, positional } = parseGlobalArgs(process.argv.slice(2));
  if (opts.help || positional.length === 0) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const command = positional[0];
  if (command === 'verify-request') {
    printJson(await verifyRequest(opts), opts.format);
    return;
  }
  if (command === 'account-link-session') {
    printJson(accountLinkSession(opts), opts.format);
    return;
  }
  if (command === 'parse-request') {
    printJson(parseRequest(opts), opts.format);
    return;
  }
  if (command === 'build-response') {
    printJson(buildResponse(positional.slice(1)), opts.format);
    return;
  }
  if (command === 'http-request') {
    printJson(httpRequest(positional.slice(1)), opts.format);
    return;
  }
  if (command === 'plan') {
    printJson(plan(positional.slice(1)), opts.format);
    return;
  }
  if (command === 'relink-required') {
    printJson(relinkRequired(), opts.format);
    return;
  }
  fail(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => fail(error.message || String(error), 1));
}

module.exports = {
  ASK_SIGNATURE_WINDOW_SECONDS,
  buildResponse,
  parseRequest,
  relinkRequired,
  stripMarkdownForTts,
  validateAskCertUrl,
};
