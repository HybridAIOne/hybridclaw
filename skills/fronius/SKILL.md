---
name: fronius
description: "Read Fronius photovoltaic inverter data through the local Fronius Solar API V1 or Solar.web Query API cloud, without exposing access-key material."
user-invocable: true
requires:
  bins:
    - node
config_variables:
  - id: fronius-local-host
    env: FRONIUS_LOCAL_HOST
    required: false
    scope: "Local Fronius inverter base URL used in gateway http_request URLs"
    how_to_obtain: "Find the inverter LAN address in the router, Fronius app, or installer documentation and store it with `hybridclaw env set FRONIUS_LOCAL_HOST \"http://<fronius-ip>\"`."
credentials:
  - id: fronius-solarweb-access-key-id
    kind: api_key
    required: false
    secret_ref:
      source: store
      id: FRONIUS_SOLARWEB_ACCESS_KEY_ID
    scope: "Solar.web Query API AccessKeyId header"
    how_to_obtain: "Apply for Solar.web Query API access in Solar.web, create an API key, and store the key id with `hybridclaw secret set FRONIUS_SOLARWEB_ACCESS_KEY_ID \"<access-key-id>\"`."
  - id: fronius-solarweb-access-key-value
    kind: api_key
    required: false
    secret_ref:
      source: store
      id: FRONIUS_SOLARWEB_ACCESS_KEY_VALUE
    scope: "Solar.web Query API AccessKeyValue header"
    how_to_obtain: "Save the API key value when Solar.web shows it and store it with `hybridclaw secret set FRONIUS_SOLARWEB_ACCESS_KEY_VALUE \"<access-key-value>\"`."
metadata:
  hybridclaw:
    category: home-automation
    short_description: "Fronius local inverter and Solar.web monitoring reads."
    tags:
      - fronius
      - solar
      - photovoltaic
      - energy
      - monitoring
      - r21
    related_roadmap:
      - R21.111
      - R5
      - R29
    issue: 1114
    stakes_tiers:
      green:
        - local-api-version
        - local-health
        - local-inverter-info
        - local-inverter-realtime
        - local-power-flow
        - local-meter-realtime
        - local-storage-realtime
        - local-ohmpilot-realtime
        - local-archive
        - local-logger-info
        - local-active-device-info
        - cloud-pvsystems
        - cloud-auth-check
        - cloud-pvsystem
        - cloud-flowdata
        - cloud-aggrdata
        - cloud-histdata
        - cloud-messages
        - cloud-devices-list
        - cloud-errors
      amber: []
      red: []
    escalation:
      writes: unsupported
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: fronius
---

# Fronius

Use this skill for operator-approved Fronius photovoltaic monitoring: local
inverter reads through Fronius Solar API V1 and cloud reads through Solar.web
Query API. This v1 skill covers read-only monitoring for inverters, meters,
storage, OhmPilot, and Solar.web account data.

## Core Contract

- Run supported operations through `skills/fronius/fronius.cjs`; the helper is
  the source of truth for Fronius URLs, Solar.web headers, endpoint bounds, and
  response-shape metadata.
- For live API calls, run the helper to build the request, then pass the
  emitted `httpRequest` object unchanged to the built-in `http_request` tool.
- Use `local-health` through the helper and `http_request` for local
  reachability checks.
- The helper emits only allowlisted endpoint shapes. It rejects arbitrary path
  passthrough and command-line secret values.
- Treat the inverter LAN base URL as plain local configuration. Use
  `--local-host http://<fronius-ip>` when the operator provides it, or use the
  configured `FRONIUS_LOCAL_HOST` environment value.
- Solar.web Query API authentication uses `AccessKeyId` and `AccessKeyValue`
  HTTP headers per Fronius' interface documentation. The helper emits those as
  `secretHeaders` so the gateway injects them server-side.
- Treat the first 401 or 403 live response as final for that attempt. For 429,
  report the rate-limit condition and any retry-after guidance.
- Treat local host reachability, gateway host policy, and macOS Local Network
  permission as separate failure modes.

## Setup

Local inverter path:

```bash
hybridclaw env set FRONIUS_LOCAL_HOST "http://<fronius-ip>"
```

The inverter LAN URL is configuration, not credential material. It can also be
passed per request with `--local-host http://<fronius-ip>` or exported as
`FRONIUS_LOCAL_HOST`.

Solar.web cloud path:

```bash
hybridclaw secret set FRONIUS_SOLARWEB_ACCESS_KEY_ID "<access-key-id>"
hybridclaw secret set FRONIUS_SOLARWEB_ACCESS_KEY_VALUE "<access-key-value>"
```

Solar.web Query API access is requested from Solar.web. Create and store the
AccessKeyId and AccessKeyValue in HybridClaw secrets as soon as Solar.web shows
them. Solar.web Premium or a paid Query API package may be required for some
system, historical, and aggregate endpoints.

The cloud helper emits:

```json
{
  "secretHeaders": [
    { "name": "AccessKeyId", "secretName": "FRONIUS_SOLARWEB_ACCESS_KEY_ID", "prefix": "none" },
    { "name": "AccessKeyValue", "secretName": "FRONIUS_SOLARWEB_ACCESS_KEY_VALUE", "prefix": "none" }
  ]
}
```

The gateway injects the real access-key values server-side. Model-visible
helper output, prose, logs, and tests should contain only SecretRef names.

## Command Contract

Show helper usage:

```bash
node skills/fronius/fronius.cjs --help
```

Local reads:

```bash
node skills/fronius/fronius.cjs --format json http-request local-api-version
node skills/fronius/fronius.cjs --format json http-request local-health
node skills/fronius/fronius.cjs --format json http-request local-power-flow
node skills/fronius/fronius.cjs --format json http-request local-inverter-realtime --scope System
node skills/fronius/fronius.cjs --format json http-request local-meter-realtime --scope System
node skills/fronius/fronius.cjs --format json http-request local-storage-realtime --scope System
node skills/fronius/fronius.cjs --format json http-request local-ohmpilot-realtime --scope System
node skills/fronius/fronius.cjs --format json http-request local-archive \
  --start 2026-05-26 \
  --end 2026-05-27 \
  --channel EnergyReal_WAC_Sum_Produced
node skills/fronius/fronius.cjs --format json http-request local-logger-info
node skills/fronius/fronius.cjs --format json http-request local-active-device-info --device-class Inverter
```

Cloud reads:

```bash
node skills/fronius/fronius.cjs --format json http-request cloud-pvsystems
node skills/fronius/fronius.cjs --format json http-request cloud-auth-check
node skills/fronius/fronius.cjs --format json http-request cloud-pvsystem --pv-system <id>
node skills/fronius/fronius.cjs --format json http-request cloud-flowdata --pv-system <id>
node skills/fronius/fronius.cjs --format json http-request cloud-aggrdata \
  --pv-system <id> \
  --period day \
  --from 2026-05-26
node skills/fronius/fronius.cjs --format json http-request cloud-histdata \
  --pv-system <id> \
  --from 2026-05-20 \
  --to 2026-05-27 \
  --channel EnergyReal_WAC_Sum_Produced
node skills/fronius/fronius.cjs --format json http-request cloud-messages --pv-system <id> --since 2026-05-20
node skills/fronius/fronius.cjs --format json http-request cloud-devices-list --pv-system <id>
node skills/fronius/fronius.cjs --format json http-request cloud-errors --pv-system <id> --since 2026-05-20
```

Run one gateway-proxied smoke request:

```bash
node skills/fronius/fronius.cjs --live --format json http-request cloud-flowdata --pv-system <id>
```

## Health Checks

- `local-health` verifies local-host reachability by reading the local API
  version endpoint.
- `cloud-auth-check` verifies Solar.web key validity by reading the bounded PV
  systems list endpoint. A 401 or 403 from Solar.web means the upstream API
  rejected the injected key pair or the key lacks access. Gateway errors that
  name `FRONIUS_SOLARWEB_ACCESS_KEY_ID` or
  `FRONIUS_SOLARWEB_ACCESS_KEY_VALUE` indicate missing, unavailable, or blocked
  SecretRefs. A 429 means the account hit Solar.web rate limits.

## Error Interpretation

- For local DNS, connection refused, timeout, no route to host, or gateway
  network-policy denial, report the exact gateway/local failure and ask for the
  actual inverter host when no operator-supplied host is available.
- For helper errors naming `FRONIUS_LOCAL_HOST`, ask the operator for the
  inverter LAN base URL or a configured environment value.
- For gateway errors naming `FRONIUS_SOLARWEB_ACCESS_KEY_ID` or
  `FRONIUS_SOLARWEB_ACCESS_KEY_VALUE`, ask the operator to set or unblock that
  specific secret.
- For Solar.web 401 or 403, report that the configured Solar.web key pair was
  rejected or lacks access.
- When both local and cloud paths fail, give a concise status for each path and
  one next action for each.

## Result Handling

- Use `local-power-flow` or `cloud-flowdata` to summarize live production,
  consumption, grid exchange, battery power, and self-consumption ratio.
- For local live production, prefer `local-power-flow`; read current PV
  production from `Body.Data.Site.P_PV` in watts, current load from
  `Body.Data.Site.P_Load`, grid exchange from `Body.Data.Site.P_Grid`, and
  battery power from `Body.Data.Site.P_Akku` when present.
- For inverter-only live output, use `local-inverter-realtime --scope System`;
  read current AC inverter power from `Body.Data.PAC.Values` in watts and sum
  the device values when a plant total is needed. For a single device, use
  `local-inverter-realtime --scope Device --device-id <id> --data-collection
  CommonInverterData` and read `Body.Data.PAC.Value` in watts.
- Use `local-inverter-info` for inverter identity, status, serial/unique ID,
  and connected or rated PV capacity. Interpret `PVPower` from
  `GetInverterInfo.cgi` as connected/rated PV capacity in watts.
- Use `local-archive`, `cloud-aggrdata`, or `cloud-histdata` for R5 energy
  rollups. Helper output includes a `responseShape` describing stable rollup
  fields such as produced energy, consumed energy, period, and channel values.
- Use `cloud-messages` and `cloud-errors` for R29 incident-card summaries:
  inverter offline, battery fault, export curtailment, meter failure, or
  repeated communication errors.
- State whether each answer came from the local inverter or Solar.web cloud.
  When the operator explicitly asks for local LAN data, keep the answer scoped
  to the local path unless the operator asks for cloud fallback.

## Policy Notes

Local inverter access requires gateway host policy for the selected LAN host
and Fronius `/solar_api/` paths. Cloud access requires policy for
`api.solarweb.com`. Keep mutating endpoints out of scope for v1 even if an API
reference mentions installer-only or configuration surfaces.

References:
[Fronius Solar API V1](https://www.fronius.com/en/solar-energy/installers-partners/service-support/tech-support/api-documentation),
[Solar.web Query API](https://www.solarweb.com/swqapi/), and
[Solar.web Query API overview](https://www.fronius.com/en/solarweb-query-api).
