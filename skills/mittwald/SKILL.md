---
name: mittwald
description: "Read and inspect mittwald mStudio projects, apps, runtimes, databases, domains, mail, backups, files, containers, and access users through SecretRef-backed API requests."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: mittwald-api-token
    kind: bearer
    required: true
    secret_ref:
      source: store
      id: MITTWALD_API_TOKEN
    scope: "https://api.mittwald.de Authorization bearer"
    how_to_obtain: |
      Create an API token in mittwald mStudio under the user profile API token
      settings. Set `MITTWALD_API_TOKEN` through browser admin at
      `/admin/secrets`; if browser admin is unavailable,
      use `/secret set MITTWALD_API_TOKEN "<token>"` in browser `/chat` or TUI;
      local console fallback:
      `hybridclaw secret set MITTWALD_API_TOKEN "<token>"`.
metadata:
  hybridclaw:
    category: infrastructure
    short_description: "mittwald mStudio read operations and guarded production planning."
    tags:
      - mittwald
      - mstudio
      - hosting
      - infrastructure
      - production
    related_roadmap:
      - R21.104
    issue: 1068
    stakes_tiers:
      green:
        - whoami
        - projects
        - project
        - apps
        - app
        - app-status
        - app-system-software
        - databases
        - mysql-databases
        - redis-databases
        - domains
        - dns-zones
        - ingresses
        - backups
        - backup
        - backup-path
        - backup-database-dumps
        - cronjobs
        - ssh-users
        - sftp-users
        - mail-addresses
        - delivery-boxes
        - mail-settings
        - stacks
        - services
        - service
        - volumes
        - registries
        - service-logs
        - file-info
        - directory
        - disk-usage
        - extension-orders
        - extension-instances
        - extension-instance
        - licenses
        - check-domain-availability
      amber:
        - create-redis-database
        - create-mysql-database
        - create-app-installation
        - create-cronjob
        - change-domain-project
        - update-domain-nameservers
        - cancel-domain-deletion
        - validate-license-key
        - create-delivery-box
      red:
        - service-action
        - restore-backup
        - restore-backup-path
        - schedule-domain-deletion
        - order-extension
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: mittwald
---

# mittwald

Use this skill for mittwald mStudio / Kundencenter production-platform work:
project inventory, app/runtime inspection, deployment readiness, databases,
domains/DNS/SSL/ingress, mail resources, backups, files, containers, SSH/SFTP
users, and marketplace/license readouts.

## Default Workflow

1. Read first. Use `mittwald.cjs` to generate allowlisted `http_request`
   payloads and pass only the emitted `httpRequest` value to the built-in
   `http_request` tool.
2. Treat `MITTWALD_API_TOKEN` as a SecretRef only. The helper sets
   `bearerSecretName: "MITTWALD_API_TOKEN"` so the gateway injects
   `Authorization: Bearer ...` server-side. Never ask the user to paste the
   token, inspect it, or write raw `Authorization` headers.
3. For prompt/user testing, stop after `plan` or helper `http-request` payload
   generation. Do not call `http_request` unless live mittwald data is needed
   for the user's request.
4. For live calls, stop after the first 401 or 403. Report a credential or API
   role setup problem and ask the operator to verify `MITTWALD_API_TOKEN` in
   this order: browser admin at the active `/admin/secrets` route,
   `/secret set MITTWALD_API_TOKEN "<mittwald-api-token>"` in browser `/chat`
   or TUI, then local console fallback
   `hybridclaw secret set MITTWALD_API_TOKEN "<mittwald-api-token>"`.
5. For 429 responses, report rate-limit guidance from `Retry-After`,
   `X-RateLimit-Reset`, `X-RateLimit-Remaining`, and `X-RateLimit-Limit` when
   present. Do not start retry loops.
6. For guarded writes, require exact F8/F14 operator approval for the named
   target and pass `--operator-grant` only after that approval. The helper
   includes the target resource id in `approval.requiredGrant`.
7. Account for eventual consistency after writes: mutating responses may return
   an `etag` event id. Run the emitted `event-follow-up` command with
   `--event-id <etag>` so the read uses `if-event-reached` before reporting
   completion.
8. Do not use `curl` as the normal execution path when `http_request` is
   available.

The helper is read-first. Guarded write operations exist only for allowlisted
mittwald API shapes and require exact F8/F14 approval: service actions, database
creation, app installation creation, cronjob creation, domain
project/nameserver/deletion changes, backup restore, delivery box creation,
license-key validation, and extension ordering. App installation runtime actions
are intentionally not exposed because the current mittwald OpenAPI marks that
endpoint deprecated and non-functional. Do not create API tokens or use unlisted
marketplace mutations.

## Command Contract

```bash
node skills/mittwald/mittwald.cjs --help
```

Build core read requests:

```bash
node skills/mittwald/mittwald.cjs --format json http-request whoami
node skills/mittwald/mittwald.cjs --format json http-request projects --limit 50
node skills/mittwald/mittwald.cjs --format json http-request project --project-id <project-id>
node skills/mittwald/mittwald.cjs --format json http-request apps --project-id <project-id> --limit 50
node skills/mittwald/mittwald.cjs --format json http-request domains --project-id <project-id> --limit 50
node skills/mittwald/mittwald.cjs --format json http-request backups --project-id <project-id> --limit 50
```

Build database and runtime requests:

```bash
node skills/mittwald/mittwald.cjs --format json http-request databases --project-id <project-id>
node skills/mittwald/mittwald.cjs --format json http-request app-status --app-installation-id <app-installation-id>
node skills/mittwald/mittwald.cjs --format json http-request services --project-id <project-id> --limit 50
node skills/mittwald/mittwald.cjs --format json http-request service-logs --stack-id <stack-id> --service-id <service-id> --tail 200
```

Build operational inventory requests:

```bash
node skills/mittwald/mittwald.cjs --format json http-request dns-zones --project-id <project-id>
node skills/mittwald/mittwald.cjs --format json http-request ingresses --project-id <project-id>
node skills/mittwald/mittwald.cjs --format json http-request cronjobs --project-id <project-id> --limit 50
node skills/mittwald/mittwald.cjs --format json http-request mail-addresses --project-id <project-id> --limit 50
node skills/mittwald/mittwald.cjs --format json http-request ssh-users --project-id <project-id> --limit 50
node skills/mittwald/mittwald.cjs --format json http-request sftp-users --project-id <project-id> --limit 50
node skills/mittwald/mittwald.cjs --format json http-request directory --project-id <project-id> --directory /html --max-depth 1
```

Plan a deployment readiness sweep:

```bash
node skills/mittwald/mittwald.cjs --format json plan deploy-check --project-id <project-id>
```

Build guarded write requests after exact operator approval:

```bash
node skills/mittwald/mittwald.cjs --format json http-request create-redis-database \
  --project-id <project-id> --description cache-prod --version 7.0 --operator-grant

node skills/mittwald/mittwald.cjs --format json http-request create-mysql-database \
  --project-id <project-id> --description app-prod --version 8.4 \
  --password-secret MITTWALD_MYSQL_PASSWORD --operator-grant

node skills/mittwald/mittwald.cjs --format json http-request service-action \
  --stack-id <stack-id> --service-id <service-id> --action restart --operator-grant

node skills/mittwald/mittwald.cjs --format json http-request update-domain-nameservers \
  --domain-id <domain-id> --nameserver ns1.example.com --nameserver ns2.example.com \
  --operator-grant

node skills/mittwald/mittwald.cjs --format json http-request restore-backup-path \
  --backup-id <backup-id> --source-path /html --target-path /html-restore \
  --operator-grant

node skills/mittwald/mittwald.cjs --format json http-request order-extension \
  --extension-id <extension-id> \
  --body-json '{"projectId":"<project-id>","consentedScopes":[]}' \
  --operator-grant
```

After a live write returns an `etag` header, build the consistency read:

```bash
node skills/mittwald/mittwald.cjs --format json event-follow-up service-action \
  --stack-id <stack-id> --service-id <service-id> --event-id <etag>
```

Classify saved or live `http_request` failures:

```bash
node skills/mittwald/mittwald.cjs --format json classify-response \
  --status 429 \
  --headers-json '{"X-RateLimit-Remaining":"0","X-RateLimit-Reset":"10"}'
```

## Working Rules

- The mStudio v2 API base URL is `https://api.mittwald.de/v2/`.
- The helper only builds allowlisted endpoint shapes. Do not add arbitrary path
  passthrough for operator convenience.
- `databases` emits two `httpRequests` items: MySQL databases and Redis
  databases. Send each item through `http_request`, then merge the results in
  the response.
- Use `domains`, `dns-zones`, and `ingresses` together when checking
  domain/DNS/SSL/ingress state.
- Use `apps`, `app-status`, `app-system-software`, `services`, `stacks`, and
  `service-logs` to summarize runtime health. Keep logs bounded with `--tail`.
- Use `backups`, `backup-path`, and `backup-database-dumps` for backup
  readiness. Backup restore operations are red and require exact target approval.
- Use `extension-orders`, `extension-instances`, and `licenses` for marketplace
  and license visibility. `order-extension` and license-key validation are
  guarded mutations and require exact F8/F14 approval.
- For mutating operations that need complex request bodies, use `--body-json`
  only on that allowlisted operation. `create-app-installation` requires
  `appVersionId`, `description`, `updatePolicy`, and `userInputs[]`.
  `create-cronjob` requires `description`, `interval`, and `target`.
  `restore-backup` requires `pathRestore` or `databaseRestores[]`.
  `order-extension` requires `consentedScopes[]` plus exactly one of
  `projectId` or `customerId`.
- Use `<secret:NAME>`-style placeholders via flags such as `--password-secret`
  and `--license-key-secret`; never put raw credentials in command arguments.
- Optional companion workflows: the official mittwald CLI, SDKs, Terraform
  provider, and mittwald MCP docs can inform operator guidance, but they are
  not runtime dependencies for this bundled skill.

## Validation

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/mittwald
node skills/mittwald/mittwald.cjs --help
```
