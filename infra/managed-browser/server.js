import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createGuardProxyServer } from './guard-proxy.js';
import { evaluateTenantNavigation, readTenantPolicyFile } from './policy.js';
import { appendAuditLine, loadLostLeases } from './state.js';

const host = process.env.MANAGED_BROWSER_BIND_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.MANAGED_BROWSER_PORT || '8787', 10);
const nodeId = process.env.MANAGED_BROWSER_NODE_ID || `node-${randomUUID()}`;
const statePath =
  process.env.MANAGED_BROWSER_STATE_PATH ||
  path.join(process.cwd(), 'leases.json');
const auditPath =
  process.env.MANAGED_BROWSER_AUDIT_PATH ||
  path.join(process.cwd(), 'audit.jsonl');
const policyPath =
  process.env.MANAGED_BROWSER_POLICY_PATH ||
  path.join(process.cwd(), 'tenants.example.yaml');
const poolToken = process.env.MANAGED_BROWSER_POOL_TOKEN || '';

const leases = new Map();
const lostLeases = [];
let stateLoaded = false;

function appendAudit(event) {
  appendAuditLine(auditPath, event);
}

function loadState() {
  if (stateLoaded) return;
  stateLoaded = true;
  lostLeases.push(...loadLostLeases({ statePath, auditPath, nodeId }));
}

function saveState() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const serializable = [...leases.values()].map((lease) => ({
    leaseId: lease.leaseId,
    tenantId: lease.tenantId,
    agentId: lease.agentId,
    sessionId: lease.sessionId,
    startedAt: lease.startedAt,
    expiresAt: lease.expiresAt,
    cdpInternalPort: lease.cdpInternalPort,
    cdpInternalPath: lease.cdpInternalPath,
  }));
  fs.writeFileSync(
    statePath,
    JSON.stringify({ nodeId, leases: serializable }, null, 2),
    'utf-8',
  );
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function isAuthorizedRequest(req, expectedToken = poolToken) {
  if (!expectedToken) return true;
  const raw = req.headers?.authorization;
  const authorization = Array.isArray(raw) ? raw[0] : raw;
  if (typeof authorization !== 'string') return false;
  const [scheme, token] = authorization.trim().split(/\s+/u);
  return (
    scheme?.toLowerCase() === 'bearer' &&
    typeof token === 'string' &&
    timingSafeStringEqual(token, expectedToken)
  );
}

function requireAuthorized(req, res) {
  if (isAuthorizedRequest(req)) return true;
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer',
  });
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return false;
}

function listen(server, listenHost = '127.0.0.1', listenPort = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function waitForFile(filePath, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(filePath)) {
        resolve(fs.readFileSync(filePath, 'utf-8'));
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${filePath}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function estimateCost(startedAtMs, endedAtMs) {
  const elapsedMs = Math.max(0, endedAtMs - startedAtMs);
  return Math.max(1, Math.ceil(elapsedMs / 60_000)) * 0.001;
}

async function launchChromiumLease({ tenantId, agentId }) {
  const guardServer = createGuardProxyServer({
    policyPath,
    fixedContext: { tenantId, agentId },
  });
  const guardAddress = await listen(guardServer);
  const guardPort = guardAddress.port;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-browser-'));
  const chrome = spawn(chromium.executablePath(), [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    `--proxy-server=http://127.0.0.1:${guardPort}`,
  ]);
  const devtoolsFile = path.join(userDataDir, 'DevToolsActivePort');
  try {
    const raw = await waitForFile(devtoolsFile, 15_000);
    const [debugPort, debugPath] = raw.split('\n');
    return {
      cdpInternalPort: Number.parseInt(debugPort, 10),
      cdpInternalPath: debugPath || '/',
      chrome,
      guardServer,
      userDataDir,
    };
  } catch (error) {
    guardServer.close();
    chrome.kill('SIGKILL');
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

export function scheduleLeaseExpiry(lease, release = releaseLease) {
  const delayMs = Math.max(0, lease.expiresAtMs - Date.now());
  lease.expiryTimer = setTimeout(() => {
    release(lease.leaseId, 'expired').catch(() => undefined);
  }, delayMs);
  lease.expiryTimer.unref?.();
}

async function closeChromiumLease(lease) {
  lease.chrome.kill('SIGTERM');
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      lease.chrome.kill('SIGKILL');
      resolve();
    }, 3_000);
    lease.chrome.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  await new Promise((resolve) => lease.guardServer.close(resolve));
  fs.rmSync(lease.userDataDir, { recursive: true, force: true });
}

async function createLease(body, publicHost) {
  const tenantId = String(body.tenantId || '').trim();
  const agentId = String(body.agentId || '').trim();
  const sessionId = String(body.sessionId || '').trim();
  if (!tenantId || !agentId || !sessionId) {
    throw new Error('tenantId, agentId, and sessionId are required');
  }
  const ttlSeconds = Math.max(
    1,
    Math.floor(Number.isFinite(body.ttlSeconds) ? body.ttlSeconds : 3600),
  );
  const browserRuntime = await launchChromiumLease({ tenantId, agentId });
  const leaseId = `lease-${randomUUID()}`;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const expiresAt = new Date(startedAtMs + ttlSeconds * 1000).toISOString();
  const expiresAtMs = startedAtMs + ttlSeconds * 1000;
  const lease = {
    leaseId,
    tenantId,
    agentId,
    sessionId,
    startedAt,
    startedAtMs,
    expiresAt,
    expiresAtMs,
    ...browserRuntime,
  };
  leases.set(leaseId, lease);
  scheduleLeaseExpiry(lease);
  saveState();
  appendAudit({
    type: 'browser.session_started',
    tenantId,
    agentId,
    sessionId,
    leaseId,
    nodeId,
    startedAt,
    expiresAt,
  });
  return {
    leaseId,
    nodeId,
    cdpUrl: `ws://${publicHost}/cdp/${encodeURIComponent(leaseId)}`,
    liveUrl: null,
    startedAt,
    expiresAt,
    costUsd: 0.001,
  };
}

function checkNavigation(lease, body) {
  const url = String(body.url || '').trim();
  if (!url) throw new Error('url is required');
  const verdict = evaluateTenantNavigation({
    policyPath,
    tenantId: lease.tenantId,
    agentId: lease.agentId,
    url,
    method: body.method,
  });
  appendAudit({
    type: 'browser.navigation',
    tenantId: lease.tenantId,
    agentId: lease.agentId,
    sessionId: lease.sessionId,
    leaseId: lease.leaseId,
    nodeId,
    url: verdict.url,
    verdict: verdict.verdict,
    reason: verdict.reason,
    matchedRule: verdict.matchedRule,
  });
  return verdict;
}

async function releaseLease(leaseId, reason = 'released') {
  const lease = leases.get(leaseId);
  if (!lease) return { leaseId, endedAt: new Date().toISOString(), costUsd: 0 };
  leases.delete(leaseId);
  if (lease.expiryTimer) clearTimeout(lease.expiryTimer);
  saveState();
  await closeChromiumLease(lease);
  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const costUsd = estimateCost(lease.startedAtMs, endedAtMs);
  appendAudit({
    type: 'browser.session_ended',
    tenantId: lease.tenantId,
    agentId: lease.agentId,
    sessionId: lease.sessionId,
    leaseId,
    nodeId,
    endedAt,
    reason,
    costUsd,
  });
  return { leaseId, endedAt, costUsd };
}

async function route(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'local'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    const tenantPolicies = readTenantPolicyFile(policyPath);
    sendJson(res, 200, {
      ok: true,
      nodeId,
      leases: leases.size,
      lostLeases: lostLeases.length,
      tenants: tenantPolicies.size,
      nodes: [
        {
          id: nodeId,
          status: 'healthy',
          activeLeases: leases.size,
          lostLeases: lostLeases.length,
        },
      ],
    });
    return;
  }

  if (!requireAuthorized(req, res)) return;

  if (req.method === 'POST' && url.pathname === '/leases') {
    sendJson(
      res,
      201,
      await createLease(
        await readRequestBody(req),
        req.headers.host || `127.0.0.1:${port}`,
      ),
    );
    return;
  }

  const leaseMatch = url.pathname.match(/^\/leases\/([^/]+)(?:\/navigation)?$/);
  if (leaseMatch) {
    const leaseId = decodeURIComponent(leaseMatch[1]);
    if (req.method === 'POST' && url.pathname.endsWith('/navigation')) {
      const lease = leases.get(leaseId);
      if (!lease) {
        sendJson(res, 404, { error: 'lease not found' });
        return;
      }
      sendJson(res, 200, checkNavigation(lease, await readRequestBody(req)));
      return;
    }
    if (
      req.method === 'DELETE' &&
      url.pathname === `/leases/${leaseMatch[1]}`
    ) {
      sendJson(res, 200, await releaseLease(leaseId));
      return;
    }
  }

  sendJson(res, 404, { error: 'not found' });
}

export function createManagedBrowserPoolServer() {
  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  server.on('upgrade', (req, clientSocket, head) => {
    if (!isAuthorizedRequest(req)) {
      clientSocket.destroy();
      return;
    }
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'local'}`,
    );
    const match = url.pathname.match(/^\/cdp\/([^/]+)$/);
    if (!match) {
      clientSocket.destroy();
      return;
    }
    const lease = leases.get(decodeURIComponent(match[1]));
    if (!lease) {
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect(lease.cdpInternalPort, '127.0.0.1', () => {
      const headers = Object.entries(req.headers)
        .filter(([key]) => key.toLowerCase() !== 'host')
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n');
      upstream.write(
        `${req.method} ${lease.cdpInternalPath} HTTP/${req.httpVersion}\r\nHost: 127.0.0.1:${lease.cdpInternalPort}\r\n${headers}\r\n\r\n`,
      );
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => {
      clientSocket.destroy();
    });
  });

  return server;
}

export function startManagedBrowserPoolServer() {
  loadState();
  const server = createManagedBrowserPoolServer();
  server.listen(port, host, () => {
    console.log(`managed browser pool listening on http://${host}:${port}`);
  });

  process.on('SIGTERM', async () => {
    for (const leaseId of [...leases.keys()]) {
      await releaseLease(leaseId).catch(() => undefined);
    }
    server.close(() => process.exit(0));
  });

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startManagedBrowserPoolServer();
}
