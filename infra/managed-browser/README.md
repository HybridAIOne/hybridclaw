# Managed Browser Pool

This is the R30.3 operator-run browser substrate. It exposes a session lease API
for `ManagedCloudBrowserProvider` and keeps navigation-policy enforcement in one
shared guard path for every leased Chromium worker.

## Run

```bash
export MANAGED_BROWSER_POOL_TOKEN=replace-with-a-random-token
docker compose -f infra/managed-browser/docker-compose.yml up --build
hybridclaw config set browser.provider managed-cloud
hybridclaw config set browser.managedCloud.endpointUrl http://127.0.0.1:8787
hybridclaw config set browser.managedCloud.poolTokenRef '{"source":"store","id":"MANAGED_BROWSER_POOL_TOKEN"}'
hybridclaw browser-pool doctor
```

Tenant host policy lives in `tenants.example.yaml` by default. Production
deployments should mount a generated tenant policy file from the operator's R25
deployment recipe. The Hetzner overlay is
`infra/managed-browser/hetzner.compose.yml`.

## API

- `GET /ping` returns a minimal unauthenticated liveness response.
- `GET /health` returns node and lost-lease state for `browser-pool doctor`.
- `POST /leases` creates a tenant-bound Chromium lease and returns `leaseId`,
  `nodeId`, and a CDP `cdpUrl`.
- `POST /leases/:leaseId/navigation` runs the shared navigation guard and emits
  a `browser.navigation` JSONL event with `allow` or `deny`.
- Chromium workers are launched with an HTTP proxy bound to the guard. For
  HTTPS, the guard evaluates the target host before opening the upstream
  `CONNECT`, so denied hosts are blocked before DNS or TCP egress.
- `DELETE /leases/:leaseId` releases the worker and records
  `browser.session_ended`.

When `MANAGED_BROWSER_POOL_TOKEN` is set, all non-ping API and CDP requests
must include `Authorization: Bearer <token>`. The Compose recipe requires this
token because it publishes the lease API on a host port.

The default Compose port publish address is host loopback
(`MANAGED_BROWSER_PUBLISH_HOST=127.0.0.1`). Keep the pool on loopback or a
private network unless a TLS reverse proxy terminates HTTPS in front of it.
SecretRef-backed form fills are typed over the CDP WebSocket after local
policy checks, so public deployments must not expose raw `http://` or `ws://`
pool traffic. When a reverse proxy is used, forward `X-Forwarded-Proto: https`
and `X-Forwarded-Host` so lease responses return `wss://` CDP URLs.

Standalone `npm run guard` mode reads tenant context from request headers and
must only be reachable by the browser pool process or another trusted proxy.

If the process restarts with active leases in `MANAGED_BROWSER_STATE_PATH`, they
are surfaced as `browser.session_lost` events on startup instead of being
silently forgotten.
