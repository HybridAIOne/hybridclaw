#!/usr/bin/env node
'use strict';

const net = require('node:net');

const SKILL_NAME = 'byd-battery';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MODBUS_PORT = 8080;
const DEFAULT_UNIT_ID = 1;
const DIAGNOSTIC_PAGE_READ_COUNT = 4;

const SECRET_REFS = {
  host: 'BYD_BMU_HOST',
  port: 'BYD_BMU_MODBUS_PORT',
  unitId: 'BYD_BMU_UNIT_ID',
  model: 'BYD_BMU_MODEL',
};

const READ_RANGES = {
  system: {
    start: 0x0000,
    quantity: 0x0066,
    label: 'BMU system identity, firmware, topology, inverter mode',
  },
  state: {
    start: 0x0500,
    quantity: 0x0019,
    label: 'BMU live SoC, SoH, voltage/current, alarms, energy counters',
  },
  bmsParameters: {
    start: 0x0010,
    quantity: 0x0003,
    label: 'BMS parameter snapshot',
  },
  diagnosticBlock: {
    start: 0x0558,
    quantity: 0x0041,
    label: 'Tower/module diagnostic cell data block',
  },
};

const OPERATION_RANGES = {
  'state-of-charge': ['state'],
  'pack-telemetry': ['state'],
  'cell-extremes': ['state', 'diagnosticBlock'],
  inventory: ['system', 'bmsParameters', 'diagnosticBlock'],
  'module-telemetry': ['system', 'bmsParameters', 'diagnosticBlock'],
  alarms: ['state'],
  firmware: ['system', 'bmsParameters'],
  'be-connect-metadata': ['system', 'bmsParameters'],
  'energy-counters': ['state'],
};

const ALARM_BITS = [
  'High Temperature Charging (Cells)',
  'Low Temperature Charging (Cells)',
  'Over Current Discharging',
  'Over Current Charging',
  'Main circuit Failure',
  'Short Current Alarm',
  'Cells Imbalance',
  'Current Sensor Failure',
  'Battery Over Voltage',
  'Battery Under Voltage',
  'Cell Over Voltage',
  'Cell Under Voltage',
  'Voltage Sensor Failure',
  'Temperature Sensor Failure',
  'High Temperature Discharging (Cells)',
  'Low Temperature Discharging (Cells)',
];

const INCIDENT_ALARM_SLUGS = {
  4: 'bmu-main-circuit-failure',
  5: 'short-current-alarm',
  6: 'cells-imbalance',
  8: 'battery-over-voltage',
  9: 'battery-under-voltage',
  10: 'cell-over-voltage',
  11: 'cell-under-voltage',
  12: 'voltage-sensor-failure',
  13: 'temperature-sensor-failure',
};

const INVERTERS_HV = [
  'Fronius HV',
  'Goodwe HV',
  'Fronius HV',
  'Kostal HV',
  'Goodwe HV',
  'SMA SBS3.7/5.0',
  'Kostal HV',
  'SMA SBS3.7/5.0',
  'Sungrow HV',
  'Sungrow HV',
  'Kaco HV',
  'Kaco HV',
  'Ingeteam HV',
  'Ingeteam HV',
  'SMA SBS 2.5 HV',
  null,
  'SMA SBS 2.5 HV',
  'Fronius HV',
  null,
  'SMA STP',
];

const INVERTERS_LVS = [
  'Fronius HV',
  'Goodwe HV',
  'Goodwe HV',
  'Kostal HV',
  'Selectronic LV',
  'SMA SBS3.7/5.0',
  'SMA LV',
  'Victron LV',
  'Suntech LV',
  'Sungrow HV',
  'Kaco HV',
  'Studer LV',
  'Solar Edge LV',
  'Ingeteam HV',
  'Sungrow LV',
  'Schneider LV',
  'SMA SBS2.5 HV',
  'Solar Edge LV',
  'Solar Edge LV',
  'Solar Edge LV',
  'unknown',
];

function usage() {
  return `BYD Battery-Box skill helper

Read-only helper for BYD Battery-Box HVS/HVM/LVS/LVL telemetry.

Usage:
  node skills/byd-battery/byd-battery.cjs [--format json|pretty] read <operation> [flags]
  node skills/byd-battery/byd-battery.cjs [--format json|pretty] register-map

Operations:
  state-of-charge     SoC, SoH, current power direction, incident hints
  pack-telemetry      Pack voltage/current/power and temperature summary
  cell-extremes       Cell min/max voltage and temperature extremes
  inventory           Tower/module inventory and grid/inverter hints
  module-telemetry    Per-module voltage/temperature summaries from diagnostic pages
  alarms              Alarm/error bitmap decoded to human-readable labels
  firmware            BMU/BMS firmware, serial, hardware family hints
  be-connect-metadata Read-only commissioning metadata available from BMU registers
  energy-counters     Cumulative charge/discharge counters for R5 rollups

Flags:
  --via local|fronius         Transport selector. Default auto-selects local when BYD_BMU_HOST is set.
  --timeout-ms <ms>           Local Modbus timeout. Default ${DEFAULT_TIMEOUT_MS}.
  --format json|pretty        Output format. Default pretty.

Credentials are read from SecretRef-backed runtime secrets:
  ${SECRET_REFS.host}, ${SECRET_REFS.port}, ${SECRET_REFS.unitId}, ${SECRET_REFS.model}

No write coils, write registers, installer-app passwords, or arbitrary register reads are exposed.`;
}

function parseArgs(argv) {
  const opts = {
    format: 'pretty',
    via: 'auto',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    mockRegistersJson: undefined,
  };
  const positionals = [];
  const fail = (message) => {
    const error = new Error(message);
    error.outputFormat = opts.format;
    throw error;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--format') {
      opts.format = requireValue(argv, ++i, '--format');
      if (!['json', 'pretty'].includes(opts.format)) {
        fail('--format must be json or pretty');
      }
    } else if (arg === '--via') {
      opts.via = requireValue(argv, ++i, '--via');
      if (!['auto', 'local', 'fronius'].includes(opts.via)) {
        fail('--via must be auto, local, or fronius');
      }
    } else if (arg === '--timeout-ms') {
      try {
        opts.timeoutMs = parseBoundedInteger(
          requireValue(argv, ++i, '--timeout-ms'),
          '--timeout-ms',
          250,
          60_000,
        );
      } catch (error) {
        error.outputFormat = opts.format;
        throw error;
      }
    } else if (arg === '--mock-registers-json') {
      opts.mockRegistersJson = requireValue(argv, ++i, '--mock-registers-json');
    } else if (arg.startsWith('--')) {
      fail(`Unknown flag ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return { opts, positionals };
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseBoundedInteger(value, label, min, max) {
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`${label} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseUnitId(value) {
  return parseBoundedInteger(value, '--unit-id', 1, 247);
}

function parsePort(value) {
  return parseBoundedInteger(value, SECRET_REFS.port, 1, 65_535);
}

function readU16(registers, index) {
  assertRegister(registers, index);
  return registers[index] & 0xffff;
}

function toI16(value) {
  const normalized = value & 0xffff;
  return normalized >= 0x8000 ? normalized - 0x10000 : normalized;
}

function readI16(registers, index) {
  return toI16(readU16(registers, index));
}

function readU32LittleWord(registers, index) {
  const lo = readU16(registers, index);
  const hi = readU16(registers, index + 1);
  return hi * 0x10000 + lo;
}

function readI16Bytes(bytes, offset) {
  assertByte(bytes, offset + 1);
  return toI16(bytes[offset] * 256 + bytes[offset + 1]);
}

function readU32MixedBytes(bytes, offset) {
  assertByte(bytes, offset + 3);
  return (
    bytes[offset + 2] * 16_777_216 +
    bytes[offset + 3] * 65_536 +
    bytes[offset] * 256 +
    bytes[offset + 1]
  );
}

function assertRegister(registers, index) {
  if (!Array.isArray(registers) || index < 0 || index >= registers.length) {
    throw new Error(`Missing Modbus register index ${index}`);
  }
}

function assertByte(bytes, index) {
  if (!Array.isArray(bytes) || index < 0 || index >= bytes.length) {
    throw new Error(`Missing diagnostic byte index ${index}`);
  }
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function registersToBytes(registers) {
  const bytes = [];
  for (const register of registers) {
    bytes.push((register >> 8) & 0xff, register & 0xff);
  }
  return bytes;
}

function bytesToAscii(bytes) {
  return bytes
    .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ''))
    .join('')
    .trim();
}

function decodeStateRegisters(registers) {
  const socPercent = readI16(registers, 0);
  const maxCellVoltageMv = readI16(registers, 1) * 10;
  const minCellVoltageMv = readI16(registers, 2) * 10;
  const sohPercent = readI16(registers, 3);
  const currentA = round(readI16(registers, 4) / 10, 1);
  const packVoltageV = round(readU16(registers, 5) / 100, 1);
  const maxCellTemperatureC = readI16(registers, 6);
  const minCellTemperatureC = readI16(registers, 7);
  const packTemperatureC = readI16(registers, 8);
  const alarmBitmap = readU16(registers, 13);
  const outputVoltageV = round(readU16(registers, 16) / 100, 1);
  const packPowerW = round(currentA * outputVoltageV, 2);
  const chargeEnergyKwh = readU32LittleWord(registers, 17) / 10;
  const dischargeEnergyKwh = readU32LittleWord(registers, 19) / 10;
  const cellVoltageSpreadMv = maxCellVoltageMv - minCellVoltageMv;
  const alarmCodes = decodeAlarmBitmap(alarmBitmap);
  const incidentCards = buildIncidentCards({
    alarmBitmap,
    alarmCodes,
    cellVoltageSpreadMv,
    maxCellTemperatureC,
  });

  return {
    socPercent,
    sohPercent,
    packVoltageV,
    outputVoltageV,
    currentA,
    packPowerW,
    powerDirection:
      packPowerW > 0 ? 'discharging' : packPowerW < 0 ? 'charging' : 'idle',
    maxCellVoltageMv,
    minCellVoltageMv,
    cellVoltageSpreadMv,
    maxCellTemperatureC,
    minCellTemperatureC,
    packTemperatureC,
    alarmBitmap,
    alarmCodes,
    chargeEnergyKwh,
    dischargeEnergyKwh,
    incidentCards,
  };
}

function decodeSystemRegisters(registers) {
  const bytes = registersToBytes(registers);
  const serialNumber = bytesToAscii(bytes.slice(0, 19));
  const familyByte = bytes[2];
  const family =
    familyByte === 0x33
      ? 'HVS'
      : familyByte === 0x31 || familyByte === 0x32
        ? 'LVS'
        : 'HVM';
  const bmuBankA = `V${bytes[24] || 0}.${bytes[25] || 0}`;
  const bmuBankB = `V${bytes[26] || 0}.${bytes[27] || 0}`;
  const activeBmu = bytes[30] === 0 ? `${bmuBankA}-A` : `${bmuBankB}-B`;
  const bmsFirmware = `V${bytes[28] || 0}.${bytes[29] || 0}-${String.fromCharCode((bytes[31] || 0) + 65)}`;
  const hardwareRevision = bytesToAscii(bytes.slice(19, 24)) || null;
  const topology = bytes[33] || 0;
  const towers = Math.floor(topology / 16);
  const modulesPerTower = topology % 16;
  const gridModes = ['OffGrid', 'OnGrid', 'Backup'];
  const gridTieDirection = gridModes[bytes[35]] || 'unknown';

  return {
    serialNumber,
    modelFamily: family,
    bmuFirmware: activeBmu,
    bmuBankA,
    bmuBankB,
    bmsFirmware,
    hardwareRevision,
    towers,
    modulesPerTower,
    totalModules: towers * modulesPerTower,
    gridTieDirection,
  };
}

function decodeBmsParametersRegisters(registers, system = {}) {
  const bytes = registersToBytes(registers);
  const inverterType = bytes[0] ?? 0;
  const batteryTypeCode = bytes[2] ?? null;
  const serialFamily = system.modelFamily;

  let modelFamily = 'unknown';
  let capacityPerModuleKwh = null;
  let cellsPerModule = 0;
  let temperaturesPerModule = 0;

  if (batteryTypeCode === 0) {
    modelFamily = 'HVL';
    capacityPerModuleKwh = 4;
  } else if (batteryTypeCode === 1) {
    modelFamily = 'HVM';
    capacityPerModuleKwh = 2.76;
    cellsPerModule = 16;
    temperaturesPerModule = 8;
  } else if (batteryTypeCode === 2) {
    modelFamily = 'HVS';
    capacityPerModuleKwh = 2.56;
    cellsPerModule = 32;
    temperaturesPerModule = 12;
  } else if (serialFamily === 'LVS') {
    modelFamily = 'LVS';
    capacityPerModuleKwh = 4;
    cellsPerModule = 7;
  }

  const inverterNames = modelFamily === 'LVS' ? INVERTERS_LVS : INVERTERS_HV;
  const inverterName = inverterNames[inverterType];
  const modulesPerTower = system.modulesPerTower || 0;
  const towers = system.towers || 0;

  return {
    inverterType,
    inverterName: inverterName || 'unknown',
    batteryTypeCode,
    modelFamily,
    capacityPerModuleKwh,
    cellsPerModule,
    temperaturesPerModule,
    cellsPerTower: modulesPerTower * cellsPerModule,
    temperaturesPerTower: modulesPerTower * temperaturesPerModule,
    totalCapacityKwh:
      capacityPerModuleKwh !== null
        ? round(towers * modulesPerTower * capacityPerModuleKwh, 2)
        : null,
  };
}

function decodeDiagnosticPages(pageRegisters, topology = {}) {
  const pages = Array.isArray(pageRegisters?.[0])
    ? pageRegisters
    : [pageRegisters];
  const normalizedPages = pages.filter(Array.isArray);
  if (normalizedPages.length === 0) {
    throw new Error('At least one diagnostic page is required');
  }

  const pageBytes = normalizedPages.map((page) => registersToBytes(page));
  const firstBytes = pageBytes[0];
  const cellVoltagesMv = [];
  const temperaturesC = [];
  const cellsPerModule = topology.cellsPerModule || 0;
  const temperaturesPerModule = topology.temperaturesPerModule || 0;
  const modulesPerTower = topology.modulesPerTower || 0;
  const cellsPerTower =
    topology.cellsPerTower || modulesPerTower * cellsPerModule;
  const temperaturesPerTower =
    topology.temperaturesPerTower || modulesPerTower * temperaturesPerModule;

  const requirePageBytes = (pageIndex) => {
    const bytes = pageBytes[pageIndex];
    if (!bytes) {
      throw new Error(`Missing diagnostic page ${pageIndex + 1}`);
    }
    return bytes;
  };

  const readVoltagePage = (pageIndex, startCellIndex, offset, count) => {
    const bytes = requirePageBytes(pageIndex);
    for (let index = 0; index < count; index += 1) {
      if (offset + index * 2 + 1 >= bytes.length) break;
      const raw = readI16Bytes(bytes, offset + index * 2);
      if (raw > 0) cellVoltagesMv[startCellIndex + index] = raw;
    }
  };

  const readTemperaturePage = (pageIndex, startTempIndex, offset, count) => {
    const bytes = requirePageBytes(pageIndex);
    for (let index = 0; index < count; index += 1) {
      if (offset + index >= bytes.length) break;
      const raw = bytes[offset + index];
      if (raw > 0) temperaturesC[startTempIndex + index] = raw;
    }
  };

  readVoltagePage(0, 0, 98, Math.min(16, cellsPerTower || 16));
  if (cellsPerTower > 16) {
    readVoltagePage(1, 16, 2, Math.min(64, cellsPerTower - 16));
  }
  if (cellsPerTower > 80) {
    readVoltagePage(2, 80, 2, Math.min(48, cellsPerTower - 80));
  }
  if (temperaturesPerTower > 0) {
    readTemperaturePage(2, 0, 100, Math.min(30, temperaturesPerTower));
  }
  if (temperaturesPerTower > 30) {
    readTemperaturePage(3, 30, 2, Math.min(34, temperaturesPerTower - 30));
  }

  const modules = buildModuleSummaries({
    cellVoltagesMv,
    temperaturesC,
    cellsPerModule,
    temperaturesPerModule,
    modulesPerTower,
  });
  const balanceBitmapHex = firstBytes
    .slice(14, 30)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  const balanceCellCount = countSetBits(firstBytes.slice(14, 30));

  return {
    tower: 1,
    maxCellVoltageMv: readI16Bytes(firstBytes, 2),
    minCellVoltageMv: readI16Bytes(firstBytes, 4),
    maxCellVoltageIndex: firstBytes[6] || null,
    minCellVoltageIndex: firstBytes[7] || null,
    cellVoltageSpreadMv:
      readI16Bytes(firstBytes, 2) - readI16Bytes(firstBytes, 4),
    maxCellTemperatureC: readI16Bytes(firstBytes, 8),
    minCellTemperatureC: readI16Bytes(firstBytes, 10),
    maxCellTemperatureIndex: firstBytes[12] || null,
    minCellTemperatureIndex: firstBytes[13] || null,
    balanceBitmapHex,
    balanceCellCount,
    chargeEnergyKwh: readU32MixedBytes(firstBytes, 30) / 1000,
    dischargeEnergyKwh: readU32MixedBytes(firstBytes, 34) / 1000,
    packVoltageV: round(readI16Bytes(firstBytes, 42) / 10, 1),
    outputVoltageV: round(readI16Bytes(firstBytes, 48) / 10, 1),
    socPercent: round(readI16Bytes(firstBytes, 50) / 10, 1),
    sohPercent: readI16Bytes(firstBytes, 52),
    currentA: round(readI16Bytes(firstBytes, 54) / 10, 1),
    stateBitmap: (firstBytes[56] || 0) * 256 + (firstBytes[57] || 0),
    cellVoltagesMv: compactIndexedValues(cellVoltagesMv),
    temperaturesC: compactIndexedValues(temperaturesC),
    modules,
    diagnosticPagesRead: normalizedPages.length,
  };
}

function countSetBits(bytes) {
  let count = 0;
  for (const byte of bytes) {
    let value = byte;
    for (let index = 0; index < 8; index += 1) {
      if ((value & 1) === 1) count += 1;
      value >>= 1;
    }
  }
  return count;
}

function compactIndexedValues(values) {
  return values
    .map((value, index) =>
      value === undefined
        ? undefined
        : {
            index: index + 1,
            value,
          },
    )
    .filter(Boolean);
}

function buildModuleSummaries({
  cellVoltagesMv,
  temperaturesC,
  cellsPerModule,
  temperaturesPerModule,
  modulesPerTower,
}) {
  if (!cellsPerModule || !modulesPerTower) return [];
  const modules = [];
  for (let moduleIndex = 0; moduleIndex < modulesPerTower; moduleIndex += 1) {
    const cellStart = moduleIndex * cellsPerModule;
    const cellValues = cellVoltagesMv
      .slice(cellStart, cellStart + cellsPerModule)
      .filter((value) => Number.isFinite(value));
    const tempStart = moduleIndex * temperaturesPerModule;
    const temperatureValues =
      temperaturesPerModule > 0
        ? temperaturesC
            .slice(tempStart, tempStart + temperaturesPerModule)
            .filter((value) => Number.isFinite(value))
        : [];
    modules.push({
      module: moduleIndex + 1,
      cellsExpected: cellsPerModule,
      cellsReported: cellValues.length,
      voltageMinMv: minOrNull(cellValues),
      voltageMaxMv: maxOrNull(cellValues),
      voltageAverageMv: averageOrNull(cellValues),
      voltageSpreadMv:
        cellValues.length > 0
          ? maxOrNull(cellValues) - minOrNull(cellValues)
          : null,
      temperaturesExpected: temperaturesPerModule,
      temperaturesReported: temperatureValues.length,
      temperatureMinC: minOrNull(temperatureValues),
      temperatureMaxC: maxOrNull(temperatureValues),
      temperatureAverageC: averageOrNull(temperatureValues),
    });
  }
  return modules;
}

function minOrNull(values) {
  return values.length > 0 ? Math.min(...values) : null;
}

function maxOrNull(values) {
  return values.length > 0 ? Math.max(...values) : null;
}

function averageOrNull(values) {
  if (values.length === 0) return null;
  return round(
    values.reduce((sum, value) => sum + value, 0) / values.length,
    2,
  );
}

function decodeAlarmBitmap(bitmap) {
  const alarms = [];
  for (let bit = 0; bit < ALARM_BITS.length; bit += 1) {
    if ((bitmap & (1 << bit)) !== 0) {
      alarms.push({
        bit,
        code: ALARM_BITS[bit],
      });
    }
  }
  return alarms;
}

function buildIncidentCards({
  alarmBitmap,
  alarmCodes,
  cellVoltageSpreadMv,
  maxCellTemperatureC,
}) {
  const cards = [];

  if (cellVoltageSpreadMv > 100) {
    cards.push({
      system: 'R29',
      type: 'cell-voltage-spread',
      severity: 'warning',
      title: 'Cell voltage spread > 100 mV',
      detail: `${cellVoltageSpreadMv} mV spread between min/max reported cells`,
      dedupeKey: `byd-battery:cell-voltage-spread:${Math.floor(cellVoltageSpreadMv / 10) * 10}`,
    });
  }

  if (maxCellTemperatureC > 50) {
    cards.push({
      system: 'R29',
      type: 'module-temperature-high',
      severity: 'critical',
      title: 'Module temperature > 50 C',
      detail: `${maxCellTemperatureC} C maximum reported cell/module temperature`,
      dedupeKey: `byd-battery:module-temperature:${maxCellTemperatureC}`,
    });
  }

  for (const alarm of alarmCodes) {
    const slug = INCIDENT_ALARM_SLUGS[alarm.bit];
    if (!slug) continue;
    cards.push({
      system: 'R29',
      type: slug,
      severity: alarm.bit === 5 ? 'critical' : 'warning',
      title: alarm.code,
      detail: `BYD BMU alarm bit ${alarm.bit} set in bitmap 0x${alarmBitmap
        .toString(16)
        .padStart(4, '0')}`,
      dedupeKey: `byd-battery:alarm:${alarm.bit}`,
    });
  }

  return cards;
}

function buildCommsLostIncident(error) {
  return {
    system: 'R29',
    type: 'bmu-comms-lost',
    severity: 'warning',
    title: 'BMU comms lost',
    detail: error.message,
    dedupeKey: 'byd-battery:bmu-comms-lost',
  };
}

function once(fn) {
  let called = false;
  let value;
  return () => {
    if (!called) {
      value = fn();
      called = true;
    }
    return value;
  };
}

function requireRegisterBlock(registerBlocks, name, operation) {
  if (registerBlocks[name] === undefined) {
    throw new Error(`Operation ${operation} requires ${name} registers`);
  }
  return registerBlocks[name];
}

function requireDiagnosticBlock(registerBlocks, operation) {
  if (registerBlocks.diagnosticPages !== undefined) {
    return registerBlocks.diagnosticPages;
  }
  if (registerBlocks.diagnosticBlock !== undefined) {
    return registerBlocks.diagnosticBlock;
  }
  throw new Error(`Operation ${operation} requires diagnosticPages registers`);
}

function buildIdentityBlock(system, bmsParameters) {
  return {
    serialNumber: system.serialNumber,
    modelFamily: system.modelFamily,
    batteryTypeCode: bmsParameters?.batteryTypeCode ?? null,
    inverterName: bmsParameters?.inverterName ?? null,
    bmuFirmware: system.bmuFirmware,
    bmsFirmware: system.bmsFirmware,
    hardwareRevision: system.hardwareRevision,
  };
}

function decodeOperation(operation, registerBlocks) {
  if (!OPERATION_RANGES[operation]) {
    throw new Error(`Unsupported read operation ${operation}`);
  }

  const getState = once(() =>
    decodeStateRegisters(
      requireRegisterBlock(registerBlocks, 'state', operation),
    ),
  );
  const getSystem = once(() =>
    decodeSystemRegisters(
      requireRegisterBlock(registerBlocks, 'system', operation),
    ),
  );
  const getBmsParameters = once(() =>
    decodeBmsParametersRegisters(
      requireRegisterBlock(registerBlocks, 'bmsParameters', operation),
      getSystem(),
    ),
  );
  const getDiagnostic = once(() =>
    decodeDiagnosticPages(requireDiagnosticBlock(registerBlocks, operation), {
      ...getSystem(),
      ...getBmsParameters(),
    }),
  );
  const getOptionalDiagnostic = once(() => {
    if (
      registerBlocks.diagnosticPages === undefined &&
      registerBlocks.diagnosticBlock === undefined
    ) {
      return undefined;
    }
    return decodeDiagnosticPages(
      registerBlocks.diagnosticPages ?? registerBlocks.diagnosticBlock,
      {
        ...(registerBlocks.system !== undefined ? getSystem() : {}),
        ...(registerBlocks.bmsParameters !== undefined
          ? getBmsParameters()
          : {}),
      },
    );
  });

  if (operation === 'state-of-charge') {
    const state = getState();
    return {
      socPercent: state.socPercent,
      sohPercent: state.sohPercent,
      packPowerW: state.packPowerW,
      powerDirection: state.powerDirection,
      alarmCount: state.alarmCodes.length,
      incidentCards: state.incidentCards,
    };
  }
  if (operation === 'pack-telemetry') {
    const state = getState();
    return {
      packVoltageV: state.packVoltageV,
      outputVoltageV: state.outputVoltageV,
      currentA: state.currentA,
      packPowerW: state.packPowerW,
      powerDirection: state.powerDirection,
      packTemperatureC: state.packTemperatureC,
    };
  }
  if (operation === 'cell-extremes') {
    const state = getState();
    const diagnostic = getOptionalDiagnostic();
    return {
      maxCellVoltageMv: state.maxCellVoltageMv,
      minCellVoltageMv: state.minCellVoltageMv,
      cellVoltageSpreadMv: state.cellVoltageSpreadMv,
      maxCellTemperatureC: state.maxCellTemperatureC,
      minCellTemperatureC: state.minCellTemperatureC,
      diagnostic:
        diagnostic !== undefined
          ? {
              maxCellVoltageMv: diagnostic.maxCellVoltageMv,
              minCellVoltageMv: diagnostic.minCellVoltageMv,
              maxCellVoltageIndex: diagnostic.maxCellVoltageIndex,
              minCellVoltageIndex: diagnostic.minCellVoltageIndex,
              maxCellTemperatureC: diagnostic.maxCellTemperatureC,
              minCellTemperatureC: diagnostic.minCellTemperatureC,
              maxCellTemperatureIndex: diagnostic.maxCellTemperatureIndex,
              minCellTemperatureIndex: diagnostic.minCellTemperatureIndex,
            }
          : null,
      incidentCards: state.incidentCards.filter((card) =>
        ['cell-voltage-spread', 'module-temperature-high'].includes(card.type),
      ),
    };
  }
  if (operation === 'alarms') {
    const state = getState();
    return {
      alarmBitmap: state.alarmBitmap,
      alarmCodes: state.alarmCodes,
      incidentCards: state.incidentCards,
    };
  }
  if (operation === 'energy-counters') {
    const state = getState();
    return {
      chargeEnergyKwh: state.chargeEnergyKwh,
      dischargeEnergyKwh: state.dischargeEnergyKwh,
      r5Rollup: {
        system: 'R5',
        source: 'byd-battery',
        chargeEnergyKwh: state.chargeEnergyKwh,
        dischargeEnergyKwh: state.dischargeEnergyKwh,
      },
    };
  }
  if (operation === 'inventory') {
    const system = getSystem();
    const bmsParameters = getBmsParameters();
    const diagnostic = getOptionalDiagnostic();
    return {
      modelFamily: system.modelFamily,
      batteryType:
        bmsParameters !== undefined
          ? {
              code: bmsParameters.batteryTypeCode,
              family: bmsParameters.modelFamily,
              cellsPerModule: bmsParameters.cellsPerModule,
              temperaturesPerModule: bmsParameters.temperaturesPerModule,
              capacityPerModuleKwh: bmsParameters.capacityPerModuleKwh,
              totalCapacityKwh: bmsParameters.totalCapacityKwh,
            }
          : null,
      towers: system.towers,
      modulesPerTower: system.modulesPerTower,
      totalModules: system.totalModules,
      gridTieDirection: system.gridTieDirection,
      inverter:
        bmsParameters !== undefined
          ? {
              type: bmsParameters.inverterType,
              name: bmsParameters.inverterName,
            }
          : null,
      serialNumber: system.serialNumber,
      modules: diagnostic?.modules || [],
    };
  }
  if (operation === 'module-telemetry') {
    const system = getSystem();
    const bmsParameters = getBmsParameters();
    const diagnostic = getDiagnostic();
    return {
      tower: diagnostic.tower,
      modulesPerTower: system.modulesPerTower,
      cellsPerModule: bmsParameters.cellsPerModule,
      temperaturesPerModule: bmsParameters.temperaturesPerModule,
      cellVoltagesMv: diagnostic.cellVoltagesMv,
      temperaturesC: diagnostic.temperaturesC,
      modules: diagnostic.modules,
      balance: {
        bitmapHex: diagnostic.balanceBitmapHex,
        cellCount: diagnostic.balanceCellCount,
      },
      towerSummary: {
        socPercent: diagnostic.socPercent,
        sohPercent: diagnostic.sohPercent,
        packVoltageV: diagnostic.packVoltageV,
        outputVoltageV: diagnostic.outputVoltageV,
        currentA: diagnostic.currentA,
        chargeEnergyKwh: diagnostic.chargeEnergyKwh,
        dischargeEnergyKwh: diagnostic.dischargeEnergyKwh,
        stateBitmap: diagnostic.stateBitmap,
      },
    };
  }
  if (operation === 'firmware') {
    const system = getSystem();
    const bmsParameters = getBmsParameters();
    return {
      ...buildIdentityBlock(system, bmsParameters),
      bmuBankA: system.bmuBankA,
      bmuBankB: system.bmuBankB,
    };
  }
  if (operation === 'be-connect-metadata') {
    const system = getSystem();
    const bmsParameters = getBmsParameters();
    return {
      status: 'metadata-only',
      source: 'local-bmu-registers',
      publicBeConnectPlusApiAvailable: false,
      ...buildIdentityBlock(system, bmsParameters),
      topology: {
        towers: system.towers,
        modulesPerTower: system.modulesPerTower,
        totalModules: system.totalModules,
      },
      note: 'BYD does not publish a public Be Connect Plus API; v1 does not automate service-app login or credential flows.',
    };
  }

  throw new Error(`Unsupported read operation ${operation}`);
}

function buildSource(operation, rangeNames) {
  return {
    skillName: SKILL_NAME,
    protocol: 'modbus-tcp',
    unitIdSecretRef: SECRET_REFS.unitId,
    hostSecretRef: SECRET_REFS.host,
    portSecretRef: SECRET_REFS.port,
    modelSecretRef: SECRET_REFS.model,
    registerMap: 'community-byd-battery-box-premium-hvs-hvm-lvs',
    registerRanges: rangeNames.map((name) => ({
      name,
      start: READ_RANGES[name].start,
      quantity: READ_RANGES[name].quantity,
      label: READ_RANGES[name].label,
    })),
    operation,
  };
}

function buildSuccessPayload(operation, registerBlocks, options = {}) {
  const rangeNames = OPERATION_RANGES[operation];
  const payload = {
    command: 'read',
    operation,
    via: 'local-modbus',
    schemaVersion: 1,
    data: decodeOperation(operation, registerBlocks),
    source: buildSource(operation, rangeNames),
  };
  if (options.mockRegisters) {
    payload.warning =
      '--mock-registers-json active: decoded allowlisted mock registers; data is not live BMU telemetry.';
  }
  return payload;
}

function buildFroniusDelegation(operation) {
  const endpoint =
    operation === 'energy-counters'
      ? 'local-storage-realtime'
      : 'local-power-flow';
  return {
    command: 'read',
    operation,
    via: 'fronius',
    schemaVersion: 1,
    delegatedTo: {
      roadmapItem: 'R21.111',
      skillName: 'fronius',
      endpoint,
    },
    status: 'delegated',
    note: 'Use the R21.111 Fronius skill when BYD local Modbus is not configured and the battery is paired with a Fronius inverter. This checkout does not currently include a Fronius helper path to execute directly.',
  };
}

function buildUnconfiguredPayload(operation) {
  return {
    command: 'read',
    operation,
    schemaVersion: 1,
    status: 'unconfigured',
    error: {
      code: 'BYD_BATTERY_NOT_CONFIGURED',
      message:
        'Neither BYD local Modbus SecretRefs nor an explicit Fronius delegation path are configured.',
      missingSecretRefs: [
        SECRET_REFS.host,
        SECRET_REFS.port,
        SECRET_REFS.unitId,
      ],
    },
    delegationCandidates: [
      {
        via: 'fronius',
        roadmapItem: 'R21.111',
        command: `node skills/byd-battery/byd-battery.cjs --format json read ${operation} --via fronius`,
      },
    ],
  };
}

function parseMockRegisters(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `--mock-registers-json must be valid JSON: ${error.message}`,
    );
  }
  const blocks = {};
  for (const [name, registers] of Object.entries(parsed)) {
    if (name === 'diagnosticPages') {
      if (!Array.isArray(registers)) {
        throw new Error('Mock diagnosticPages must be an array of pages');
      }
      blocks.diagnosticPages = registers.map((page, pageIndex) => {
        if (!Array.isArray(page)) {
          throw new Error(
            `Mock diagnosticPages[${pageIndex}] must be an array`,
          );
        }
        return page.map((value, registerIndex) => {
          if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
            throw new Error(
              `Mock diagnosticPages[${pageIndex}][${registerIndex}] must be a 16-bit integer`,
            );
          }
          return value;
        });
      });
      continue;
    }
    if (!READ_RANGES[name]) {
      throw new Error(`Mock register block ${name} is not allowlisted`);
    }
    if (!Array.isArray(registers)) {
      throw new Error(`Mock register block ${name} must be an array`);
    }
    blocks[name] = registers.map((value, index) => {
      if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        throw new Error(
          `Mock register ${name}[${index}] must be a 16-bit integer`,
        );
      }
      return value;
    });
  }
  return blocks;
}

function selectTransport(opts, env) {
  if (opts.via === 'local') return 'local';
  if (opts.via === 'fronius') return 'fronius';
  if (opts.mockRegistersJson || env[SECRET_REFS.host]) return 'local';
  if (env.FRONIUS_HOST || env.FRONIUS_INVERTER_HOST) return 'fronius';
  return 'unconfigured';
}

function isPrivateHost(host) {
  const value = String(host || '')
    .trim()
    .toLowerCase();
  if (!value) return false;
  if (value === 'localhost' || value === '::1') return true;
  if (
    value.endsWith('.local') ||
    value.endsWith('.lan') ||
    value.endsWith('.home.arpa')
  ) {
    return true;
  }
  const ipv4 = value.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
  if (ipv4) {
    const octets = value.split('.').map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) return false;
    const [a, b] = octets;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (value.includes(':')) {
    return (
      value === '::1' ||
      value.startsWith('fe80:') ||
      value.startsWith('fc') ||
      value.startsWith('fd')
    );
  }
  return false;
}

function resolveLocalConfig(opts, env) {
  const host = env[SECRET_REFS.host];
  if (!host) {
    throw new Error(
      `Missing ${SECRET_REFS.host}; store it with hybridclaw secret set`,
    );
  }
  if (!isPrivateHost(host)) {
    throw new Error(
      `${SECRET_REFS.host} must identify a loopback, link-local, or LAN BMU host`,
    );
  }
  return {
    host,
    port: env[SECRET_REFS.port]
      ? parsePort(env[SECRET_REFS.port])
      : DEFAULT_MODBUS_PORT,
    unitId: env[SECRET_REFS.unitId]
      ? parseUnitId(env[SECRET_REFS.unitId])
      : DEFAULT_UNIT_ID,
    timeoutMs: opts.timeoutMs,
  };
}

function buildModbusReadRequest(unitId, start, quantity, transactionId = 1) {
  if (!Number.isInteger(unitId) || unitId < 1 || unitId > 247) {
    throw new Error(
      'unitId must be pinned to a single Modbus unit id from 1 to 247',
    );
  }
  if (!isAllowlistedRange(start, quantity)) {
    throw new Error(
      `Register range 0x${start.toString(16)}:${quantity} is not allowlisted`,
    );
  }
  const request = Buffer.alloc(12);
  request.writeUInt16BE(transactionId & 0xffff, 0);
  request.writeUInt16BE(0, 2);
  request.writeUInt16BE(6, 4);
  request.writeUInt8(unitId, 6);
  request.writeUInt8(3, 7);
  request.writeUInt16BE(start, 8);
  request.writeUInt16BE(quantity, 10);
  return request;
}

function isAllowlistedRange(start, quantity) {
  return Object.values(READ_RANGES).some(
    (range) => range.start === start && range.quantity === quantity,
  );
}

function parseModbusReadResponse(buffer, expected) {
  if (buffer.length < 9) throw new Error('Short Modbus TCP response');
  const transactionId = buffer.readUInt16BE(0);
  const protocolId = buffer.readUInt16BE(2);
  const unitId = buffer.readUInt8(6);
  const functionCode = buffer.readUInt8(7);
  if (transactionId !== expected.transactionId) {
    throw new Error('Mismatched Modbus transaction id');
  }
  if (protocolId !== 0) throw new Error('Unexpected Modbus protocol id');
  if (unitId !== expected.unitId) throw new Error('Unexpected Modbus unit id');
  if (functionCode & 0x80) {
    const exceptionCode = buffer.readUInt8(8);
    throw new Error(`Modbus exception 0x${exceptionCode.toString(16)}`);
  }
  if (functionCode !== 3) throw new Error('Unexpected Modbus function code');
  const byteCount = buffer.readUInt8(8);
  if (byteCount !== expected.quantity * 2) {
    throw new Error('Unexpected Modbus byte count');
  }
  if (buffer.length < 9 + byteCount) {
    throw new Error('Incomplete Modbus register payload');
  }
  const registers = [];
  for (let offset = 9; offset < 9 + byteCount; offset += 2) {
    registers.push(buffer.readUInt16BE(offset));
  }
  return registers;
}

function readHoldingRegisters(config, range, transactionId) {
  return new Promise((resolve, reject) => {
    const request = buildModbusReadRequest(
      config.unitId,
      range.start,
      range.quantity,
      transactionId,
    );
    const socket = new net.Socket();
    let responseBuffer = Buffer.alloc(512);
    let responseLength = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    socket.setTimeout(config.timeoutMs);
    socket.once('timeout', () => {
      finish(
        new Error(`Timed out reading BYD BMU after ${config.timeoutMs} ms`),
      );
    });
    socket.once('error', (error) => {
      finish(new Error(`Failed to connect to BYD BMU: ${error.message}`));
    });
    socket.once('close', () => {
      finish(new Error('BYD BMU closed connection before complete response'));
    });
    socket.on('data', (chunk) => {
      while (responseLength + chunk.length > responseBuffer.length) {
        const expanded = Buffer.alloc(responseBuffer.length * 2);
        responseBuffer.copy(expanded, 0, 0, responseLength);
        responseBuffer = expanded;
      }
      chunk.copy(responseBuffer, responseLength);
      responseLength += chunk.length;
      if (responseLength < 9) return;
      const modbusLength = responseBuffer.readUInt16BE(4);
      const expectedLength = 6 + modbusLength;
      if (responseLength < expectedLength) return;
      try {
        finish(
          null,
          parseModbusReadResponse(responseBuffer.subarray(0, expectedLength), {
            transactionId,
            unitId: config.unitId,
            quantity: range.quantity,
          }),
        );
      } catch (error) {
        finish(error);
      }
    });
    socket.connect(config.port, config.host, () => {
      socket.write(request);
    });
  });
}

async function readLocalOperation(operation, opts, env = process.env) {
  const rangeNames = OPERATION_RANGES[operation];
  if (!rangeNames) throw new Error(`Unsupported read operation ${operation}`);

  if (opts.mockRegistersJson) {
    const mockBlocks = parseMockRegisters(opts.mockRegistersJson);
    const selectedBlocks = {};
    for (const rangeName of rangeNames) {
      if (rangeName === 'diagnosticBlock' && mockBlocks.diagnosticPages) {
        selectedBlocks.diagnosticPages = mockBlocks.diagnosticPages;
        continue;
      }
      if (!mockBlocks[rangeName]) {
        throw new Error(
          `Missing mock register block ${rangeName} for ${operation}`,
        );
      }
      selectedBlocks[rangeName] = mockBlocks[rangeName];
    }
    return buildSuccessPayload(operation, selectedBlocks, {
      mockRegisters: true,
    });
  }

  const config = resolveLocalConfig(opts, env);
  const blocks = {};
  // Keep BYD diagnostic reads sequential: repeated reads of 0x0558 advance
  // page data on some BMU firmware, and parallel sockets can reorder pages.
  for (let index = 0; index < rangeNames.length; index += 1) {
    const rangeName = rangeNames[index];
    if (rangeName === 'diagnosticBlock') {
      blocks.diagnosticPages = [];
      for (
        let pageIndex = 0;
        pageIndex < DIAGNOSTIC_PAGE_READ_COUNT;
        pageIndex += 1
      ) {
        blocks.diagnosticPages.push(
          await readHoldingRegisters(
            config,
            READ_RANGES[rangeName],
            index + pageIndex + 1,
          ),
        );
      }
    } else {
      blocks[rangeName] = await readHoldingRegisters(
        config,
        READ_RANGES[rangeName],
        index + 1,
      );
    }
  }
  return buildSuccessPayload(operation, blocks);
}

function buildRegisterMapPayload() {
  return {
    command: 'register-map',
    skillName: SKILL_NAME,
    schemaVersion: 1,
    writesExposed: false,
    arbitraryRegisterReadsExposed: false,
    ranges: Object.fromEntries(
      Object.entries(READ_RANGES).map(([name, range]) => [
        name,
        {
          start: range.start,
          quantity: range.quantity,
          label: range.label,
        },
      ]),
    ),
  };
}

function printPayload(payload, format) {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
}

async function buildRequest(opts, positionals, env = process.env) {
  if (opts.help) {
    return { help: true };
  }
  const command = positionals[0];
  if (command === 'register-map') {
    return buildRegisterMapPayload();
  }
  if (command !== 'read') {
    throw new Error('Usage: read <operation> or register-map');
  }
  const operation = positionals[1];
  if (!OPERATION_RANGES[operation]) {
    throw new Error(`Unsupported read operation ${operation}`);
  }

  const transport = selectTransport(opts, env);
  if (transport === 'fronius') {
    return buildFroniusDelegation(operation);
  }
  if (transport === 'unconfigured') {
    const payload = buildUnconfiguredPayload(operation);
    payload.exitCode = 2;
    return payload;
  }
  return readLocalOperation(operation, opts, env);
}

async function buildRequestFromArgs(argv, env = process.env) {
  const { opts, positionals } = parseArgs(argv);
  return buildRequest(opts, positionals, env);
}

async function main() {
  const argv = process.argv.slice(2);
  let requestedFormat = 'pretty';
  try {
    const { opts, positionals } = parseArgs(argv);
    requestedFormat = opts.format;
    if (opts.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const payload = await buildRequest(opts, positionals);
    const exitCode = payload.exitCode || 0;
    if (payload.exitCode) delete payload.exitCode;
    printPayload(payload, opts.format);
    process.exitCode = exitCode;
  } catch (error) {
    if (error.outputFormat) {
      requestedFormat = error.outputFormat;
    }
    const payload = {
      command: 'error',
      skillName: SKILL_NAME,
      schemaVersion: 1,
      error: {
        code: /Timed out|connect|ECONN|ENOTFOUND|EHOST|Modbus exception/.test(
          error.message,
        )
          ? 'BYD_BMU_COMMS_LOST'
          : 'BYD_BATTERY_HELPER_ERROR',
        message: error.message,
      },
    };
    if (payload.error.code === 'BYD_BMU_COMMS_LOST') {
      payload.incidentCards = [buildCommsLostIncident(error)];
    }
    printPayload(payload, requestedFormat);
    process.exitCode = payload.error.code === 'BYD_BMU_COMMS_LOST' ? 3 : 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ALARM_BITS,
  OPERATION_RANGES,
  READ_RANGES,
  SECRET_REFS,
  buildFroniusDelegation,
  buildModbusReadRequest,
  buildRegisterMapPayload,
  buildRequest,
  buildRequestFromArgs,
  buildSuccessPayload,
  decodeAlarmBitmap,
  decodeBmsParametersRegisters,
  decodeDiagnosticPages,
  decodeOperation,
  decodeStateRegisters,
  decodeSystemRegisters,
  isAllowlistedRange,
  isPrivateHost,
  parseArgs,
  parseModbusReadResponse,
  parseUnitId,
  readHoldingRegisters,
};
