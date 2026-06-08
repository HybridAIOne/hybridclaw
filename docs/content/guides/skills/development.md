---
title: Development Skills
description: Code review, GitHub issue automation, PR workflows, Salesforce inspection, Hetzner DevOps, smart-home monitoring, and skill creation tools.
sidebar_position: 3
---

# Development Skills

## code-review

Review diffs and change sets for bugs, regressions, risks, and missing tests.

**Prerequisites** — `git`, optionally `gh` (GitHub CLI) for PR reviews.

> 💡 **Tips & Tricks**
>
> The skill reviews by severity: incorrect logic, auth/secret mistakes, missing validation, risky coupling, flaky tests.
>
> It searches for leftover `console.log`, `TODO`, `FIXME`, passwords, and tokens automatically.
>
> For GitHub PRs, it uses `gh pr view` and checks CI status.

> 🎯 **Try it yourself**
>
> `Review the diff on my current branch for bugs and security issues`
>
> `Review PR #42 and list findings by severity`
>
> `Look at the changes in src/auth/ and flag anything risky`
>
> `Review the diff on my current branch, run the test suite to check for regressions, and create a summary of all findings sorted by severity with file and line references`
>
> **Conversation flow:**
>
> `1. Review the diff on my current branch and list all findings by severity`
> `2. The auth token validation issue you flagged — show me the exact code path and suggest a fix`
> `3. Apply the fix, re-run the tests, and confirm the issue is resolved`

**Troubleshooting**

- **`gh` not authenticated** — run `gh auth login` before PR reviews.
- **Large diffs** — the skill reads changed files individually; very large
  PRs may take longer.

---

## github-pr-workflow

Create branches, commit and push changes, open or update GitHub pull requests,
handle CI, and merge safely.

**Prerequisites** — `git`, `gh` (GitHub CLI, authenticated).

> 💡 **Tips & Tricks**
>
> The skill follows a fixed sequence: sync base, branch, implement, commit, push, open PR, watch CI, address feedback, merge.
>
> Prefer small, focused PRs. If stacking PRs, make the dependency explicit.
>
> Use `gh pr checks --watch` to wait for CI to finish.

> 🎯 **Try it yourself**
>
> `Create a branch called "fix/null-check-user", find any functions that access user properties without null checks, add guards, and open a PR against main`
>
> `Push my current changes and open a draft PR with a summary`
>
> `Check CI status on my open PR and fix any failures`
>
> `Address the review comments on PR #55 and push an update`
>
> `Create a branch called "feat/add-healthcheck", add a /healthz endpoint that returns status and uptime, write a test for it, commit with a descriptive message, push, and open a PR against main with a full summary`
>
> **Conversation flow:**
>
> `1. Create a branch called "feat/rate-limiter" and add a middleware that limits requests to 100/min per IP`
> `2. Write unit tests for the rate limiter covering normal traffic, burst traffic, and IP reset after the window expires`
> `3. Push everything, open a PR against main, and watch CI until it passes`

**Troubleshooting**

- **Push rejected** — likely need to `git pull --rebase` first.
- **CI fails** — the skill will attempt to read failure logs and fix locally
  before re-pushing.

---

## gh-issues

Process GitHub issues as an automation queue: list and filter issues, confirm
selected issue numbers, deduplicate `fix/issue-*` work, delegate one focused PR
per issue, and monitor review feedback on issue-fix PRs.

**Prerequisites** — `git` for processing selected issues. `gh` is preferred for
GitHub access, but the skill can fall back to the GitHub REST API with
stored secret `GH_TOKEN` when `gh` is unavailable.

> 💡 **Tips & Tricks**
>
> Every issue table comes from a live GitHub fetch in the current turn. The
> skill must not reuse issue lists from memory, transcripts, or earlier prompts.
>
> Use `--dry-run` first to inspect the issue set without creating branches or
> delegations.
>
> Add `--label`, `--milestone`, `--assignee`, and `--limit` filters to keep
> each batch focused.
>
> Use `--reviews-only` to address actionable comments on open `fix/issue-*`
> PRs.
>
> Use `--fork owner/repo` when branches should be pushed to a fork while PRs
> target the source repo.
>
> Use `--watch --interval 15` for recurring queue follow-up. HybridClaw
> fetches the first issue list normally, then schedules the next run instead of
> sleeping in the current turn.
>
> Use `--cron --yes` for scheduled runs that process at most one eligible item
> and exit.
>
> Use `--notify-channel <target>` to send the final PR summary to a HybridClaw
> message target without sending intermediate status chatter.

> 🎯 **Try it yourself**
>
> `/gh-issues <your repo> --label bug --limit 3 --dry-run`
>
> `/gh-issues <your repo> --label bug --limit 2`
>
> `/gh-issues <your repo> --reviews-only`
>
> `/gh-issues <your repo> --fork <your fork> --label help-wanted --limit 1`
>
> `/gh-issues <your repo> --watch --interval 15 --label bug --limit 5`
>
> `/gh-issues <your repo> --cron --yes --reviews-only`
>
> **Conversation flow:**
>
> `1. /gh-issues <your repo> --label bug --limit 5 --dry-run`
> `2. Process issues 42 and 48 only`
> `3. After the PRs are open, run /gh-issues <your repo> --reviews-only`

> **QA prompts**
>
> `/gh-issues <your repo>`
>
> Lists the latest open issues from GitHub and asks which issue numbers to
> process. If `<your repo>` is explicit, the skill must not probe the local git
> checkout before listing issues.
>
> `/gh-issues <your repo> --label bug --limit 5 --dry-run`
>
> Fetches live matching issues and stops after the table or "no matches"
> response. It must not run processing preflight or delegate work.
>
> `/gh-issues <your repo> --label bug --limit 2`
>
> Fetches live bug issues, displays whatever currently matches, and asks which
> issues to process. It is valid for the result count to be lower than the
> limit; the important checks are that a current-turn GitHub fetch happened and
> preflight waits for selection.
>
> `/gh-issues <your repo> --label enhancement --limit 3`
>
> Fetches live enhancement issues and asks for `all`, comma-separated issue
> numbers, or `cancel`. Git preflight happens only after a selection.
>
> `/gh-issues <your repo> --watch --interval 15 --label bug --limit 5`
>
> Fetches the first issue list normally and asks for selection, then uses
> HybridClaw scheduling for future `--cron --yes` follow-ups. It must not send a
> local message as a substitute for scheduling.
>
> `/gh-issues <your repo> --reviews-only --yes`
>
> Skips issue listing, finds open `fix/issue-*` PRs, gathers review sources, and
> delegates only actionable review feedback.

**Troubleshooting**

- **`gh` missing or not authenticated** — install and authenticate `gh`, or
  store `GH_TOKEN` with `/secret set GH_TOKEN <token>` so the skill can call the
  GitHub REST API through `http_request` with `bearerSecretName: "GH_TOKEN"`.
  The skill should not use shell environment tokens or authenticated `curl`.
- **Existing branch or PR** — the skill skips issues that already have a
  `fix/issue-*` branch or open PR.
- **Local checkout missing** — issue listing can run with only `owner/repo`,
  but processing selected issues needs a matching local git checkout.
- **Unclear issue** — delegated agents stop and report low confidence instead
  of opening speculative PRs.
- **Wrong workflow** — use `github-pr-workflow` for current-branch PR work, CI
  fixes, or a known PR; use `gh-issues` when the entry point is an issue queue.
- **Feature parity note** — HybridClaw supports the OpenClaw issue queue flow
  (filters, confirmation, fork mode, dedupe, claims/cursor state, cron/watch,
  notifications, and review handling) with HybridClaw-native tools instead of
  OpenClaw config paths or `sessions_spawn`.

---

## salesforce

Inspect Salesforce objects, fields, relationships, Tooling API metadata, and
SOQL rows with a bundled Python helper. Read-only by default.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `python3` | Required runtime | System install |
| Salesforce credentials | Stored secrets: `SF_FULL_USERNAME`, `SF_FULL_PASSWORD`, `SF_FULL_CLIENTID`, `SF_FULL_SECRET`, `SF_DOMAIN` | Configure via HybridClaw secrets |

> 💡 **Tips & Tricks**
>
> Always run `objects` or `describe` before writing SOQL against unfamiliar objects.
>
> Use `relations` to discover join paths between objects.
>
> Add `LIMIT` to queries on large tables to avoid timeouts.
>
> The helper uses `<secret:NAME>` placeholders resolved server-side — secrets never touch disk.

> 🎯 **Try it yourself**
>
> `List all Salesforce objects that contain "Account" in the name`
>
> `Describe the fields on the Opportunity object`
>
> `Query the 10 most recent Contacts with their Account names`
>
> `Show me the relationships between Case and Account`
>
> `Describe the Contact object, find all required fields, then query the 5 most recently created Contacts and show which required fields are empty`
>
> **Conversation flow:**
>
> `1. List all custom objects in our Salesforce org that were created in the last 6 months`
> `2. Describe the fields on the newest custom object and show its relationships to Account and Contact`
> `3. Query the 10 most recent records from that object and flag any with missing required fields`

**Troubleshooting**

- **Authentication errors** — verify all five stored secrets are set and
  `SF_DOMAIN` is `login` (production) or `test` (sandbox).
- **SOQL query fails** — check field API names with `describe` first; display
  labels differ from API names.

---

## hetzner-devops

Operate Hetzner infrastructure with three bundled skills:

- `hetzner-cloud` — VPS inventory, server types, locations, prices, provisioning, volumes, snapshots, restores, and guarded deletes.
- `hetzner-dns` — DNS zones and records, including guarded A, AAAA, CNAME, TXT, add/remove/update/delete flows.
- `hetzner-storage-box` — Storage Box inventory, snapshots, WebDAV file list/download/upload/archive flows, and public URL preparation.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `node` | Required helper runtime | System install |
| Hetzner Cloud/API token | Stored secret: `HETZNER_API_TOKEN` for Cloud and Storage Box management | `hybridclaw secret set HETZNER_API_TOKEN "<token>"` |
| Hetzner DNS API token | Stored secret: `HETZNER_DNS_API_TOKEN` for DNS API `Auth-API-Token` injection | `hybridclaw secret set HETZNER_DNS_API_TOKEN "<token>"` |
| Storage Box WebDAV auth | Optional stored secret for file operations: `HETZNER_STORAGE_BOX_BASIC_AUTH` | Store base64 `username:password` payload |

`HETZNER_API_TOKEN` is intentionally limited to Hetzner Console APIs. DNS and
WebDAV use separate secrets because Hetzner exposes those surfaces through
different auth contracts; HybridClaw still injects every secret server-side, so
the model never sees raw tokens or passwords.

Per-skill operator setup references:

- [Hetzner Cloud operator setup](../../../../skills/hetzner-cloud/references/operator-setup.md)
- [Hetzner DNS operator setup](../../../../skills/hetzner-dns/references/operator-setup.md)
- [Hetzner Storage Box operator setup](../../../../skills/hetzner-storage-box/references/operator-setup.md)

> 💡 **Tips & Tricks**
>
> Use read-only Hetzner API tokens for inventory and cost reporting.
>
> Discover DNS record ids before updates and deletes; the DNS API is record-id based.
>
> Use Storage Box subaccounts scoped to the archive path for WebDAV writes.
>
> All helpers emit gateway-backed `http_request` payloads; secrets are injected server-side and are never printed.
>
> Treat the CJS helpers as the API wrappers: they choose endpoints, methods, payloads, tiers, URL encoding, and secret refs. For prompt/user testing, stop after `plan` or helper payload generation. For real user requests that need live Hetzner data, pass the emitted `httpRequest` object unchanged to live `http_request` and let the gateway resolve `bearerSecretName` or `secretHeaders`. If one live call returns 401 or 403, stop immediately and ask the operator to verify the secret; do not retry or continue across more Hetzner endpoints.

> 🎯 **Try it yourself**
>
> `List all Hetzner Cloud servers with label project=acme and estimate their current monthly cost`
>
> `Create a plan for a demo VPS in Falkenstein with a TTL label, but do not provision it yet`
>
> `Point demo-acme.example.com to this server IP in Hetzner DNS`
>
> `Snapshot the production server before deploy and show me the exact rollback request`
>
> `Archive this Q4 invoice manifest to the Storage Box and prepare the public URL`
>
> **Conversation flow:**
>
> `1. List Hetzner servers and DNS zones for project acme`
> `2. Plan a demo VPS and DNS record for Friday's customer demo`
> `3. After I approve, build the create-server and create-rrset requests`
> `4. On Monday, tear down the demo server and delete the temporary DNS record`

**Troubleshooting**

- **Token rejected** — verify the Cloud/Storage Box token belongs to the Hetzner Console project, or that the DNS token was created in the DNS Console.
- **Write refused** — rerun the helper after an exact operator grant and include `--operator-grant`.
- **WebDAV auth fails** — verify the Storage Box host, subaccount permissions, and `HETZNER_STORAGE_BOX_BASIC_AUTH` encoded payload.

---

## t-cloud-public

Inspect T Cloud Public, formerly Open Telekom Cloud, infrastructure and prepare
guarded DevOps operations through gateway-managed OTC API signing.

**Prerequisites** — an OTC IAM user with least-privilege access keys and the
target regional project id.

```bash
hybridclaw secret set OTC_ACCESS_KEY_ID "<access-key-id>"
hybridclaw secret set OTC_SECRET_ACCESS_KEY "<secret-access-key>"
hybridclaw secret set OTC_PROJECT_ID "<regional-project-id>"
```

Optional Enterprise Dashboard consumption and spend reads need:

```bash
hybridclaw secret set OTC_ENTERPRISE_DASHBOARD_TOKEN "<dashboard-api-key>"
```

> 💡 **Tips & Tricks**
>
> Start with `regions`, `projects`, `service-endpoints`, `quotas`, and
> read-only inventory commands before planning changes.
>
> The helper signs OTC requests and emits gateway-ready requests; do not build
> signed headers or canonical request strings by hand.
>
> Mutating compute, network, storage, IAM, KMS, database, and WAF operations
> are amber or red and require exact operator approval.

> 🎯 **Try it yourself**
>
> `List T Cloud Public servers, networks, volumes, and current quotas for my project`
>
> `Check Cloud Eye alarms and recent Cloud Trace events for the production project`
>
> `Show daily T Cloud Public consumption for this month`

**Troubleshooting**

- **Signature or auth errors** — verify the access key id, secret key, project
  id, region, and system clock.
- **403 on inventory reads** — grant the IAM user read scopes for the target
  services and project.
- **Dashboard billing errors** — store `OTC_ENTERPRISE_DASHBOARD_TOKEN` and
  confirm the key has Admin security level in the Enterprise Dashboard.

---

## mittwald

Read mittwald mStudio and Kundencenter resources: projects, apps, runtimes,
databases, domains, mail, backups, files, containers, and access users.

**Prerequisites** — a mittwald API token stored in HybridClaw secrets.

```bash
hybridclaw secret set MITTWALD_API_TOKEN "<api-token>"
```

Create the token in mittwald mStudio under user profile API token settings.
Use the narrowest token role that can read the projects you want HybridClaw to
inspect.

> 💡 **Tips & Tricks**
>
> Use read-only commands such as `whoami`, `projects`, `apps`, `domains`,
> `databases`, `backups`, and `service-logs` for triage.
>
> The helper injects `MITTWALD_API_TOKEN` server-side with
> `bearerSecretName`; never paste the token into chat or raw headers.
>
> App installation, database creation, cronjob creation, domain moves, and
> delivery-box creation require explicit operator approval. Restore, service
> action, domain deletion, and extension-order operations are red-tier.

> 🎯 **Try it yourself**
>
> `List mittwald projects and summarize apps, domains, databases, and backups`
>
> `Check the latest service logs for this mittwald app`
>
> `Plan a Redis database creation for this project without executing it`

**Troubleshooting**

- **401 or 403** — verify the token is active and has access to the selected
  mStudio project.
- **429** — respect the returned rate-limit headers; do not retry in a loop.
- **Missing resource ids** — list the parent project/app/domain first and pass
  the exact id from the helper output.

---

## zabbix

Read Zabbix monitoring state for incident triage: API health, host inventory,
current or recent problems, trigger severity summaries, and incident context.

**Prerequisites** — a Zabbix API token and the frontend base URL.

```bash
hybridclaw secret set ZABBIX_API_TOKEN "<zabbix-api-token>"
```

Pass the base URL per request or configure it in the runtime environment as
`ZABBIX_BASE_URL`. The helper accepts both the frontend URL and the
`api_jsonrpc.php` endpoint URL.

> 💡 **Tips & Tricks**
>
> Start with `api-version`, then inspect `hosts`, `problems`, and
> `triggers` before creating an incident summary.
>
> This v1 skill is read-only; acknowledge, suppress, close, update, or delete
> operations are intentionally not executed.
>
> Use Zabbix for detection and context, then hand off remediation to a
> maintenance skill or operator.

> 🎯 **Try it yourself**
>
> `Show current high-severity Zabbix problems and affected hosts`
>
> `Summarize recent Zabbix problems for the database host group`
>
> `Build an incident summary from Zabbix triggers for the last 24 hours`

**Troubleshooting**

- **Base URL rejected** — use HTTPS unless the endpoint is explicitly local or
  private and the operator accepts `--allow-http`.
- **Auth errors** — verify the token and that the API endpoint path resolves.
- **Too much data** — narrow by host group, severity, time window, or monitored
  hosts only.

---

## shelly

Inspect and control Shelly relays, plugs, lights, covers, shutters, sensors,
and energy devices through local Gen1/Gen2 HTTP/RPC APIs or Shelly Cloud.

**Prerequisites** — local device URLs for LAN mode. Optional Shelly Cloud
credentials enable cloud state and event workflows:

```bash
hybridclaw secret set SHELLY_CLOUD_AUTH_KEY "<cloud-auth-key>"
hybridclaw secret set SHELLY_CLOUD_ACCESS_TOKEN "<cloud-access-token>"
```

Generate the cloud auth key in Shelly Smart Control user settings. Use the
documented Shelly OAuth flow for the Real Time Events API access token.

> 💡 **Tips & Tricks**
>
> Read `device info`, `device status`, or `cover status` before any control
> command.
>
> Relay, switch, light, and cover operations are amber-tier. Build an
> approval plan first and run the exact approved helper command only after the
> operator confirms.
>
> Factory reset, reboot, firmware update, Wi-Fi reset, auth changes, and
> certificate upload are not supported through this skill.

> 🎯 **Try it yourself**
>
> `Read status from the Shelly device at http://192.0.2.10`
>
> `Show cover position and config for this Shelly shutter`
>
> `Prepare an approval plan to move the office shutter to 50 percent`

**Troubleshooting**

- **LAN device unreachable** — verify the gateway process can reach the local
  IP and that workspace policy allows the host.
- **Cloud auth fails** — refresh `SHELLY_CLOUD_AUTH_KEY` or
  `SHELLY_CLOUD_ACCESS_TOKEN`.
- **Control refused** — rerun the generated approval plan and include the
  exact operator grant from a later confirmation.

---

## homematic

Inspect Homematic IP Home Control Unit state and prepare guarded smart-home
control messages through the HCU Connect API.

**Prerequisites** — an HCU with developer mode enabled, local network
reachability to the HCU, and Connect API credentials stored in HybridClaw
secrets.

```bash
hybridclaw secret set HOMEMATIC_HCU_ACTIVATION_KEY "<activation-key>"
hybridclaw secret set HOMEMATIC_HCU_AUTH_TOKEN "<auth-token>"
```

Use the activation key only long enough to enroll a Connect API token, then
prefer the stored `HOMEMATIC_HCU_AUTH_TOKEN` for normal read and control
planning flows.

> 💡 **Tips & Tricks**
>
> Start with `plugin-ready`, `get-state`, or `get-system-state` before planning controls.
>
> The helper emits WebSocket connection headers and message payloads with SecretRef placeholders; do not paste HCU tokens into chat or command arguments.
>
> Switch, thermostat, shutter, and scene controls are approval-gated. Safety alarm acknowledgement is red-tier.

> 🎯 **Try it yourself**
>
> `Summarize the current Homematic HCU state from this fixture`
>
> `Prepare a read-only get-state message for my HCU at https://hcu1-1234.local`
>
> `Build an approval plan to set the hallway thermostat group to 20.5 degrees`
>
> `Plan a shutter move to 25 percent for this device without executing it`

**Troubleshooting**

- **HCU URL rejected** — use the local HCUweb hostname such as
  `https://hcu1-1234.local` or the HCU IP address when mDNS is unavailable.
- **Token missing** — store `HOMEMATIC_HCU_AUTH_TOKEN`; do not pass it as a
  CLI argument.
- **Local connection fails** — verify gateway network policy, macOS Local
  Network permission, and HCU WebSocket exposure separately.

---

## blink

Read Blink camera and video-doorbell state, inspect motion clips, download
media artifacts, and prepare guarded privacy-control requests through
gateway-managed Blink API calls.

**Prerequisites** — a Blink account email and password stored as runtime
secrets. The helper captures OAuth session tokens after login.

In chat:

```text
/secret set BLINK_EMAIL "<account email>"
/secret set BLINK_PASSWORD "<account password>"
node skills/blink/blink.cjs --format json run account-login
```

From a local terminal:

```bash
hybridclaw secret set BLINK_EMAIL "<account email>"
hybridclaw secret set BLINK_PASSWORD "<account password>"
node skills/blink/blink.cjs --format json run account-login
```

If Blink asks for an email or SMS PIN, provide the PIN through the operator
handover flow and rerun `account-login` with `--pin <code>`. Successful login
captures `BLINK_AUTH_TOKEN`, `BLINK_REFRESH_TOKEN`, `BLINK_TIER`,
`BLINK_ACCOUNT_ID`, and `BLINK_CLIENT_ID` into the secret store.

> 💡 **Tips & Tricks**
>
> Start with `devices-list`, then narrow to networks, cameras, doorbells,
> motion events, clips, or thumbnails.
>
> Clip and thumbnail downloads go through the gateway artifact path so raw
> media bytes do not enter model context.
>
> Network arm/disarm, camera motion toggles, thumbnail refreshes, watched
> state changes, deletion, and live view are privacy-sensitive and require
> explicit approval.

> 🎯 **Try it yourself**
>
> `List my Blink networks, cameras, and doorbells`
>
> `Summarize Blink motion events since this morning`
>
> `Download the latest Blink thumbnail as an artifact`
>
> `Prepare an approval plan to arm this Blink network`

**Troubleshooting**

- **Verification required** — stop and complete the PIN handover before retrying.
- **Invalid credentials or app update required** — stop after the helper error;
  do not probe alternate Blink endpoints.
- **Media download fails** — verify the helper emitted a gateway artifact
  request and suppressed the response body.

---

## hue

Inspect and control Philips Hue Bridge lighting installations through the
local CLIP v2 API, with optional Hue Remote API support for off-LAN reads.

**Prerequisites** — a local bridge HTTPS URL stored as runtime env and a Hue
application key captured after pressing the physical bridge link button.

In chat:

```text
/env set HUE_BRIDGE_HOST "https://<bridge-ip>"
node skills/hue/hue.cjs --format json bridge status
node skills/hue/hue.cjs --format json bridge link --app-name hybridclaw --instance-name lab
```

From a local terminal:

```bash
hybridclaw env set HUE_BRIDGE_HOST "https://<bridge-ip>"
node skills/hue/hue.cjs --format json bridge status
node skills/hue/hue.cjs --format json bridge link --app-name hybridclaw --instance-name lab
```

Send the emitted `httpRequest` through the gateway while the bridge link
button is active. The emitted `captureResponseFields` rule stores the returned
credential as `HUE_APPLICATION_KEY`; do not paste the application key into
chat.

> 💡 **Tips & Tricks**
>
> Read current bridge, light, room, zone, and scene state before planning any
> lighting changes.
>
> Local bridge reads are green. Light, group, room, scene, behavior, and remote
> API operations are approval-gated; bridge configuration changes are red-tier.
>
> The helper adds scoped self-signed TLS handling for local bridge HTTPS. Do
> not replace it with broad insecure TLS settings.

> 🎯 **Try it yourself**
>
> `List my Hue rooms, lights, and scenes`
>
> `Show motion and temperature sensor readings from my Hue bridge`
>
> `Prepare an approval plan to dim the office lights to 60 percent`
>
> `Prepare an approval plan to recall this Hue scene`

**Troubleshooting**

- **Application key missing** — press the bridge link button and run the
  `bridge status` then `bridge link` setup sequence again.
- **Gateway policy denial** — verify workspace LAN HTTP policy before adding a
  duplicate bridge-specific rule.
- **Certificate verification fails** — rebuild the request with the Hue helper
  so `allowSelfSignedTls` is present.

---

## fronius

Read Fronius photovoltaic inverter and Solar.web monitoring data without
exposing local host configuration or Solar.web access-key material.

**Prerequisites** — a local inverter host for LAN reads, or Solar.web Query API
access keys for cloud reads.

```bash
hybridclaw env set FRONIUS_LOCAL_HOST "http://<fronius-ip>"
hybridclaw secret set FRONIUS_SOLARWEB_ACCESS_KEY_ID "<access-key-id>"
hybridclaw secret set FRONIUS_SOLARWEB_ACCESS_KEY_VALUE "<access-key-value>"
```

`FRONIUS_LOCAL_HOST` is plaintext configuration because it is a local hostname
or IP address. Solar.web access keys stay in encrypted secrets and are injected
server-side as request headers.

> 💡 **Tips & Tricks**
>
> Use `local-summary` or `local-power-flow` for live production, load, grid, and battery status.
>
> Use `cloud-pvsystems`, `cloud-flowdata`, `cloud-aggrdata`, and `cloud-histdata` for Solar.web inventory and energy rollups.
>
> State whether an answer came from local inverter data or Solar.web cloud data.

> 🎯 **Try it yourself**
>
> `Show current Fronius local production, load, grid exchange, and battery state`
>
> `Check whether my Solar.web credentials can list PV systems`
>
> `Summarize produced energy for this PV system yesterday`
>
> `List recent Fronius cloud error messages and turn them into an incident summary`

**Troubleshooting**

- **Local host missing** — set `FRONIUS_LOCAL_HOST` or pass the inverter base
  URL for the request.
- **Solar.web 401 or 403** — verify both access-key secrets and the Solar.web
  Query API package attached to the account.
- **Gateway policy denial** — allow the selected local inverter host or
  `api.solarweb.com` before running live requests.

---

## warehouse-sql

Review and run read-only natural-language SQL against a customer data
warehouse with cached schema introspection. SQLite execution is bundled for the
reproducible TPC-H-style eval suite; Postgres, ClickHouse, BigQuery, and
Snowflake can run through optional Python drivers or operator-approved
connector commands.

The bundled eval fixture is a tiny deterministic TPC-H-style dataset for
offline SQL-generation coverage, not a TPC-H benchmark run.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `python3` | Required runtime and SQLite eval execution | System install |
| Warehouse connector | Production execution through the approved Python driver or connector command | Operator configured |

> 💡 **Tips & Tricks**
>
> Start with `schema --refresh` so generated SQL can be checked against cached
> tables, columns, and keys.
>
> Use `review` before `query --execute`; the helper blocks mutating SQL unless
> an explicit per-skill write grant is provided.
>
> Pass `--model-review --question "<business question>"` when the helper should
> invoke HybridClaw's OpenAI-compatible gateway for business-meaning review.
>
> Run `schedule-refresh` to register recurring schema-cache refreshes with the
> HybridClaw gateway scheduler.

> 🎯 **Try it yourself**
>
> `Draft and review SQL for the top customers by revenue`
>
> `Review this query before running it: SELECT c_name FROM customer LIMIT 10`
>
> `Refresh the schema cache for the analytics warehouse`
>
> `Run the TPC-H-style warehouse SQL eval scenarios`

**Troubleshooting**

- **SQL review fails** — revise the generated SQL, refresh the schema cache,
  and pass the revised query through `review` before execution.
- **Production backend does not execute** — install the relevant Python driver
  or set `HYBRIDCLAW_WAREHOUSE_SQL_<BACKEND>_COMMAND` to a connector command
  that reads SQL on stdin and emits JSON or CSV rows.
- **Write blocked** — mutating SQL requires `--allow-write`, `--write-grant`,
  and a matching `HYBRIDCLAW_WAREHOUSE_SQL_WRITE_GRANT` set by the operator.

---

## skill-creator

Create and update `SKILL.md`-based skills with strong trigger metadata, lean
docs, and reliable init/validate/package/publish workflows.

**Prerequisites** — none.

> 💡 **Tips & Tricks**
>
> Follow the three-layer model: frontmatter (triggers + metadata), SKILL.md body (core workflow), references/scripts/assets (detail).
>
> Keep SKILL.md concise — the model already knows general concepts; only include what is unique to your skill.
>
> For API-backed skills, provide a `*.cjs` CLI wrapper that owns endpoints,
> payloads, tiers, and secret refs. Prefer a `run` subcommand for live gateway
> execution, and keep `http-request` as the dry-run path that emits
> gateway-ready JSON the model can inspect or pass through unchanged.
>
> If a request shape is safety-critical, include generic
> `skillRequestContract` metadata in the emitted request instead of adding
> provider-specific checks to gateway or container core.
>
> Use `quick_validate.py` to check your skill before publishing.

> 🎯 **Try it yourself**
>
> `Create a new skill called "brand-voice" that enforces our writing style guide with rules: active voice, no jargon, sentences under 25 words`
>
> `Scaffold a new skill called "seo-audit" that triggers on SEO review requests, then validate its frontmatter and structure`
>
> `Scaffold a new skill called "changelog-writer", add a brew dependency for git, write the SKILL.md with trigger rules for changelog generation requests, and validate the result`
>
> **Conversation flow:**
>
> `1. Create a new skill called "deploy-checklist" that triggers on deploy or release requests`
> `2. Add a pre-deploy validation script that checks for uncommitted changes, passing tests, and a valid changelog entry`
> `3. Validate the skill structure and run a dry-run to make sure the trigger rules match correctly`

---

## code-simplification

*(Model-invoked, not user-invocable)*

Refactors code to reduce complexity and duplication without changing behavior.
Activated automatically during code-review and refactoring workflows. Moves
include: nested ifs to early returns, extract helpers, inline dead wrappers,
split data gathering from side effects.
