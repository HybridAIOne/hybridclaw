import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';
import XlsxPopulate from 'xlsx-populate';

const repoRoot = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-xlsx-test-'));
  tempDirs.push(dir);
  return dir;
}

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

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

test('xlsx import script converts delimited input into a formatted workbook', async () => {
  const dir = makeTempDir();
  const inputPath = path.join(dir, 'input.csv');
  const outputPath = path.join(dir, 'output.xlsx');

  fs.writeFileSync(
    inputPath,
    ['Name,Amount,When', 'Alice,12.5,2026-03-29', 'Bob,7,2026-03-30'].join('\n'),
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
