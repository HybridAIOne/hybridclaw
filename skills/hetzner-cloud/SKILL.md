---
name: hetzner-cloud
description: "Read and operate Hetzner Cloud servers, server types, locations, networks, volumes, snapshots, and cost estimates through gateway-proxied API requests."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: hetzner-api-token
    kind: bearer
    required: true
    secret_ref:
      source: store
      id: HETZNER_API_TOKEN
    scope: "api.hetzner.cloud/v1"
    how_to_obtain: "Create a Hetzner Console API token for the target project with read-only scope for inventory work or read-write scope only when provisioning, snapshotting, restoring, or deleting resources. Set `HETZNER_API_TOKEN` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set HETZNER_API_TOKEN \"<hetzner-console-api-token>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set HETZNER_API_TOKEN \"<hetzner-console-api-token>\"`."
metadata:
  hybridclaw:
    category: infrastructure
    short_description: "Hetzner Cloud VPS inventory, provisioning, resizing, snapshots, and guarded deletes."
    tags:
      - hetzner
      - cloud
      - vps
      - snapshots
      - infrastructure
    stakes_tiers:
      green:
        - list-servers
        - get-server
        - list-server-types
        - list-locations
        - list-images
        - list-prices
        - list-volumes
        - get-volume
        - list-networks
        - get-network
      amber:
        - create-server
        - create-volume
        - create-snapshot
        - attach-volume
        - detach-volume
        - attach-network
        - detach-network
        - change-server-type
        - upgrade-server
        - downgrade-server
      red:
        - restore-snapshot
        - delete-server
        - delete-vps
        - delete-snapshot
        - destroy-snapshot
        - delete-volume
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: hetzner-cloud
---

# Hetzner Cloud

Use this skill for Hetzner Cloud VPS inventory, provisioning, network and volume
inspection, cost estimates, and snapshot lifecycle work.

## Default Workflow

1. Start read-only: list servers, locations, server types, images, prices,
   volumes, and networks.
2. Use `plan` for natural-language requests before building any write request.
3. Treat `hetzner_cloud.cjs` as the API wrapper. Do not handcraft Hetzner Cloud
   API URLs, JSON bodies, tiers, or secret refs from memory.
4. For prompt/user testing, stop after `plan` or after helper `http-request`
   payload generation. Do not call helper `run` or the built-in `http_request`
   tool.
5. For real user requests that need live Hetzner API data, use helper `run`.
   The helper constructs the request, sends it through the HybridClaw gateway,
   and the gateway injects `bearerSecretName: "HETZNER_API_TOKEN"` server-side.
   Do not rewrite that secret reference into `secretHeaders`, preflight it,
   inspect it, or ask the model for the token.
6. Use `http-request` only when you need to inspect the generated gateway
   payload or when the active runtime cannot give the helper gateway access.
7. If a live helper `run` or `http_request` call returns 401 or 403, stop after
   that first
   failure. Do not retry, do not fan out to more endpoints, and ask the operator
   to set or verify `HETZNER_API_TOKEN`.
8. Require an explicit operator grant before any changing action, including
   delete, upgrade, downgrade, buy/create, restore, attach, detach, snapshot,
   network, or volume mutation. Pass `--operator-grant` only after that grant.
9. Use `--project acme` for project-scoped inventory and provisioning. The
   helper converts it to `project=acme` label selectors or labels where the
   Hetzner API supports them.
10. Never paste, print, or inspect `HETZNER_API_TOKEN`; the gateway injects it
   server-side with `bearerSecretName: "HETZNER_API_TOKEN"`.
11. Do not repeat the same read call unless the previous result was ambiguous or
    stale. For a named resize, one `list-servers --project <project> --name
    <name>` call is enough to resolve the server id.

See [references/operator-setup.md](references/operator-setup.md) for operator
setup, token scope, autonomy defaults, and cost-reporting expectations.

## Command Contract

Run the helper:

```bash
node skills/hetzner-cloud/hetzner_cloud.cjs --help
```

Plan a request without contacting Hetzner:

```bash
node skills/hetzner-cloud/hetzner_cloud.cjs --format json plan "Create a demo VPS in Falkenstein until Monday"
```

Run live read requests:

```bash
node skills/hetzner-cloud/hetzner_cloud.cjs --format json run list-servers --project acme
node skills/hetzner-cloud/hetzner_cloud.cjs --format json run list-server-types
node skills/hetzner-cloud/hetzner_cloud.cjs --format json run list-locations
node skills/hetzner-cloud/hetzner_cloud.cjs --format json run list-prices --project acme
node skills/hetzner-cloud/hetzner_cloud.cjs --format json run list-volumes --project acme
node skills/hetzner-cloud/hetzner_cloud.cjs --format json run list-networks --project acme
```

Run guarded live write requests:

```bash
node skills/hetzner-cloud/hetzner_cloud.cjs --format json run create-server \
  --name acme-demo --server-type cax11 --image ubuntu-24.04 --location fsn1 \
  --project acme --label ttl=2026-05-18 --operator-grant

node skills/hetzner-cloud/hetzner_cloud.cjs --format json run create-snapshot \
  --project acme --server-id 123456 --description "pre-deploy" --operator-grant

node skills/hetzner-cloud/hetzner_cloud.cjs --format json run restore-snapshot \
  --server-id 123456 --snapshot-id 987654 --operator-grant

node skills/hetzner-cloud/hetzner_cloud.cjs --format json run attach-network \
  --server-id 123456 --network-id 555 --ip 10.0.0.12 --operator-grant

node skills/hetzner-cloud/hetzner_cloud.cjs --format json run attach-volume \
  --server-id 123456 --volume-id 777 --automount --operator-grant

node skills/hetzner-cloud/hetzner_cloud.cjs --format json run downgrade-server \
  --server-id 123456 --server-type cpx32 --operator-grant

node skills/hetzner-cloud/hetzner_cloud.cjs --format json run delete-server \
  --server-id 123456 --operator-grant
```

Build a dry-run gateway payload without calling Hetzner:

```bash
node skills/hetzner-cloud/hetzner_cloud.cjs --format json http-request list-servers --project acme
```

Resize/change type contract:

1. If the user named a server instead of giving an id, resolve it once:

   ```bash
   node skills/hetzner-cloud/hetzner_cloud.cjs --format json run list-servers \
     --project datalion --name bastion
   ```

2. Ask for explicit approval for the exact server id and target type.

3. Build the request with the helper:

   ```bash
   node skills/hetzner-cloud/hetzner_cloud.cjs --format json run downgrade-server \
     --server-id 123456 --server-type cpx32 --operator-grant
   ```

4. Inspect the helper `run` response. Do not also call `http_request` for the
   same request.

The `change_type` payload is `json.server_type` plus `json.upgrade_disk`.
Never send `json.type`, never omit `upgrade_disk`, and never rewrite
`bearerSecretName: "HETZNER_API_TOKEN"` into `secretHeaders`.
The helper emits generic `skillRequestContract` metadata for this operation;
pass it through unchanged so the gateway can validate the helper-built request.
Do not call `list-server-types` before a simple resize unless the user asks for
price or disk validation; Hetzner accepts `cpx32` directly in `server_type`.

## Working Rules

- Treat `delete-server`, `delete-vps`, `delete-snapshot`,
  `destroy-snapshot`, `delete-volume`, and `restore-snapshot` as red-risk
  actions. Stop unless the operator grants the exact target id.
- Treat `create-server`, `create-volume`, `change-server-type`,
  `upgrade-server`, and `downgrade-server` as changing cost or capacity actions.
  Ask for explicit approval before building a live request with
  `--operator-grant`.
- For `change-server-type`, `upgrade-server`, and `downgrade-server`, pass the
  target plan as `--server-type <name>` or `--server-type-id <id>` to the helper.
  The Hetzner `change_type` API accepts either an id or a name in `server_type`;
  never send the old `type` field.
- Keep disk size by default for type changes. Use `--upgrade-disk` only when
  the operator explicitly asks to expand the primary disk, because expanded
  disks cannot later be downgraded.
- Use read-only tokens for inventory and cost reporting. Ask for read-write
  tokens only for the requested mutation window.
- For demo servers, include owner/project and TTL labels before provisioning.
- For rollback workflows, create the snapshot first, wait for the Hetzner
  action to finish, and use `restore-snapshot` only after the operator confirms
  the target server id and snapshot id.
- Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper output
  includes `costMeasurement.system = "UsageTotals"` for eval verification.

## Eval Suite

```bash
node skills/hetzner-cloud/hetzner_cloud.cjs --format json eval-scenarios
```

The fixture at `evals/scenarios.json` contains 10 Cloud scenarios covering
inventory, cost reporting, provisioning, snapshots, rollback, and cleanup.

## Validation

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/hetzner-cloud
node skills/hetzner-cloud/hetzner_cloud.cjs --help
node skills/hetzner-cloud/hetzner_cloud.cjs --format json eval-scenarios
```
