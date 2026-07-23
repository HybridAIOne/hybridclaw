import { lookup } from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import {
  browserPrivateNetworkAllowed,
  isPrivateBrowserIp,
} from '../../container/shared/browser-navigation.js';
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

function evaluateAllowedNavigation({ policyPath, context, url, method }) {
  if (!context?.tenantId || !context?.agentId) {
    return {
      verdict: 'deny',
      reason: 'missing tenant guard context',
    };
  }
  return evaluateTenantNavigation({
    policyPath,
    tenantId: context.tenantId,
    agentId: context.agentId,
    url,
    method,
  });
}

function parseConnectTarget(authority) {
  const raw = String(authority || '').trim();
  if (!raw) return { error: 'invalid CONNECT target' };

  let host = '';
  let rawPort = '';
  if (raw.startsWith('[')) {
    const hostEnd = raw.indexOf(']');
    if (hostEnd <= 1) return { error: 'invalid CONNECT target' };
    host = raw.slice(1, hostEnd);
    const rest = raw.slice(hostEnd + 1);
    if (!rest) {
      rawPort = '443';
    } else if (rest.startsWith(':')) {
      rawPort = rest.slice(1);
    } else {
      return { error: 'invalid CONNECT target' };
    }
  } else {
    const parts = raw.split(':');
    if (parts.length > 2) return { error: 'invalid CONNECT target' };
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
    return { error: 'invalid CONNECT port' };
  }

  const urlHost = host.includes(':') ? `[${host}]` : host;
  return {
    host,
    port,
    url: `https://${urlHost}${port === 443 ? '' : `:${port}`}/`,
  };
}

async function resolveUpstreamAddress(hostname) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error('target host did not resolve');
  }
  if (
    !browserPrivateNetworkAllowed() &&
    addresses.some((entry) => isPrivateBrowserIp(entry.address))
  ) {
    throw new Error('private network targets are disabled');
  }
  return addresses[0];
}

function forwardHttpRequest(req, res, target, address) {
  const headers = { ...req.headers };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  delete headers['x-hybridclaw-tenant-id'];
  delete headers['x-hybridclaw-agent-id'];
  headers.host = target.host;

  // lgtm[js/request-forgery] The tenant policy validates the requested URL,
  // then DNS is resolved once and the checked address is pinned at this sink.
  const upstream = http.request(
    {
      hostname: address.address,
      family: address.family,
      port: Number.parseInt(target.port || '80', 10),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    send(res, 502, 'upstream request failed');
  });
  req.pipe(upstream);
}

export function createGuardProxyServer({
  policyPath,
  fixedContext,
  resolveContext = readHeaderContext,
}) {
  const server = http.createServer((req, res) => {
    void (async () => {
      let target;
      try {
        target = parseTargetFromRequest(req);
      } catch {
        send(res, 403, 'invalid proxy target');
        return;
      }

      let decision;
      try {
        decision = evaluateAllowedNavigation({
          policyPath,
          context: fixedContext || resolveContext(req),
          url: target.toString(),
          method: req.method,
        });
      } catch {
        send(res, 403, 'navigation denied');
        return;
      }
      if (decision.verdict !== 'allow') {
        send(res, 403, decision.reason || 'navigation denied');
        return;
      }
      if (target.protocol !== 'http:') {
        send(res, 501, 'HTTP proxy only accepts CONNECT for HTTPS targets');
        return;
      }

      try {
        const address = await resolveUpstreamAddress(target.hostname);
        forwardHttpRequest(req, res, target, address);
      } catch {
        send(res, 403, 'target resolution denied');
      }
    })();
  });

  server.on('connect', (req, clientSocket, head) => {
    void (async () => {
      const target = parseConnectTarget(req.url);
      if (target.error) {
        clientSocket.write(
          `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${target.error}`,
        );
        clientSocket.destroy();
        return;
      }

      let decision;
      try {
        decision = evaluateAllowedNavigation({
          policyPath,
          context: fixedContext || resolveContext(req),
          url: target.url,
        });
      } catch {
        clientSocket.write(
          'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nnavigation denied',
        );
        clientSocket.destroy();
        return;
      }
      if (decision.verdict !== 'allow') {
        clientSocket.write(
          `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${decision.reason || 'navigation denied'}`,
        );
        clientSocket.destroy();
        return;
      }

      let address;
      try {
        address = await resolveUpstreamAddress(target.host);
      } catch {
        clientSocket.write(
          'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\ntarget resolution denied',
        );
        clientSocket.destroy();
        return;
      }

      const upstream = net.connect(
        {
          port: target.port,
          host: address.address,
          family: address.family,
        },
        () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        },
      );
      upstream.on('error', () => {
        clientSocket.destroy();
      });
    })();
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
