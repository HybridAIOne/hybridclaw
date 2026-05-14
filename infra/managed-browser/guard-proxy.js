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

function assertAllowed({ policyPath, context, url }) {
  if (!context?.tenantId || !context?.agentId) {
    throw new Error('missing tenant guard context');
  }
  const decision = evaluateTenantNavigation({
    policyPath,
    tenantId: context.tenantId,
    agentId: context.agentId,
    url,
  });
  if (decision.verdict !== 'allow') {
    throw new Error(decision.reason || 'navigation denied');
  }
  return decision;
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
    const [host, rawPort] = String(req.url || '').split(':');
    const port = Number.parseInt(rawPort || '443', 10);
    try {
      assertAllowed({
        policyPath,
        context: fixedContext || resolveContext(req),
        url: `https://${host}/`,
      });
    } catch (error) {
      clientSocket.write(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${error instanceof Error ? error.message : String(error)}`,
      );
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect(port, host, () => {
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
