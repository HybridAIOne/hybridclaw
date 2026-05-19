import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { evaluateTenantNavigation } from './policy.js';

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function parseTargetFromRequest(req) {
  if (req.url?.startsWith('http://') || req.url?.startsWith('https://')) {
    return new URL(req.url);
  }
  const host = req.headers.host || '';
  return new URL(`http://${host}${req.url || '/'}`);
}

function readHeaderContext(req) {
  const tenantId = String(req.headers['x-hybridclaw-tenant-id'] || '').trim();
  const agentId = String(req.headers['x-hybridclaw-agent-id'] || '').trim();
  return tenantId && agentId ? { tenantId, agentId } : null;
}

function assertAllowed({ policyPath, context, url, method }) {
  if (!context?.tenantId || !context?.agentId) {
    throw new Error('missing tenant guard context');
  }
  const decision = evaluateTenantNavigation({
    policyPath,
    tenantId: context.tenantId,
    agentId: context.agentId,
    url,
    method,
  });
  if (decision.verdict !== 'allow') {
    throw new Error(decision.reason || 'navigation denied');
  }
  return decision;
}

function parseConnectTarget(authority) {
  const raw = String(authority || '').trim();
  if (!raw) throw new Error('invalid CONNECT target');

  let host = '';
  let rawPort = '';
  if (raw.startsWith('[')) {
    const hostEnd = raw.indexOf(']');
    if (hostEnd <= 1) throw new Error('invalid CONNECT target');
    host = raw.slice(1, hostEnd);
    const rest = raw.slice(hostEnd + 1);
    if (!rest) {
      rawPort = '443';
    } else if (rest.startsWith(':')) {
      rawPort = rest.slice(1);
    } else {
      throw new Error('invalid CONNECT target');
    }
  } else {
    const parts = raw.split(':');
    if (parts.length > 2) throw new Error('invalid CONNECT target');
    host = parts[0] || '';
    rawPort = parts[1] ?? '443';
  }

  const port = Number.parseInt(rawPort, 10);
  if (
    !host ||
    !rawPort ||
    !Number.isInteger(port) ||
    String(port) !== rawPort ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('invalid CONNECT port');
  }

  const urlHost = host.includes(':') ? `[${host}]` : host;
  return {
    host,
    port,
    url: `https://${urlHost}${port === 443 ? '' : `:${port}`}/`,
  };
}

function forwardHttpRequest(req, res, target) {
  const headers = { ...req.headers };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  delete headers['x-hybridclaw-tenant-id'];
  delete headers['x-hybridclaw-agent-id'];

  const upstream = http.request(
    target,
    {
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    send(res, 502, error instanceof Error ? error.message : String(error));
  });
  req.pipe(upstream);
}

export function createGuardProxyServer({
  policyPath,
  fixedContext,
  resolveContext = readHeaderContext,
}) {
  const server = http.createServer((req, res) => {
    try {
      const target = parseTargetFromRequest(req);
      assertAllowed({
        policyPath,
        context: fixedContext || resolveContext(req),
        url: target.toString(),
        method: req.method,
      });
      if (target.protocol !== 'http:') {
        send(res, 501, 'HTTP proxy only accepts CONNECT for HTTPS targets');
        return;
      }
      forwardHttpRequest(req, res, target);
    } catch (error) {
      send(res, 403, error instanceof Error ? error.message : String(error));
    }
  });

  server.on('connect', (req, clientSocket, head) => {
    let target;
    try {
      target = parseConnectTarget(req.url);
      assertAllowed({
        policyPath,
        context: fixedContext || resolveContext(req),
        url: target.url,
      });
    } catch (error) {
      clientSocket.write(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${error instanceof Error ? error.message : String(error)}`,
      );
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect(target.port, target.host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
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

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const host = process.env.MANAGED_BROWSER_GUARD_HOST || '127.0.0.1';
  const port = Number.parseInt(
    process.env.MANAGED_BROWSER_GUARD_PORT || '8888',
    10,
  );
  const policyPath =
    process.env.MANAGED_BROWSER_POLICY_PATH ||
    new URL('./tenants.example.yaml', import.meta.url).pathname;
  const server = createGuardProxyServer({ policyPath });
  server.listen(port, host, () => {
    console.log(`navigation guard proxy listening on http://${host}:${port}`);
  });
}
