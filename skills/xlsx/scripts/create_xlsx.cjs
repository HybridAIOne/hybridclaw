#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const XlsxPopulate = require('xlsx-populate');

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 1) {
    throw new Error(
      'Usage: node skills/xlsx/scripts/create_xlsx.cjs <output_path> --headers "A,B,C" --rows "1,2,3;4,5,6" [--sheet-name "Sheet1"] [--json-data \'[{"A":1}]\'] [--json]',
    );
  }

  const options = {
    outputPath: '',
    headers: null,
    rows: null,
    jsonData: null,
    sheetName: 'Sheet1',
    asJson: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.asJson = true;
      continue;
    }
    if (arg === '--headers' && args[index + 1]) {
      options.headers = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--rows' && args[index + 1]) {
      options.rows = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--json-data' && args[index + 1]) {
      options.jsonData = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--sheet-name' && args[index + 1]) {
      options.sheetName = args[index + 1];
      index += 1;
      continue;
    }
    if (!options.outputPath && !arg.startsWith('--')) {
      options.outputPath = path.resolve(arg);
    }
  }

  if (!options.outputPath) {
    throw new Error('Output path is required.');
  }

  if (!options.headers && !options.jsonData) {
    throw new Error(
      'Either --headers (with optional --rows) or --json-data is required.',
    );
  }

  return options;
}

function parseValue(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';

  const normalized = trimmed.replace(/,/g, '');
  if (/^-?\d+(\.\d+)?$/.test(normalized)) {
    return normalized.includes('.')
      ? Number.parseFloat(normalized)
      : Number.parseInt(normalized, 10);
  }

  return trimmed;
}

function normalizeSheetName(name) {
  const cleaned = String(name || 'Sheet1')
    .replace(/[\\/*?:[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 31) || 'Sheet1';
}

function formatHeaderRange(range) {
  range.style({
    bold: true,
    horizontalAlignment: 'center',
    fill: 'D9EAF7',
  });
}

function setColumnWidths(worksheet, rowCount, columnCount) {
  for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
    let maxLength = 10;
    for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
      const cell = worksheet.cell(rowIndex, columnIndex);
      const raw = cell.formula() || cell.value();
      const text = raw == null ? '' : String(raw);
      maxLength = Math.max(maxLength, Math.min(40, text.length + 2));
    }
    worksheet.column(columnIndex).width(maxLength);
  }
}

function setCellValue(cell, value) {
  const strValue = String(value ?? '').trim();
  if (strValue.startsWith('=')) {
    cell.formula(strValue.slice(1));
    return;
  }
  const parsed = parseValue(value);
  cell.value(parsed);
}

function emit(payload, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (payload.success) {
    process.stdout.write(`${payload.output_path}\n`);
    return;
  }
  process.stdout.write(`${payload.error || 'Creation failed.'}\n`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (error) {
    emit(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      true,
    );
    return 1;
  }

  let headers = [];
  let dataRows = [];

  if (options.jsonData) {
    let parsed;
    try {
      parsed = JSON.parse(options.jsonData);
    } catch (error) {
      emit(
        {
          success: false,
          error: `Invalid JSON data: ${error instanceof Error ? error.message : String(error)}`,
        },
        options.asJson,
      );
      return 1;
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      emit(
        {
          success: false,
          error: 'JSON data must be a non-empty array of objects.',
        },
        options.asJson,
      );
      return 1;
    }

    const keySet = new Set();
    for (const obj of parsed) {
      if (obj && typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
          keySet.add(key);
        }
      }
    }
    headers = [...keySet];
    dataRows = parsed.map((obj) => headers.map((key) => obj[key] ?? ''));
  } else {
    headers = options.headers.split(',').map((h) => h.trim());
    if (options.rows) {
      dataRows = options.rows.split(';').map((row) => row.split(','));
    }
  }

  const workbook = await XlsxPopulate.fromBlankAsync();
  const worksheet = workbook.sheet(0);
  worksheet.name(normalizeSheetName(options.sheetName));

  const columnCount = headers.length;

  // Write headers
  for (let colIdx = 0; colIdx < headers.length; colIdx += 1) {
    worksheet.cell(1, colIdx + 1).value(headers[colIdx]);
  }

  formatHeaderRange(worksheet.range(1, 1, 1, Math.max(1, columnCount)));
  worksheet.freezePanes('A2');
  worksheet.autoFilter(worksheet.range(1, 1, 1, Math.max(1, columnCount)));

  // Write data rows
  for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx += 1) {
    const row = dataRows[rowIdx];
    for (let colIdx = 0; colIdx < row.length; colIdx += 1) {
      setCellValue(worksheet.cell(rowIdx + 2, colIdx + 1), row[colIdx]);
    }
  }

  const totalRows = 1 + dataRows.length;
  setColumnWidths(worksheet, totalRows, Math.max(1, columnCount));

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  await workbook.toFileAsync(options.outputPath);

  emit(
    {
      success: true,
      sheet_name: normalizeSheetName(options.sheetName),
      row_count: dataRows.length,
      column_count: columnCount,
      output_path: options.outputPath,
    },
    options.asJson,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    emit(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      true,
    );
    process.exitCode = 1;
  },
);
