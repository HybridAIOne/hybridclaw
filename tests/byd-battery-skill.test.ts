import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const skillRoot = path.join(process.cwd(), 'skills', 'byd-battery');
const helperPath = path.join(skillRoot, 'byd-battery.cjs');
const skillPath = path.join(skillRoot, 'SKILL.md');
const require = createRequire(import.meta.url);
const byd = require('../skills/byd-battery/byd-battery.cjs');

function runHelper(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

function encodeI16(value: number) {
  return value < 0 ? 0x10000 + value : value;
}

function fixtureStateRegisters() {
  const registers = Array.from({ length: 25 }, () => 0);
  registers[0] = 67;
  registers[1] = 340;
  registers[2] = 328;
  registers[3] = 98;
  registers[4] = encodeI16(-125);
  registers[5] = 5123;
  registers[6] = 52;
  registers[7] = 18;
  registers[8] = 26;
  registers[13] = (1 << 6) | (1 << 10);
  registers[16] = 5120;
  registers[17] = 12_345;
  registers[18] = 0;
  registers[19] = 23_456;
  registers[20] = 0;
  return registers;
}

function fixtureSystemRegisters() {
  const bytes = Array.from({ length: 204 }, () => 0);
  const serial = 'PP3000000000000001';
  for (let index = 0; index < serial.length; index += 1) {
    bytes[index] = serial.charCodeAt(index);
  }
  bytes[24] = 1;
  bytes[25] = 2;
  bytes[26] = 1;
  bytes[27] = 3;
  bytes[28] = 2;
  bytes[29] = 4;
  bytes[30] = 0;
  bytes[31] = 1;
  bytes[19] = 'H'.charCodeAt(0);
  bytes[20] = 'W'.charCodeAt(0);
  bytes[21] = '1'.charCodeAt(0);
  bytes[33] = 0x23;
  bytes[35] = 1;

  return bytesToRegisters(bytes);
}

function fixtureBmsParametersRegisters() {
  return bytesToRegisters([17, 0, 1, 0, 0, 0]);
}

function bytesToRegisters(bytes: number[]) {
  const registers = [];
  for (let index = 0; index < bytes.length; index += 2) {
    registers.push((bytes[index] << 8) | (bytes[index + 1] || 0));
  }
  return registers;
}

function writeI16(bytes: number[], offset: number, value: number) {
  const encoded = value < 0 ? 0x10000 + value : value;
  bytes[offset] = (encoded >> 8) & 0xff;
  bytes[offset + 1] = encoded & 0xff;
}

function writeU32Mixed(bytes: number[], offset: number, value: number) {
  bytes[offset] = (value >> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
  bytes[offset + 2] = (value >> 24) & 0xff;
  bytes[offset + 3] = (value >> 16) & 0xff;
}

function fixtureDiagnosticPages() {
  const page0 = Array.from({ length: 130 }, () => 0);
  const page1 = Array.from({ length: 130 }, () => 0);
  const page2 = Array.from({ length: 130 }, () => 0);
  const page3 = Array.from({ length: 130 }, () => 0);

  writeI16(page0, 2, 3410);
  writeI16(page0, 4, 3290);
  page0[6] = 3;
  page0[7] = 25;
  writeI16(page0, 8, 48);
  writeI16(page0, 10, 20);
  page0[12] = 9;
  page0[13] = 15;
  page0[14] = 0b0000_0011;
  writeU32Mixed(page0, 30, 1_250_000);
  writeU32Mixed(page0, 34, 1_500_000);
  writeI16(page0, 42, 512);
  writeI16(page0, 48, 510);
  writeI16(page0, 50, 675);
  writeI16(page0, 52, 97);
  writeI16(page0, 54, -42);
  page0[56] = 0x12;
  page0[57] = 0x34;

  for (let cell = 0; cell < 16; cell += 1) {
    writeI16(page0, 98 + cell * 2, 3300 + cell);
  }
  for (let cell = 0; cell < 16; cell += 1) {
    writeI16(page1, 2 + cell * 2, 3320 + cell);
  }
  for (let temp = 0; temp < 16; temp += 1) {
    page2[100 + temp] = 21 + temp;
  }

  return [
    bytesToRegisters(page0),
    bytesToRegisters(page1),
    bytesToRegisters(page2),
    bytesToRegisters(page3),
  ];
}

test('BYD Battery skill manifest declares SecretRefs and read-only safety metadata', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, {
    name: 'byd-battery',
  });

  expect(
    manifest.credentials.map((credential) => credential.secretRef.id),
  ).toEqual([
    'BYD_BMU_HOST',
    'BYD_BMU_MODBUS_PORT',
    'BYD_BMU_UNIT_ID',
    'BYD_BMU_MODEL',
  ]);
  expect(skill).toContain('category: home-automation');
  expect(skill).toContain('state-of-charge');
  expect(skill).toContain('energy-counters');
  expect(skill).toContain('module-telemetry');
  expect(skill).toContain('be-connect-metadata');
  expect(skill).toContain('write-registers');
  expect(skill).toContain('writes: unavailable-v1');
  expect(skill).toContain('Read-only v1');
  expect(skill).toContain('https://github.com/christianh17/ioBroker.bydhvs');
  expect(skill).toContain(
    'https://github.com/smarthomeNG/plugins/tree/master/byd_bat',
  );
});

test('BYD helper --help exposes reads without secret or write flags', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('BYD Battery-Box skill helper');
  expect(result.stdout).toContain('state-of-charge');
  expect(result.stdout).toContain('module-telemetry');
  expect(result.stdout).toContain('be-connect-metadata');
  expect(result.stdout).toContain('energy-counters');
  expect(result.stdout).toContain('BYD_BMU_HOST');
  expect(result.stdout).not.toContain('--password');
  expect(result.stdout).not.toContain('write-register');
  expect(result.stdout).not.toContain('write-coil');
});

test('BYD helper publishes the bounded read register map only', () => {
  const payload = byd.buildRegisterMapPayload();

  expect(payload).toMatchObject({
    command: 'register-map',
    writesExposed: false,
    arbitraryRegisterReadsExposed: false,
  });
  expect(payload.ranges.state).toMatchObject({
    start: 0x0500,
    quantity: 0x0019,
  });
  expect(payload.ranges.system).toMatchObject({
    start: 0x0000,
    quantity: 0x0066,
  });
});

test('BYD state decode emits SoC, pack telemetry, alarms, R5, and R29 shapes', () => {
  const state = byd.decodeStateRegisters(fixtureStateRegisters());

  expect(state).toMatchObject({
    socPercent: 67,
    sohPercent: 98,
    packVoltageV: 51.2,
    outputVoltageV: 51.2,
    currentA: -12.5,
    packPowerW: -640,
    powerDirection: 'charging',
    maxCellVoltageMv: 3400,
    minCellVoltageMv: 3280,
    cellVoltageSpreadMv: 120,
    maxCellTemperatureC: 52,
    chargeEnergyKwh: 1234.5,
    dischargeEnergyKwh: 2345.6,
  });
  expect(state.alarmCodes).toEqual([
    { bit: 6, code: 'Cells Imbalance' },
    { bit: 10, code: 'Cell Over Voltage' },
  ]);
  expect(
    state.incidentCards.map((card: { type: string }) => card.type),
  ).toEqual(
    expect.arrayContaining([
      'cell-voltage-spread',
      'module-temperature-high',
      'cells-imbalance',
      'cell-over-voltage',
    ]),
  );

  const energy = byd.decodeOperation('energy-counters', {
    state: fixtureStateRegisters(),
  });
  expect(energy.r5Rollup).toMatchObject({
    system: 'R5',
    source: 'byd-battery',
    chargeEnergyKwh: 1234.5,
    dischargeEnergyKwh: 2345.6,
  });
});

test('BYD system decode emits inventory and firmware handoff data', () => {
  const system = byd.decodeSystemRegisters(fixtureSystemRegisters());

  expect(system).toMatchObject({
    serialNumber: 'PP3000000000000001',
    modelFamily: 'HVS',
    bmuFirmware: 'V1.2-A',
    bmuBankA: 'V1.2',
    bmuBankB: 'V1.3',
    bmsFirmware: 'V2.4-B',
    hardwareRevision: 'HW1',
    towers: 2,
    modulesPerTower: 3,
    totalModules: 6,
    gridTieDirection: 'OnGrid',
  });
});

test('BYD diagnostic pages decode per-module voltage and temperature summaries', () => {
  const system = byd.decodeSystemRegisters(fixtureSystemRegisters());
  const bms = byd.decodeBmsParametersRegisters(
    fixtureBmsParametersRegisters(),
    system,
  );
  const diagnostic = byd.decodeDiagnosticPages(fixtureDiagnosticPages(), {
    ...system,
    ...bms,
  });

  expect(bms).toMatchObject({
    inverterType: 17,
    inverterName: 'Fronius HV',
    batteryTypeCode: 1,
    modelFamily: 'HVM',
    cellsPerModule: 16,
    temperaturesPerModule: 8,
    totalCapacityKwh: 16.56,
  });
  expect(diagnostic).toMatchObject({
    maxCellVoltageMv: 3410,
    minCellVoltageMv: 3290,
    cellVoltageSpreadMv: 120,
    maxCellTemperatureC: 48,
    minCellTemperatureC: 20,
    balanceCellCount: 2,
    chargeEnergyKwh: 1250,
    dischargeEnergyKwh: 1500,
    socPercent: 67.5,
    currentA: -4.2,
    stateBitmap: 0x1234,
    diagnosticPagesRead: 4,
  });
  expect(diagnostic.modules).toEqual([
    expect.objectContaining({
      module: 1,
      cellsExpected: 16,
      cellsReported: 16,
      voltageMinMv: 3300,
      voltageMaxMv: 3315,
      voltageSpreadMv: 15,
      temperaturesExpected: 8,
      temperaturesReported: 8,
      temperatureMinC: 21,
      temperatureMaxC: 28,
    }),
    expect.objectContaining({
      module: 2,
      cellsExpected: 16,
      cellsReported: 16,
      voltageMinMv: 3320,
      voltageMaxMv: 3335,
      voltageSpreadMv: 15,
      temperaturesExpected: 8,
      temperaturesReported: 8,
      temperatureMinC: 29,
      temperatureMaxC: 36,
    }),
    expect.objectContaining({
      module: 3,
      cellsExpected: 16,
      cellsReported: 0,
      voltageMinMv: null,
      temperaturesReported: 0,
    }),
  ]);
});

test('BYD helper decodes mock allowlisted registers without leaking configured secrets', async () => {
  const payload = await byd.buildRequest(
    [
      '--format',
      'json',
      'read',
      'state-of-charge',
      '--mock-registers-json',
      JSON.stringify({ state: fixtureStateRegisters() }),
    ],
    {
      BYD_BMU_HOST: '192.0.2.55',
      BYD_BMU_MODBUS_PORT: '8080',
      BYD_BMU_UNIT_ID: '7',
      BYD_BMU_MODEL: 'Premium HVS',
    },
  );

  expect(payload).toMatchObject({
    command: 'read',
    operation: 'state-of-charge',
    via: 'local-modbus',
    data: {
      socPercent: 67,
      sohPercent: 98,
      packPowerW: -640,
      powerDirection: 'charging',
    },
    source: {
      hostSecretRef: 'BYD_BMU_HOST',
      portSecretRef: 'BYD_BMU_MODBUS_PORT',
      unitIdSecretRef: 'BYD_BMU_UNIT_ID',
    },
  });
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain('192.0.2.55');
  expect(serialized).not.toContain('Premium HVS');
});

test('BYD helper emits module telemetry and enriched inventory from diagnostic pages', async () => {
  const mockRegisters = {
    system: fixtureSystemRegisters(),
    bmsParameters: fixtureBmsParametersRegisters(),
    diagnosticPages: fixtureDiagnosticPages(),
  };
  const moduleTelemetry = await byd.buildRequest(
    [
      '--format',
      'json',
      'read',
      'module-telemetry',
      '--mock-registers-json',
      JSON.stringify(mockRegisters),
    ],
    {},
  );
  const inventory = await byd.buildRequest(
    [
      '--format',
      'json',
      'read',
      'inventory',
      '--mock-registers-json',
      JSON.stringify(mockRegisters),
    ],
    {},
  );

  expect(moduleTelemetry).toMatchObject({
    command: 'read',
    operation: 'module-telemetry',
    data: {
      modulesPerTower: 3,
      cellsPerModule: 16,
      temperaturesPerModule: 8,
      balance: {
        cellCount: 2,
      },
      towerSummary: {
        socPercent: 67.5,
        chargeEnergyKwh: 1250,
      },
    },
  });
  expect(moduleTelemetry.data.modules[0]).toMatchObject({
    module: 1,
    voltageMinMv: 3300,
    temperatureMaxC: 28,
  });
  expect(inventory).toMatchObject({
    data: {
      batteryType: {
        code: 1,
        family: 'HVM',
        totalCapacityKwh: 16.56,
      },
      inverter: {
        type: 17,
        name: 'Fronius HV',
      },
    },
  });
  expect(inventory.data.modules).toHaveLength(3);
});

test('BYD helper emits firmware and Be Connect Plus metadata without installer secrets', async () => {
  const mockRegisters = {
    system: fixtureSystemRegisters(),
    bmsParameters: fixtureBmsParametersRegisters(),
  };
  const firmware = await byd.buildRequest(
    [
      '--format',
      'json',
      'read',
      'firmware',
      '--mock-registers-json',
      JSON.stringify(mockRegisters),
    ],
    {},
  );
  const metadata = await byd.buildRequest(
    [
      '--format',
      'json',
      'read',
      'be-connect-metadata',
      '--mock-registers-json',
      JSON.stringify(mockRegisters),
    ],
    {},
  );

  expect(firmware).toMatchObject({
    command: 'read',
    operation: 'firmware',
    data: {
      serialNumber: 'PP3000000000000001',
      bmuFirmware: 'V1.2-A',
      bmsFirmware: 'V2.4-B',
      hardwareRevision: 'HW1',
      batteryTypeCode: 1,
      inverterName: 'Fronius HV',
      beConnectPlus: {
        status: 'metadata-only',
      },
    },
  });
  expect(metadata).toMatchObject({
    command: 'read',
    operation: 'be-connect-metadata',
    data: {
      status: 'metadata-only',
      source: 'local-bmu-registers',
      publicBeConnectPlusApiAvailable: false,
      serialNumber: 'PP3000000000000001',
      topology: {
        towers: 2,
        modulesPerTower: 3,
        totalModules: 6,
      },
    },
  });
  const serialized = JSON.stringify({ firmware, metadata });
  expect(serialized).not.toContain('installer');
  expect(serialized).not.toContain('password');
});

test('BYD helper pins unit ids and rejects arbitrary register ranges', () => {
  const request = byd.buildModbusReadRequest(17, 0x0500, 0x0019, 42);

  expect(request.readUInt16BE(0)).toBe(42);
  expect(request.readUInt8(6)).toBe(17);
  expect(request.readUInt8(7)).toBe(3);
  expect(request.readUInt16BE(8)).toBe(0x0500);
  expect(request.readUInt16BE(10)).toBe(0x0019);
  expect(() => byd.parseUnitId('1,2')).toThrow(/integer/);
  expect(() => byd.buildModbusReadRequest(1, 0x1234, 1)).toThrow(
    /not allowlisted/,
  );
});

test('BYD helper rejects arbitrary register passthrough commands', () => {
  const result = runHelper([
    '--format',
    'json',
    'read-register',
    '--address',
    '0x0500',
  ]);

  expect(result.status).toBe(1);
  const payload = JSON.parse(result.stdout);
  expect(payload.error.code).toBe('BYD_BATTERY_HELPER_ERROR');
  expect(payload.error.message).toContain('Unknown flag --address');
});

test('BYD helper delegates Fronius path and degrades cleanly when unconfigured', async () => {
  const fronius = await byd.buildRequest(
    ['read', 'state-of-charge', '--via', 'fronius'],
    {},
  );
  const unconfigured = await byd.buildRequest(['read', 'state-of-charge'], {});

  expect(fronius).toMatchObject({
    command: 'read',
    via: 'fronius',
    status: 'delegated',
    delegatedTo: {
      roadmapItem: 'R21.111',
      skillName: 'fronius',
      endpoint: 'local-power-flow',
    },
  });
  expect(unconfigured).toMatchObject({
    status: 'unconfigured',
    error: {
      code: 'BYD_BATTERY_NOT_CONFIGURED',
      missingSecretRefs: [
        'BYD_BMU_HOST',
        'BYD_BMU_MODBUS_PORT',
        'BYD_BMU_UNIT_ID',
      ],
    },
  });
});

test('BYD Modbus connection errors become R29 BMU comms-lost payloads', () => {
  const result = runHelper(
    [
      '--format',
      'json',
      '--timeout-ms',
      '250',
      'read',
      'state-of-charge',
      '--via',
      'local',
    ],
    {
      BYD_BMU_HOST: '127.0.0.1',
      BYD_BMU_MODBUS_PORT: '9',
      BYD_BMU_UNIT_ID: '1',
    },
  );

  expect(result.status).toBe(3);
  const payload = JSON.parse(result.stdout);
  expect(payload.error.code).toBe('BYD_BMU_COMMS_LOST');
  expect(payload.incidentCards).toEqual([
    expect.objectContaining({
      system: 'R29',
      type: 'bmu-comms-lost',
      title: 'BMU comms lost',
    }),
  ]);
});
