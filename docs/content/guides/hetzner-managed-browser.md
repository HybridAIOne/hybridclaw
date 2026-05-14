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

docker compose \
  -f infra/managed-browser/docker-compose.yml \
  -f infra/managed-browser/hetzner.compose.yml \
  up -d --build

hybridclaw config set browser.provider managed-cloud
hybridclaw config set browser.managedCloud.endpointUrl http://127.0.0.1:8787
hybridclaw browser-pool doctor
```

The tenant file is deny-by-default. Add only the hosts each tenant needs. The
guard evaluates the tenant policy before opening upstream proxy connections,
so denied HTTPS `CONNECT` targets are rejected before DNS or TCP egress.
