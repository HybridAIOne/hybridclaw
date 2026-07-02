---
name: byd-battery
description: "Read BYD Battery-Box HVS/HVM/LVS/LVL home-storage telemetry through local Modbus or paired-inverter delegation, with read-only safety boundaries."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: byd-bmu-host
    kind: header
    required: false
    secret_ref:
      source: store
      id: BYD_BMU_HOST
    scope: "LAN hostname or IP address of the BYD BMU Modbus endpoint"
    how_to_obtain: "Find the BMU LAN address from the router, inverter page, or Be Connect Plus notes. Set `BYD_BMU_HOST` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set BYD_BMU_HOST \"192.168.1.50\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set BYD_BMU_HOST \"192.168.1.50\"`."
  - id: byd-bmu-modbus-port
    kind: header
    required: false
    secret_ref:
      source: store
      id: BYD_BMU_MODBUS_PORT
    scope: "BYD BMU Modbus TCP port, usually 8080 or 502 depending on firmware and wiring"
    how_to_obtain: "Confirm the port in the installer documentation or LAN scan. Set `BYD_BMU_MODBUS_PORT` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set BYD_BMU_MODBUS_PORT \"8080\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set BYD_BMU_MODBUS_PORT \"8080\"`."
  - id: byd-bmu-unit-id
    kind: header
    required: false
    secret_ref:
      source: store
      id: BYD_BMU_UNIT_ID
    scope: "Pinned Modbus unit id for the BMU, usually 1"
    how_to_obtain: "Confirm the unit id from the installer handoff or Modbus adapter configuration. Set `BYD_BMU_UNIT_ID` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set BYD_BMU_UNIT_ID \"1\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set BYD_BMU_UNIT_ID \"1\"`."
  - id: byd-bmu-model
    kind: header
    required: false
    secret_ref:
      source: store
      id: BYD_BMU_MODEL
    scope: "Operator-declared Battery-Box model family such as Premium HVS, HVM, LVS, LVL, HV, or LV"
    how_to_obtain: "Read the battery nameplate or installer handoff. Set `BYD_BMU_MODEL` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set BYD_BMU_MODEL \"Premium HVS\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set BYD_BMU_MODEL \"Premium HVS\"`."
metadata:
  hybridclaw:
    category: home-automation
    short_description: "Read-only BYD Battery-Box telemetry and incident handoff."
    tags:
      - byd
      - battery
      - solar
      - energy
      - modbus
      - storage
    stakes_tiers:
      green:
        - state-of-charge
        - pack-telemetry
        - cell-extremes
        - inventory
        - module-telemetry
        - alarms
        - firmware
        - be-connect-metadata
        - energy-counters
      red:
        - remote-shutdown
        - bmu-reset
        - capacity-reconfiguration
        - cell-balancing-override
        - write-registers
        - write-coils
    escalation:
      writes: unavailable-v1
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: byd-battery
---

# BYD Battery

Use this skill for operator-approved monitoring of BYD Battery-Box Premium HVS,
HVM, LVS, LVL, and older HV/LV family home-storage units. Prefer the bundled
helper for all protocol details:

```bash
node skills/byd-battery/byd-battery.cjs --format json read state-of-charge
node skills/byd-battery/byd-battery.cjs --format json read pack-telemetry
node skills/byd-battery/byd-battery.cjs --format json read cell-extremes
node skills/byd-battery/byd-battery.cjs --format json read inventory
node skills/byd-battery/byd-battery.cjs --format json read module-telemetry
node skills/byd-battery/byd-battery.cjs --format json read alarms
node skills/byd-battery/byd-battery.cjs --format json read firmware
node skills/byd-battery/byd-battery.cjs --format json read be-connect-metadata
node skills/byd-battery/byd-battery.cjs --format json read energy-counters
node skills/byd-battery/byd-battery.cjs --format json read state-of-charge --via fronius
```

## Safety Boundary

**Read-only v1. Do not attempt mutating actions through this skill.** Remote
shutdown, BMU reset, capacity reconfiguration, installer-app operations,
cell-balancing overrides, write coils, and write-register requests are out of
scope because they can affect a high-voltage DC battery. If a future v2 adds
any mutating action, it must be red-stakes, require mandatory F8/F14 approval,
and include installer handover instructions.

Never ask for, print, or store installer-app passwords such as common default
installer codes in helper output. Treat them as SecretRef-managed even if they
are well known.

## Setup

Set local BMU connection values in this order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets` and set the
   `BYD_BMU_*` values.
2. Browser `/chat` or TUI fallback:
   `/secret set BYD_BMU_HOST "192.168.1.50"` plus the matching port, unit id,
   and model values.
3. Local console fallback:

```bash
hybridclaw secret set BYD_BMU_HOST "192.168.1.50"
hybridclaw secret set BYD_BMU_MODBUS_PORT "8080"
hybridclaw secret set BYD_BMU_UNIT_ID "1"
hybridclaw secret set BYD_BMU_MODEL "Premium HVS"
```

The helper uses the SecretRef names in metadata and output. It does not expose
the configured LAN host, port, unit id, model, or any installer secret in
normal results.

F3 host policy should allow only the BMU LAN host and Modbus port. BYD local
Modbus does not require internet endpoints by default.

## Operation Rules

- Use `read state-of-charge` for current SoC, SoH, power direction, and summary
  incident hints.
- Use `read pack-telemetry` for pack/output voltage, current, power, and pack
  temperature.
- Use `read cell-extremes` for max/min cell voltage, voltage spread, and
  max/min temperature.
- Use `read inventory` and `read firmware` for service handoff: serial, model
  family, tower/module topology, BMU/BMS firmware, hardware revision when
  present in the BMU block, inverter family, and grid mode.
- Use `read module-telemetry` for per-module voltage and temperature summaries
  decoded from the read-only diagnostic `0x0558` pages. Larger systems may
  require multiple sampled pages; the helper reads only the allowlisted
  diagnostic holding-register range and never starts measurement with a write.
- Use `read be-connect-metadata` for the read-only commissioning and firmware
  metadata that can be recovered from local BMU registers. It intentionally
  does not log in to Be Connect Plus or handle installer passwords.
- Use `read alarms` to decode the alarm bitmap into human-readable codes and
  R29 incident-card payloads.
- Use `read energy-counters` to emit shape-stable R5 charge/discharge kWh
  rollup fields.
- If local Modbus is not configured but the battery is paired to Fronius, use
  `--via fronius`. The helper delegates to R21.111 Fronius
  `local-power-flow` / `local-storage-realtime` surfaces instead of inventing a
  BYD cloud path. This checkout does not currently bundle a Fronius helper
  path; treat the emitted delegation payload as a handoff to the R21.111 skill
  once that skill is present.
- Stop after the first Modbus connect, timeout, exception, or comms-lost
  failure. The helper emits an R29 `bmu-comms-lost` incident-card payload; do
  not retry-loop against the BMU.
- Be Connect Plus has no public API contract. For v1, use
  `read be-connect-metadata`, `read firmware`, and `read inventory` for
  read-only commissioning metadata available from local BMU registers; do not
  automate installer-app login or password flows.

## Register Boundary

The helper exposes only allowlisted read-holding-register ranges derived from
the community BYD Battery-Box Premium Modbus maps:

- `0x0000:0x0066` BMU identity, firmware, topology, inverter/grid mode.
- `0x0500:0x0019` live SoC, SoH, pack voltage/current, alarms, energy counters.
- `0x0010:0x0003` BMS parameter snapshot.
- `0x0558:0x0041` tower/module diagnostic block.

No arbitrary register passthrough exists. No write function codes are exposed.

## References

- [BYD Battery-Box downloads](https://www.bydbatterybox.com/downloads)
- [ioBroker.bydhvs community Modbus decode](https://github.com/christianh17/ioBroker.bydhvs)
- [SmartHomeNG `byd_bat` plugin](https://github.com/smarthomeNG/plugins/tree/master/byd_bat)
- [Home Assistant BYD HVS integration](https://github.com/Romelium/home-assistant-byd-hvs)
