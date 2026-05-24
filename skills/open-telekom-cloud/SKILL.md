---
name: open-telekom-cloud
description: "Read T Cloud Public (formerly Open Telekom Cloud) infrastructure inventory and prepare guarded DevOps operations through gateway-managed OTC API signing."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: otc-access-key-id
    kind: header
    required: true
    secret_ref:
      source: store
      id: OTC_ACCESS_KEY_ID
    scope: "T Cloud Public / Open Telekom Cloud AK/SK request signing"
    how_to_obtain: "Create an OTC access key in My Credentials > Access Keys and store the Access Key Id as OTC_ACCESS_KEY_ID. Use a least-privilege IAM user for inventory work."
  - id: otc-secret-access-key
    kind: header
    required: true
    secret_ref:
      source: store
      id: OTC_SECRET_ACCESS_KEY
    scope: "T Cloud Public / Open Telekom Cloud AK/SK request signing"
    how_to_obtain: "Save the Secret Access Key from the OTC access key CSV as OTC_SECRET_ACCESS_KEY. Never paste it into chat or project files."
  - id: otc-project-id
    kind: header
    required: true
    secret_ref:
      source: store
      id: OTC_PROJECT_ID
    scope: "T Cloud Public / Open Telekom Cloud regional project paths"
    how_to_obtain: "Copy the target regional project ID from My Credentials > API Credentials and store it as OTC_PROJECT_ID."
  - id: otc-region
    kind: header
    required: false
    secret_ref:
      source: store
      id: OTC_REGION
    scope: "Default T Cloud Public / Open Telekom Cloud region"
    how_to_obtain: "Store the default region, for example eu-de, as OTC_REGION or pass --region explicitly."
metadata:
  hybridclaw:
    category: infrastructure
    short_description: "OTC infrastructure inventory, readiness checks, and guarded operation planning."
    tags:
      - t-cloud-public
      - open-telekom-cloud
      - t-systems
      - devops
      - infrastructure
      - otc
      - production
    stakes_tiers:
      green:
        - regions
        - projects
        - service-endpoints
        - services
        - service-status
        - quotas
        - servers
        - networks
        - vpcs
        - subnets
        - security-groups
        - eips
        - load-balancers
        - volumes
        - snapshots
        - backups
        - sfs-shares
        - obs-bucket
        - cce-clusters
        - cce-nodes
        - rds-instances
        - cloud-eye-alarms
        - traces
        - log-groups
        - kms-keys
        - waf-policies
      amber:
        - create-or-update-compute
        - create-or-update-network
        - create-or-update-storage
        - database-or-container-change
        - iam-or-kms-change
      red:
        - delete-or-restore-resource
        - security-group-widening
        - waf-disable
        - key-disable-or-delete
        - production-database-mutation
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: open-telekom-cloud
---

# T Cloud Public

Use this skill for T Cloud Public, formerly Open Telekom Cloud, infrastructure
inventory, deployment-readiness checks, incident summaries, and guarded DevOps
request planning. The helper and credential names intentionally keep the
established `open-telekom-cloud` and `OTC_*` identifiers because the public API
docs, domains, and customer terminology still use OTC/Open Telekom Cloud names.

## Default Workflow

1. Start with read-only inventory or `plan`. V1 helper operations are
   read/list/describe only.
2. Treat `open_telekom_cloud.cjs` as the API wrapper. Do not handcraft OTC API
   URLs, service endpoints, signing metadata, request tiers, or SecretRefs from
   memory.
3. For prompt/user testing, stop after `plan` or helper `http-request` payload
   generation. Do not call helper `run` or the built-in `http_request` tool.
4. For real user requests that need live OTC data, use helper `run`. The helper
   constructs an allowlisted request and sends it through the HybridClaw gateway
   `http_request` route. The gateway resolves `OTC_ACCESS_KEY_ID`,
   `OTC_SECRET_ACCESS_KEY`, optional `OTC_SECURITY_TOKEN`, and
   `OTC_PROJECT_ID`, then signs the request server-side.
5. Use `http-request` only to inspect the generated gateway payload or when
   the active runtime cannot give the helper gateway access.
6. If a live helper `run` or `http_request` call returns 401, 403, or a
   signature/authentication failure, stop after that first failed call. Do not
   retry or fan out to more OTC endpoints. Ask the operator to verify
   credentials, project ID, region, IAM permissions, and clock skew.
7. If a live call returns 429, stop fan-out and report retry guidance from
   `Retry-After` or rate-limit response headers when present.
8. Mutating actions are outside v1 execution. For create/delete/reboot,
   network/security group, volume/backup restore, DNS/load-balancer, IAM/KMS,
   database, or container mutations, produce a plan with exact region, project,
   resource IDs, intended action, rollback, blast radius, and the required F8/F14
   operator approval text. Do not execute the mutation.
9. Never paste, print, inspect, or ask for OTC signing material, passwords, API
   tokens, AK/SK pairs, project IDs stored as secrets, or session tokens.

See [references/operator-setup.md](references/operator-setup.md) for operator
setup, credential scope, companion tooling, autonomy defaults, and rate-limit
handling.

## Command Contract

Run the helper:

```bash
node skills/open-telekom-cloud/open_telekom_cloud.cjs --help
```

Plan without contacting OTC:

```bash
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json plan \
  "deploy-check for eu-de production"
```

Build dry-run gateway payloads:

```bash
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json http-request regions
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json http-request service-endpoints --region eu-de
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json http-request service-status
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json http-request quotas --region eu-de
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json http-request servers --region eu-de --limit 50
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json http-request networks --region eu-de --limit 50
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json http-request volumes --region eu-de --limit 50
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json http-request cloud-eye-alarms --region eu-de --limit 50
```

Run live read requests through the gateway:

```bash
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json run servers --region eu-de --limit 50
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json run security-groups --region eu-de
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json run backups --region eu-de --limit 50
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json run rds-instances --region eu-de --limit 50
```

## Inventory Coverage

- ECS: servers, server details, flavors, quotas
- VPC/network: VPCs, subnets, security groups, EIPs, load balancers
- Storage: EVS volumes, EVS snapshots, Cloud Backup and Recovery backups,
  OBS bucket/object listings, SFS shares
- Containers and databases: CCE clusters/nodes and RDS instances
- Observability/audit: Cloud Eye alarms, Cloud Trace events, and Log Tank
  Service log groups
- Security/platform checks: IAM regions/projects, IAM service endpoints and
  service catalog, public status dashboard checks, KMS keys, WAF policies,
  regional endpoints, and service-status oriented readiness summaries

## Readiness Checks

For deployment or incident summaries, gather only the minimum inventory needed:

- region/project/auth readiness without exposing secrets
- quota pressure before deploys
- unhealthy ECS/RDS/CCE resources
- missing recent backups or snapshots
- public EIPs and security groups that expose admin ports
- missing or disabled Cloud Eye alarms
- recent Cloud Trace changes around the incident window

Summaries should be suitable for R29 cards and R32/R33 server-maintenance
handoff: include evidence, region, project, affected resource IDs, recommended
next action, and whether operator approval is needed.

## Guarded Operations

All write-like operations are amber/red and require exact F8/F14 approval before
any future write-capable helper may run:

- create/update/delete/reboot compute resources
- modify VPC, security group, EIP, load-balancer, or DNS state
- attach, detach, resize, delete, or restore storage resources
- mutate databases, containers, IAM, KMS, or WAF configuration

The approval text must include target region, project, service, resource IDs,
action, expected blast radius, rollback, and stop conditions. Stop immediately
on authentication failures.

## Companion Workflows

Terraform/OpenTofu, Ansible, Cloud Create, official SDKs, Gophercloud, and
`python-otcextensions` are valid companion workflows for operator-owned changes
and audits. This bundled skill owns its helper contract and should not shell out
to those tools by default.

## Validation

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/open-telekom-cloud
node skills/open-telekom-cloud/open_telekom_cloud.cjs --help
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json eval-scenarios
```
