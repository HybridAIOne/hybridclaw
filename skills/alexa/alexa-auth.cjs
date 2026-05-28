#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_DOMAIN = 'amazon.com';
const DEFAULT_PROXY_PORT = 8080;
const DEFAULT_TIMEOUT_MS = 600_000;
const COOKIE_SECRET = 'ALEXA_REFRESH_COOKIE';
const REFRESH_TOKEN_SECRET = 'ALEXA_REMOTE_REFRESH_TOKEN';
const COOKIE_LIB_VERSION = '5.0.3';

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(payload, format = 'pretty') {
  const indent = format === 'pretty' ? 2 : undefined;
  process.stdout.write(`${JSON.stringify(payload, null, indent)}\n`);
}

function usage() {
  return `Alexa Remote authentication helper

Usage:
  node skills/alexa/alexa-auth.cjs setup --domain amazon.de --write-secret --timeout-ms 600000
  node skills/alexa/alexa-auth.cjs setup --domain amazon.de --write-secret --detach
  node skills/alexa/alexa-auth.cjs status --domain amazon.de
  node skills/alexa/alexa-auth.cjs setup --domain amazon.de --write-secret --write-refresh-token --timeout-ms 600000
  node skills/alexa/alexa-auth.cjs import-cookie --config /path/to/cookie-config.json --write-secret

Options:
  --domain DOMAIN       Amazon retail domain. Defaults to amazon.com.
  --country DOMAIN      Marketplace domain for login/API locale. Defaults to --domain.
  --proxy-port PORT     Preferred local login port. Defaults to ${DEFAULT_PROXY_PORT}; falls back to a free port if busy.
  --detach              Start setup as a detached local proxy and return its status file.
  --status-file FILE    Status file for detached setup/status. Defaults to a temp file per domain.
  --log-file FILE       Log file for detached setup. Defaults to a temp file per domain.
  --timeout-ms MS       Time to wait for browser login. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --write-secret        Store the discovered cookie as ${COOKIE_SECRET}.
  --write-refresh-token Store the captured refresh token as ${REFRESH_TOKEN_SECRET}.
  --config FILE         JSON file to inspect for a cookie header.
  --format json|pretty  json emits compact output; pretty emits indented output. Defaults to pretty.
  --help                Show this help.

This helper starts Amazon's Alexa device-login browser flow through an internal
cookie helper, captures the resulting refresh token, exchanges it for Alexa
Remote cookies, and verifies the account by listing devices. It never accepts
Amazon passwords, OTP codes, or cookies on the command line.`;
}

function parseArgs(argv) {
  const opts = { domain: DEFAULT_DOMAIN, format: 'pretty' };
  const positional = [];
  const flagsWithValues = new Set([
    '--config',
    '--country',
    '--domain',
    '--format',
    '--log-file',
    '--proxy-port',
    '--status-file',
    '--timeout-ms',
  ]);
  const booleanFlags = new Set([
    '--detach',
    '--help',
    '-h',
    '--write-refresh-token',
    '--write-secret',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (booleanFlags.has(arg)) {
      if (arg === '--detach') opts.detach = true;
      if (arg === '--help' || arg === '-h') opts.help = true;
      if (arg === '--write-refresh-token') opts.writeRefreshToken = true;
      if (arg === '--write-secret') opts.writeSecret = true;
      continue;
    }
    if (flagsWithValues.has(arg)) {
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

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function validateAmazonDomain(domain) {
  const normalized = String(domain || DEFAULT_DOMAIN)
    .trim()
    .toLowerCase();
  if (!/^amazon\.[a-z0-9.-]+$/.test(normalized)) {
    throw new Error(`Invalid Amazon domain: ${domain}`);
  }
  return normalized;
}

function hybridclawBin() {
  return process.env.HYBRIDCLAW_BIN || 'hybridclaw';
}

function runCommand(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    timeout: options.timeout,
  });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error(`${bin} was not found on PATH.`);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new Error(
      `${bin} ${args.slice(0, 3).join(' ')} failed with exit ${result.status}${output ? `:\n${output.trim()}` : ''}`,
    );
  }
  return {
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function expandHome(filePath) {
  const value = String(filePath || '').trim();
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function timeoutMs(rawTimeoutMs) {
  const parsed = Number.parseInt(
    String(rawTimeoutMs || DEFAULT_TIMEOUT_MS),
    10,
  );
  if (!Number.isFinite(parsed) || parsed < 10_000) {
    throw new Error('--timeout-ms must be at least 10000.');
  }
  return parsed;
}

function requestedProxyPort(rawProxyPort) {
  if (!rawProxyPort) return DEFAULT_PROXY_PORT;
  const parsed = Number.parseInt(String(rawProxyPort), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('--proxy-port must be an integer between 1 and 65535.');
  }
  return parsed;
}

function safeDomainId(domain) {
  return validateAmazonDomain(domain).replace(/[^a-z0-9.-]/g, '_');
}

function authStatusPath(domain) {
  return path.join(os.tmpdir(), `hybridclaw-alexa-auth-${safeDomainId(domain)}.json`);
}

function authLogPath(domain) {
  return path.join(os.tmpdir(), `hybridclaw-alexa-auth-${safeDomainId(domain)}.log`);
}

function resolveStatusFile(opts, domain) {
  return expandHome(opts.statusFile || authStatusPath(domain));
}

function resolveLogFile(opts, domain) {
  return expandHome(opts.logFile || authLogPath(domain));
}

function writeAuthStatus(statusFile, payload) {
  if (!statusFile) return;
  const safePayload = {
    ...payload,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  const tmpFile = `${statusFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(safePayload, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmpFile, statusFile);
}

function readAuthStatus(statusFile) {
  if (!fs.existsSync(statusFile)) return null;
  return parseJsonOutput(fs.readFileSync(statusFile, 'utf8'), statusFile);
}

function processIsAlive(pid) {
  const numericPid = Number.parseInt(String(pid || ''), 10);
  if (!Number.isFinite(numericPid) || numericPid < 1) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    return false;
  }
}

function alexaDevicesApiUrl(domain) {
  return `https://alexa.${domain}/api/devices-v2/device?cached=false`;
}

function authBaseDomain(domain) {
  if (domain === 'amazon.com') return 'amazon.com';
  if (domain === 'amazon.co.jp') return 'amazon.co.jp';
  return domain;
}

function alexaRuntimeBaseUrl(domain) {
  switch (domain) {
    case 'amazon.com':
      return 'https://pitangui.amazon.com';
    case 'amazon.co.jp':
      return 'https://layla.amazon.co.jp';
    case 'amazon.ca':
      return 'https://pitangui.amazon.ca';
    case 'amazon.com.au':
      return 'https://alexa.amazon.com.au';
    case 'amazon.com.br':
      return 'https://pitangui.amazon.com.br';
    case 'amazon.in':
      return 'https://pitangui.amazon.in';
    case 'amazon.co.uk':
    case 'amazon.de':
    case 'amazon.es':
    case 'amazon.fr':
    case 'amazon.it':
      return 'https://layla.amazon.com';
    default:
      return `https://layla.${domain}`;
  }
}

function localeFlags(domain) {
  switch (domain) {
    case 'amazon.de':
      return ['-a', 'de_DE', '-L', 'de-DE'];
    case 'amazon.co.uk':
      return ['-a', 'en_GB', '-L', 'en-GB'];
    case 'amazon.co.jp':
      return ['-a', 'ja_JP', '-L', 'ja-JP'];
    case 'amazon.fr':
      return ['-a', 'fr_FR', '-L', 'fr-FR'];
    case 'amazon.it':
      return ['-a', 'it_IT', '-L', 'it-IT'];
    case 'amazon.es':
      return ['-a', 'es_ES', '-L', 'es-ES'];
    case 'amazon.com.au':
      return ['-a', 'en_AU', '-L', 'en-AU'];
    case 'amazon.ca':
      return ['-a', 'en_CA', '-L', 'en-CA'];
    case 'amazon.com.br':
      return ['-a', 'pt_BR', '-L', 'pt-BR'];
    case 'amazon.in':
      return ['-a', 'en_IN', '-L', 'en-IN'];
    default:
      return ['-a', 'en_US', '-L', 'en-US'];
  }
}

function localeSettings(domain) {
  const flags = localeFlags(domain);
  return {
    proxyLanguage: flags[1],
    acceptLanguage: flags[3],
  };
}

function parseJsonOutput(raw, label) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
}

function normalizeDevices(payload) {
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.devices)
      ? payload.devices
      : Array.isArray(payload?.deviceList)
        ? payload.deviceList
        : [];

  return candidates.map((device) => ({
    accountName:
      device.accountName || device.name || device.deviceAccountName || null,
    serialNumber: device.serialNumber || device.deviceSerialNumber || null,
    deviceType: device.deviceType || null,
    deviceOwnerCustomerId:
      device.deviceOwnerCustomerId || device.customerId || null,
    deviceFamily: device.deviceFamily || null,
    online:
      typeof device.online === 'boolean'
        ? device.online
        : typeof device.isOnline === 'boolean'
          ? device.isOnline
          : null,
  }));
}

function looksLikeCookieHeader(value) {
  const text = String(value || '').trim();
  if (!text.includes('=')) return false;
  return /(session-id|csrf|ubid-|x-amz|at-|sess-at-|lc-main)/i.test(text);
}

function normalizeCookieHeader(value) {
  return String(value || '')
    .trim()
    .replace(/^cookie:\s*/i, '')
    .trim();
}

function findCookieHeader(value) {
  if (!value || typeof value !== 'object') return null;
  const stack = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;

    for (const [key, item] of Object.entries(current)) {
      if (typeof item === 'string') {
        const normalized = normalizeCookieHeader(item);
        if (/cookie/i.test(key) && looksLikeCookieHeader(normalized)) {
          return normalized;
        }
      } else if (item && typeof item === 'object') {
        stack.push(item);
      }
    }
  }

  return null;
}

function cookieSummary(cookieHeader) {
  const cookieNames = cookieHeader
    .split(';')
    .map((part) => part.trim().split('=')[0])
    .filter(Boolean);
  return {
    byteLength: Buffer.byteLength(cookieHeader),
    cookieNames: cookieNames.slice(0, 12),
    cookieCount: cookieNames.length,
  };
}

function buildCookieHeader(cookies) {
  return cookies
    .filter((cookie) => cookie?.name && cookie?.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function csrfFromCookieHeader(cookieHeader) {
  const csrf = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith('csrf='));
  return csrf ? csrf.slice('csrf='.length) : null;
}

function writeHybridClawSecret(cookieHeader) {
  const { stdout } = runCommand(hybridclawBin(), [
    'secret',
    'set',
    COOKIE_SECRET,
    cookieHeader,
  ]);
  return stdout || `Stored ${COOKIE_SECRET}.`;
}

function writeHybridClawRefreshToken(refreshToken) {
  const { stdout } = runCommand(hybridclawBin(), [
    'secret',
    'set',
    REFRESH_TOKEN_SECRET,
    refreshToken,
  ]);
  return stdout || `Stored ${REFRESH_TOKEN_SECRET}.`;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read JSON config ${filePath}: ${error.message}`);
  }
}

function findReadableConfig(configPath) {
  const candidate = expandHome(configPath);
  if (candidate && fs.existsSync(candidate)) return candidate;
  throw new Error('Pass --config FILE pointing at JSON that contains a cookie header.');
}

function importCookie(opts) {
  const configPath = findReadableConfig(opts.config);
  const config = readJsonFile(configPath);
  const cookieHeader = findCookieHeader(config);
  if (!cookieHeader) {
    throw new Error(
      `No full Alexa Remote Cookie header was found in ${configPath}.`,
    );
  }

  return cookieResult({
    command: 'import-cookie',
    cookieHeader,
    devices: [],
    domain: null,
    profileDir: null,
    writeSecret: opts.writeSecret,
  });
}

function cookieResult({
  command,
  cookieHeader,
  devices,
  domain,
  refreshToken,
  runtimeBaseUrl,
  writeSecret,
  writeRefreshToken,
}) {
  const result = {
    command,
    domain,
    runtimeBaseUrl,
    secretName: COOKIE_SECRET,
    discovered: true,
    wroteSecret: false,
    cookie: cookieSummary(cookieHeader),
    devices,
  };

  if (refreshToken) {
    result.refreshToken = {
      byteLength: Buffer.byteLength(refreshToken),
      prefix: refreshToken.slice(0, 5),
      secretName: REFRESH_TOKEN_SECRET,
      wroteSecret: false,
    };
  }

  if (writeSecret) {
    result.wroteSecret = true;
    result.secretStore = writeHybridClawSecret(cookieHeader);
  }

  if (writeRefreshToken && refreshToken) {
    result.refreshToken.wroteSecret = true;
    result.refreshToken.secretStore = writeHybridClawRefreshToken(refreshToken);
  }

  return result;
}

function defaultCookieLibRuntimeDir() {
  if (process.env.ALEXA_COOKIE_LIB_DIR) {
    return expandHome(process.env.ALEXA_COOKIE_LIB_DIR);
  }
  return path.join(os.tmpdir(), 'hybridclaw-alexa-cookie2-runtime');
}

function cookieLibModulePath() {
  return path.join(
    defaultCookieLibRuntimeDir(),
    'node_modules',
    'alexa-cookie2',
    'alexa-cookie.js',
  );
}

function ensureCookieLibrary() {
  const modulePath = cookieLibModulePath();
  if (fs.existsSync(modulePath)) return require(modulePath);

  const runtimeDir = defaultCookieLibRuntimeDir();
  fs.mkdirSync(runtimeDir, { recursive: true });
  process.stderr.write(
    `Installing Alexa cookie library alexa-cookie2@${COOKIE_LIB_VERSION}...\n`,
  );
  runCommand(
    'npm',
    [
      'install',
      '--prefix',
      runtimeDir,
      '--cache',
      path.join(runtimeDir, '.npm-cache'),
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      `alexa-cookie2@${COOKIE_LIB_VERSION}`,
    ],
    {
      stdio: 'inherit',
      timeout: 120_000,
    },
  );
  process.stderr.write(`Installed Alexa cookie library to ${runtimeDir}\n`);
  return require(modulePath);
}

function canListenOnPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.listen(0);
  });
}

async function resolveProxyPort(rawProxyPort) {
  const preferredPort = requestedProxyPort(rawProxyPort);
  if (await canListenOnPort(preferredPort)) {
    return { port: preferredPort, fallback: false };
  }
  if (rawProxyPort) {
    throw new Error(
      `Local Alexa login port ${preferredPort} is already in use. Re-run setup with --proxy-port <free-port>.`,
    );
  }
  return { port: await findFreePort(), fallback: true };
}

function runBrowserAuthWithCookieLibrary(opts, domain, country, proxy) {
  const alexaCookie = ensureCookieLibrary();
  const locale = localeSettings(country);
  const timeout = timeoutMs(opts.timeoutMs);
  const baseAmazonPage = authBaseDomain(domain);

  process.stderr.write(
    `Opening Amazon device login at http://127.0.0.1:${proxy.port}. Complete login in the browser, then return here.\n`,
  );

  return new Promise((resolve, reject) => {
    let completed = false;
    const finish = (error, token) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      try {
        if (typeof alexaCookie.stopProxyServer === 'function') {
          alexaCookie.stopProxyServer();
        }
      } catch (_error) {
        // Best-effort cleanup only.
      }
      if (error) reject(error);
      else resolve(token);
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          `Timed out after ${timeout} ms waiting for Amazon to return an Alexa refresh token.`,
        ),
      );
    }, timeout);

    alexaCookie.generateAlexaCookie(
      {
        setupProxy: true,
        proxyOnly: true,
        amazonPage: country,
        baseAmazonPage,
        amazonPageProxyLanguage: locale.proxyLanguage,
        acceptLanguage: locale.acceptLanguage,
        proxyOwnIp: '127.0.0.1',
        proxyPort: proxy.port,
        proxyListenBind: '0.0.0.0',
        deviceAppName: 'hybridclaw_alexa',
        proxyCloseWindowHTML:
          '<b>HybridClaw Alexa authentication complete. You can close this browser tab.</b>',
      },
      (error, result) => {
        if (result?.localCookie) {
          finish(null, {
            amazonPage: result.amazonPage,
            cookieHeader: result.localCookie,
            csrf: result.csrf,
            refreshToken: result.refreshToken || null,
            source: 'alexa-cookie2',
          });
          return;
        }

        if (result?.refreshToken) {
          finish(null, {
            refreshToken: result.refreshToken,
            source: 'refresh-token',
          });
          return;
        }

        const message = error ? String(error.message || error) : '';
        if (message.includes('Please open http://')) {
          if (opts.statusFile) {
            writeAuthStatus(opts.statusFile, {
              command: 'setup',
              domain,
              pid: process.pid,
              port: proxy.port,
              proxyUrl: `http://127.0.0.1:${proxy.port}/`,
              state: 'listening',
              startedAt: opts.startedAt || new Date().toISOString(),
            });
          }
          return;
        }

        if (error) {
          finish(error);
          return;
        }

        if (result?.loginCookie && !result.refreshToken) {
          finish(
            new Error(
              'Amazon login returned cookies but no Alexa refresh token. Retry the setup flow and complete the device authorization page, not just the Amazon account sign-in page.',
            ),
          );
        }
      },
    );
  });
}

async function runBrowserAuth(opts, domain, country) {
  const proxy = await resolveProxyPort(opts.proxyPort);
  opts.activeProxy = proxy;
  if (proxy.fallback) {
    process.stderr.write(
      `Local port ${DEFAULT_PROXY_PORT} is busy; using ${proxy.port} for Amazon device login.\n`,
    );
  }

  if (opts.statusFile) {
    writeAuthStatus(opts.statusFile, {
      command: 'setup',
      domain,
      pid: process.pid,
      port: proxy.port,
      proxyUrl: `http://127.0.0.1:${proxy.port}/`,
      state: 'starting',
      startedAt: opts.startedAt || new Date().toISOString(),
    });
  }

  return runBrowserAuthWithCookieLibrary(opts, domain, country, proxy);
}

async function postForm(url, fields, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} from ${url}: ${text || '<empty body>'}`,
    );
  }
  return parseJsonOutput(text, url);
}

function setCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const combined = headers.get('set-cookie');
  return combined ? [combined] : [];
}

function cookieValueFromSetCookie(headers, name) {
  for (const header of setCookieHeaders(headers)) {
    const match = new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`, 'i').exec(header);
    if (match) return match[1];
  }
  return null;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} from ${url}: ${text || '<empty body>'}`,
    );
  }
  return { payload: parseJsonOutput(text, url), response };
}

function cookieHeaderFromExchange(payload) {
  const cookies = payload?.response?.tokens?.cookies;
  const parts = [];
  if (!cookies || typeof cookies !== 'object') return '';
  for (const cookieList of Object.values(cookies)) {
    if (!Array.isArray(cookieList)) continue;
    for (const cookie of cookieList) {
      if (cookie?.Name && cookie?.Value) {
        parts.push(`${cookie.Name}=${cookie.Value}`);
      }
    }
  }
  return parts.join('; ');
}

async function exchangeRefreshToken(refreshToken, domain, country) {
  const exchange = await postForm(
    'https://api.amazon.com/ap/exchangetoken/cookies',
    {
      app_name: 'Amazon Alexa',
      requested_token_type: 'auth_cookies',
      source_token_type: 'refresh_token',
      source_token: refreshToken,
      domain: `.${domain}`,
    },
    {
      'x-amzn-identity-auth-domain': `api.${domain}`,
    },
  );
  let cookieHeader = cookieHeaderFromExchange(exchange);
  if (!cookieHeader) {
    throw new Error('Amazon token exchange returned no cookies.');
  }

  const csrf = await fetchCsrf(cookieHeader, domain, country);
  if (!csrf) {
    throw new Error('Could not retrieve Alexa CSRF token from exchanged cookies.');
  }
  if (!cookieHeader.includes('csrf=')) {
    cookieHeader = `${cookieHeader}; csrf=${csrf}`;
  }

  return verifyCookieHeader(cookieHeader, domain, country, csrf);
}

async function verifyCookieHeader(
  cookieHeader,
  domain,
  country,
  csrfOverride = null,
) {
  const csrf =
    csrfOverride ||
    csrfFromCookieHeader(cookieHeader) ||
    await fetchCsrf(cookieHeader, domain, country);
  if (!csrf) {
    throw new Error('Could not retrieve Alexa CSRF token from cookies.');
  }
  if (!cookieHeader.includes('csrf=')) {
    cookieHeader = `${cookieHeader}; csrf=${csrf}`;
  }

  const runtimeBaseUrl = alexaRuntimeBaseUrl(country);
  const deviceUrls = [
    `https://alexa.${domain}/api/devices-v2/device?cached=false`,
    `https://alexa.${country}/api/devices-v2/device?cached=false`,
    `${runtimeBaseUrl}/api/devices-v2/device?cached=true`,
  ];
  const headers = {
    Accept: 'application/json',
    Cookie: cookieHeader,
    Origin: `https://alexa.${domain}`,
    Referer: `https://alexa.${domain}/spa/index.html`,
    csrf,
  };

  let lastError = null;
  for (const url of [...new Set(deviceUrls)]) {
    try {
      const { payload } = await fetchJson(url, headers);
      const devices = normalizeDevices(payload);
      if (devices.length === 0) {
        throw new Error(
          `Alexa Remote API returned no devices from ${url} after authentication.`,
        );
      }
      return { cookieHeader, devices, runtimeBaseUrl };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Could not verify Alexa cookies.');
}

async function verifyCookieHeaderWithFallbacks(
  cookieHeader,
  domain,
  countries,
  csrfOverride = null,
) {
  const uniqueCountries = [...new Set(countries.filter(Boolean))];
  let lastError = null;
  for (const country of uniqueCountries) {
    try {
      return await verifyCookieHeader(cookieHeader, domain, country, csrfOverride);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Could not verify Alexa cookies.');
}

async function fetchCsrf(cookieHeader, domain, country) {
  const candidates = [
    `https://alexa.${country}/api/language`,
    `https://alexa.${domain}/api/language`,
    'https://alexa.amazon.com/api/language',
    'https://layla.amazon.com/api/language',
    'https://pitangui.amazon.com/api/language',
  ];
  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Cookie: cookieHeader,
        },
      });
      const csrf = cookieValueFromSetCookie(response.headers, 'csrf');
      response.body?.cancel?.();
      if (csrf) return csrf;
    } catch {
      // Try the next Alexa host.
    }
  }
  return csrfFromCookieHeader(cookieHeader);
}

async function setup(opts) {
  const domain = validateAmazonDomain(opts.domain);
  const country = validateAmazonDomain(opts.country || domain);
  if (opts.detach) {
    return startDetachedSetup(opts, domain, country);
  }

  opts.statusFile = opts.statusFile ? resolveStatusFile(opts, domain) : null;
  opts.startedAt = new Date().toISOString();

  try {
    const browserAuth = await runBrowserAuth(opts, domain, country);
    if (opts.statusFile) {
      writeAuthStatus(opts.statusFile, {
        command: 'setup',
        domain,
        pid: process.pid,
        state: 'verifying',
        startedAt: opts.startedAt,
      });
    }
    const refreshToken =
      typeof browserAuth === 'string'
        ? browserAuth
        : browserAuth?.refreshToken || null;
    if (!browserAuth?.cookieHeader && !refreshToken) {
      throw new Error('Amazon login completed without returning Alexa cookies or a refresh token.');
    }
    const auth = browserAuth?.cookieHeader
      ? await verifyCookieHeaderWithFallbacks(
          browserAuth.cookieHeader,
          domain,
          [country, browserAuth.amazonPage],
          browserAuth.csrf,
        )
      : await exchangeRefreshToken(refreshToken, domain, country);

    const result = cookieResult({
      command: 'setup',
      cookieHeader: auth.cookieHeader,
      devices: auth.devices,
      domain,
      refreshToken,
      runtimeBaseUrl: auth.runtimeBaseUrl,
      writeRefreshToken: opts.writeRefreshToken,
      writeSecret: opts.writeSecret,
    });

    if (opts.statusFile) {
      writeAuthStatus(opts.statusFile, {
        command: 'setup',
        completedAt: new Date().toISOString(),
        deviceCount: auth.devices.length,
        domain,
        pid: process.pid,
        secretName: result.secretName,
        state: 'complete',
        storedSecret: Boolean(result.wroteSecret),
        storedRefreshToken: Boolean(result.wroteRefreshToken),
      });
    }

    return result;
  } catch (error) {
    if (opts.statusFile) {
      writeAuthStatus(opts.statusFile, {
        command: 'setup',
        domain,
        error: error.message || String(error),
        failedAt: new Date().toISOString(),
        pid: process.pid,
        port: opts.activeProxy?.port,
        proxyUrl: opts.activeProxy
          ? `http://127.0.0.1:${opts.activeProxy.port}/`
          : undefined,
        state: 'error',
      });
    }
    throw error;
  }
}

async function startDetachedSetup(opts, domain, country) {
  const statusFile = resolveStatusFile(opts, domain);
  const logFile = resolveLogFile(opts, domain);
  const timeout = timeoutMs(opts.timeoutMs);
  const existing = readAuthStatus(statusFile);
  if (
    existing?.proxyUrl &&
    ['starting', 'listening', 'verifying'].includes(existing.state) &&
    processIsAlive(existing.pid)
  ) {
    return {
      command: 'setup',
      detached: true,
      domain,
      logFile: existing.logFile || logFile,
      pid: existing.pid,
      port: existing.port,
      proxyUrl: existing.proxyUrl,
      reused: true,
      statusFile,
      statusCommand: `node skills/alexa/alexa-auth.cjs status --domain ${domain}`,
      timeoutMs: timeout,
    };
  }

  const proxy = await resolveProxyPort(opts.proxyPort);
  const startedAt = new Date().toISOString();
  const args = [
    __filename,
    'setup',
    '--domain',
    domain,
    '--country',
    country,
    '--proxy-port',
    String(proxy.port),
    '--timeout-ms',
    String(timeout),
    '--status-file',
    statusFile,
    '--format',
    'json',
  ];
  if (opts.writeSecret) args.push('--write-secret');
  if (opts.writeRefreshToken) args.push('--write-refresh-token');

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, args, {
    detached: true,
    env: process.env,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  writeAuthStatus(statusFile, {
    command: 'setup',
    domain,
    logFile,
    pid: child.pid,
    port: proxy.port,
    proxyUrl: `http://127.0.0.1:${proxy.port}/`,
    startedAt,
    state: 'starting',
  });

  return {
    command: 'setup',
    detached: true,
    domain,
    logFile,
    pid: child.pid,
    port: proxy.port,
    proxyUrl: `http://127.0.0.1:${proxy.port}/`,
    statusFile,
    statusCommand: `node skills/alexa/alexa-auth.cjs status --domain ${domain}`,
    timeoutMs: timeout,
  };
}

function setupStatus(opts) {
  const domain = validateAmazonDomain(opts.domain);
  const statusFile = resolveStatusFile(opts, domain);
  const status = readAuthStatus(statusFile);
  if (!status) {
    return {
      command: 'status',
      domain,
      exists: false,
      state: 'missing',
      statusFile,
    };
  }
  return {
    ...status,
    command: 'status',
    domain,
    exists: true,
    processAlive: processIsAlive(status.pid),
    statusFile,
  };
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help || positional.length === 0) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const command = positional[0];
  if (command === 'setup') {
    printJson(await setup(opts), opts.format);
    return;
  }
  if (command === 'status') {
    printJson(setupStatus(opts), opts.format);
    return;
  }
  if (command === 'import-cookie') {
    printJson(importCookie(opts), opts.format);
    return;
  }
  fail(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => fail(error.message || String(error), 1));
}

module.exports = {
  alexaDevicesApiUrl,
  alexaRuntimeBaseUrl,
  authStatusPath,
  authBaseDomain,
  buildCookieHeader,
  csrfFromCookieHeader,
  cookieHeaderFromExchange,
  findCookieHeader,
  localeFlags,
  normalizeDevices,
  validateAmazonDomain,
  verifyCookieHeaderWithFallbacks,
};
