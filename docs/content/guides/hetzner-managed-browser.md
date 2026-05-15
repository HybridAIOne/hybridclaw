---
title: Hetzner Managed Browser Pool
description: Deploy the R30.3 managed browser pool on a single Hetzner EU host.
---

# Hetzner Managed Browser Pool

This R25 recipe runs the R30.3 managed browser pool on a single Hetzner EU
server. It keeps Chromium workers, the lease API, and the navigation guard on
operator-owned infrastructure.

## Files

- `infra/managed-browser/docker-compose.yml`
- `infra/managed-browser/hetzner.compose.yml`
- `/srv/hybridclaw/managed-browser/tenants.yaml`

## Setup

```bash
sudo mkdir -p /srv/hybridclaw/managed-browser/data
sudo cp infra/managed-browser/tenants.example.yaml \
  /srv/hybridclaw/managed-browser/tenants.yaml

export MANAGED_BROWSER_POOL_TOKEN=replace-with-a-random-token
docker compose \
  -f infra/managed-browser/docker-compose.yml \
  -f infra/managed-browser/hetzner.compose.yml \
  up -d --build

# In a separate terminal:
ssh -N -L 8787:127.0.0.1:8787 root@your-hetzner-host

hybridclaw config set browser.provider managed-cloud
hybridclaw config set browser.managedCloud.endpointUrl http://127.0.0.1:8787
hybridclaw config set browser.managedCloud.poolTokenRef '{"source":"store","id":"MANAGED_BROWSER_POOL_TOKEN"}'
hybridclaw browser-pool doctor
```

The overlay intentionally inherits the base host-loopback port publish
(`MANAGED_BROWSER_PUBLISH_HOST=127.0.0.1`). Use an SSH tunnel, a private
network, or a TLS-terminating reverse proxy to reach the pool. Do not expose the
raw `http://` lease API or `ws://` CDP endpoint on the public internet because
SecretRef-backed field fills and the bearer token traverse the CDP and HTTP
connections after local policy checks. If you publish the service through a
reverse proxy, terminate TLS and forward `X-Forwarded-Proto: https` and
`X-Forwarded-Host` so leases advertise `wss://` CDP URLs.

The tenant file is deny-by-default. Add only the hosts each tenant needs. The
guard evaluates the tenant policy before opening upstream proxy connections,
so denied HTTPS `CONNECT` targets are rejected before DNS or TCP egress.
Set `browser.managedCloud.poolTokenRef` to a SecretRef containing the same token
when the client connects to a token-protected pool.
