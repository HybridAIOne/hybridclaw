import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';
import XlsxPopulate from 'xlsx-populate';
import { useTempDir } from './test-utils.ts';

const repoRoot = process.cwd();

const makeTempDir = useTempDir('hybridclaw-xlsx-test-');

function runNodeScript(args: string[]) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `Command failed: node ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return result;
}

test('xlsx import script converts delimited input into a formatted workbook', async () => {
  const dir = makeTempDir();
  const inputPath = path.join(dir, 'input.csv');
  const outputPath = path.join(dir, 'output.xlsx');

  fs.writeFileSync(
    inputPath,
    ['Name,Amount,When', 'Alice,12.5,2026-03-29', 'Bob,7,2026-03-30'].join(
      '\n',
    ),
    'utf8',
  );

  const result = runNodeScript([
    'skills/xlsx/scripts/import_delimited.cjs',
    inputPath,
    outputPath,
    '--json',
  ]);

  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    success: true,
    delimiter: ',',
    header_detected: true,
    row_count: 2,
    output_path: outputPath,
  });
  expect(fs.existsSync(outputPath)).toBe(true);

  const workbook = await XlsxPopulate.fromFileAsync(outputPath);
  const sheet = workbook.sheet('Imported Data');

  expect(sheet.cell('A1').value()).toBe('Name');
  expect(sheet.cell('A2').value()).toBe('Alice');
  expect(sheet.cell('B2').value()).toBe(12.5);
  expect(sheet.cell('C2').style('numberFormat')).toBe('yyyy-mm-dd');
  expect(sheet.cell('A1').style('bold')).toBe(true);
  expect(sheet.column('A').width()).toBeGreaterThanOrEqual(10);
  expect(sheet.autoFilter()).toBeTruthy();
});

describe('xlsx create script', () => {
  test('creates a workbook from headers and rows', async () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'created.xlsx');

    const result = runNodeScript([
      'skills/xlsx/scripts/create_xlsx.cjs',
      outputPath,
      '--headers',
      'Name,Age,City',
      '--rows',
      'Alice,30,NYC;Bob,25,LA',
      '--json',
    ]);

    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      success: true,
      sheet_name: 'Sheet1',
      row_count: 2,
      column_count: 3,
      output_path: outputPath,
    });
    expect(fs.existsSync(outputPath)).toBe(true);

    const workbook = await XlsxPopulate.fromFileAsync(outputPath);
    const sheet = workbook.sheet('Sheet1');

    expect(sheet.cell('A1').value()).toBe('Name');
    expect(sheet.cell('B1').value()).toBe('Age');
    expect(sheet.cell('C1').value()).toBe('City');
    expect(sheet.cell('A2').value()).toBe('Alice');
    expect(sheet.cell('B2').value()).toBe(30);
    expect(sheet.cell('C2').value()).toBe('NYC');
    expect(sheet.cell('A3').value()).toBe('Bob');
    expect(sheet.cell('B3').value()).toBe(25);

    // Professional styling checks
    expect(sheet.cell('A1').style('bold')).toBe(true);
    expect(sheet.cell('A1').style('fill').color).toMatchObject({
      rgb: 'D9EAF7',
    });
    expect(sheet.column('A').width()).toBeGreaterThanOrEqual(10);
    expect(sheet.autoFilter()).toBeTruthy();
  });

  test('creates a workbook from JSON data', async () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'json-created.xlsx');

    const jsonData = JSON.stringify([
      { Name: 'Alice', Age: 30, City: 'NYC' },
      { Name: 'Bob', Age: 25, City: 'LA' },
    ]);

    const result = runNodeScript([
      'skills/xlsx/scripts/create_xlsx.cjs',
      outputPath,
      '--json-data',
      jsonData,
      '--json',
    ]);

    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      success: true,
      row_count: 2,
      column_count: 3,
    });

    const workbook = await XlsxPopulate.fromFileAsync(outputPath);
    const sheet = workbook.sheet(0);

    // Headers inferred from JSON keys
    expect(sheet.cell('A1').value()).toBe('Name');
    expect(sheet.cell('B1').value()).toBe('Age');
    expect(sheet.cell('C1').value()).toBe('City');

    // Data values
    expect(sheet.cell('A2').value()).toBe('Alice');
    expect(sheet.cell('B2').value()).toBe(30);
    expect(sheet.cell('C2').value()).toBe('NYC');
    expect(sheet.cell('A1').style('bold')).toBe(true);
  });

  test('preserves formulas in cell values', async () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'formulas.xlsx');

    runNodeScript([
      'skills/xlsx/scripts/create_xlsx.cjs',
      outputPath,
      '--headers',
      'Revenue,Cost,Profit',
      '--rows',
      '120000,45000,=A2-B2',
      '--json',
    ]);

    const workbook = await XlsxPopulate.fromFileAsync(outputPath);
    const sheet = workbook.sheet(0);

    expect(sheet.cell('A2').value()).toBe(120000);
    expect(sheet.cell('B2').value()).toBe(45000);
    expect(sheet.cell('C2').formula()).toBe('A2-B2');
  });

  test('applies custom sheet name', async () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'named.xlsx');

    runNodeScript([
      'skills/xlsx/scripts/create_xlsx.cjs',
      outputPath,
      '--headers',
      'A,B',
      '--rows',
      '1,2',
      '--sheet-name',
      'Summary',
      '--json',
    ]);

    const workbook = await XlsxPopulate.fromFileAsync(outputPath);
    expect(workbook.sheet('Summary')).toBeTruthy();
    expect(workbook.sheet('Summary').cell('A1').value()).toBe('A');
  });

  test('auto-detects numeric values', async () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'numbers.xlsx');

    runNodeScript([
      'skills/xlsx/scripts/create_xlsx.cjs',
      outputPath,
      '--headers',
      'Int,Float,Text',
      '--rows',
      '42,3.14,hello',
      '--json',
    ]);

    const workbook = await XlsxPopulate.fromFileAsync(outputPath);
    const sheet = workbook.sheet(0);

    expect(sheet.cell('A2').value()).toBe(42);
    expect(typeof sheet.cell('A2').value()).toBe('number');
    expect(sheet.cell('B2').value()).toBe(3.14);
    expect(typeof sheet.cell('B2').value()).toBe('number');
    expect(sheet.cell('C2').value()).toBe('hello');
    expect(typeof sheet.cell('C2').value()).toBe('string');
  });
});
