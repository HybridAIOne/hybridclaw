#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ExcelJS = require('exceljs');
const iconv = require('iconv-lite');
const { parse } = require('csv-parse/sync');

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 2) {
    throw new Error(
      'Usage: node skills/xlsx/scripts/import_delimited.cjs <input_path> <output_path> [--sheet-name "Imported Data"] [--delimiter auto] [--encoding auto] [--no-header] [--json]',
    );
  }

  const options = {
    inputPath: path.resolve(args[0]),
    outputPath: path.resolve(args[1]),
    sheetName: 'Imported Data',
    delimiter: 'auto',
    encoding: 'auto',
    noHeader: false,
    asJson: false,
  };

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.asJson = true;
      continue;
    }
    if (arg === '--no-header') {
      options.noHeader = true;
      continue;
    }
    if (
      (arg === '--sheet-name' ||
        arg === '--delimiter' ||
        arg === '--encoding') &&
      args[index + 1]
    ) {
      const next = args[index + 1];
      if (arg === '--sheet-name') options.sheetName = next;
      if (arg === '--delimiter') options.delimiter = next;
      if (arg === '--encoding') options.encoding = next;
      index += 1;
    }
  }

  return options;
}

function looksLikeUtf16(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 256));
  if (sample.length < 4) return null;
  let evenNulls = 0;
  let oddNulls = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] !== 0) continue;
    if (index % 2 === 0) evenNulls += 1;
    else oddNulls += 1;
  }
  if (oddNulls > sample.length / 8) return 'utf16le';
  if (evenNulls > sample.length / 8) return 'utf16be';
  return null;
}

function decodeBuffer(buffer, encoding) {
  if (encoding !== 'auto') {
    return {
      decoded: iconv.decode(buffer, encoding),
      encodingUsed: encoding,
    };
  }

  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { decoded: buffer.toString('utf8'), encodingUsed: 'utf-8-sig' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return {
      decoded: iconv.decode(buffer, 'utf16le'),
      encodingUsed: 'utf-16le',
    };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return {
      decoded: iconv.decode(buffer, 'utf16be'),
      encodingUsed: 'utf-16be',
    };
  }

  const utf16Guess = looksLikeUtf16(buffer);
  if (utf16Guess) {
    return {
      decoded: iconv.decode(buffer, utf16Guess),
      encodingUsed: utf16Guess === 'utf16le' ? 'utf-16le' : 'utf-16be',
    };
  }

  const utf8 = buffer.toString('utf8');
  const replacementChars = (utf8.match(/\uFFFD/g) || []).length;
  if (replacementChars === 0) {
    return { decoded: utf8, encodingUsed: 'utf-8' };
  }

  return {
    decoded: iconv.decode(buffer, 'win1252'),
    encodingUsed: 'cp1252',
  };
}

function chooseDelimiter(sample, delimiter) {
  if (delimiter !== 'auto') {
    return delimiter === '\\t' ? '\t' : delimiter;
  }
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = sample.split(candidate).length;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function looksLikeHeader(row) {
  const cleaned = row.map((cell) => String(cell || '').trim());
  if (cleaned.length === 0) return false;
  if (new Set(cleaned).size !== cleaned.length) return false;
  let nonNumeric = 0;
  for (const cell of cleaned) {
    const normalized = cell.replace(/,/g, '');
    if (!normalized) {
      nonNumeric += 1;
      continue;
    }
    if (!Number.isFinite(Number(normalized))) {
      nonNumeric += 1;
    }
  }
  return nonNumeric >= Math.max(1, Math.floor(cleaned.length / 2));
}

function parseValue(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';

  const datePatterns = [
    /^(\d{4})-(\d{2})-(\d{2})$/,
    /^(\d{2})\.(\d{2})\.(\d{4})$/,
    /^(\d{2})\/(\d{2})\/(\d{4})$/,
  ];
  for (const pattern of datePatterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    if (pattern === datePatterns[0]) {
      return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
    }
    if (pattern === datePatterns[1]) {
      return new Date(`${match[3]}-${match[2]}-${match[1]}T00:00:00Z`);
    }
    return new Date(`${match[3]}-${match[1]}-${match[2]}T00:00:00Z`);
  }

  const normalized = trimmed.replace(/,/g, '');
  if (/^-?\d+(\.\d+)?$/.test(normalized)) {
    return normalized.includes('.')
      ? Number.parseFloat(normalized)
      : Number.parseInt(normalized, 10);
  }

  return trimmed;
}

function formatHeaderRow(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9EAF7' },
    };
    cell.alignment = { horizontal: 'center' };
  });
}

function setColumnWidths(worksheet) {
  worksheet.columns.forEach((column) => {
    let maxLength = 10;
    column.eachCell({ includeEmpty: true }, (cell) => {
      const raw = cell.value;
      const text =
        raw instanceof Date
          ? raw.toISOString().slice(0, 10)
          : raw == null
            ? ''
            : String(raw);
      maxLength = Math.max(maxLength, Math.min(40, text.length + 2));
    });
    column.width = maxLength;
  });
}

function emit(payload, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (payload.success) {
    process.stdout.write(`Wrote workbook to ${payload.output_path}\n`);
    return;
  }
  process.stdout.write(`${payload.error || 'Import failed.'}\n`);
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

  if (
    !fs.existsSync(options.inputPath) ||
    !fs.statSync(options.inputPath).isFile()
  ) {
    emit(
      {
        success: false,
        error: `File does not exist: ${options.inputPath}`,
      },
      options.asJson,
    );
    return 1;
  }

  const raw = fs.readFileSync(options.inputPath);
  const { decoded, encodingUsed } = decodeBuffer(raw, options.encoding);
  const delimiter = chooseDelimiter(decoded.slice(0, 4096), options.delimiter);
  const rows = parse(decoded, {
    bom: true,
    columns: false,
    delimiter,
    relax_column_count: true,
    skip_empty_lines: false,
    trim: false,
  });

  if (!Array.isArray(rows) || rows.length === 0) {
    emit(
      {
        success: false,
        error: 'Input file is empty.',
      },
      options.asJson,
    );
    return 1;
  }

  const header =
    !options.noHeader && Array.isArray(rows[0]) && looksLikeHeader(rows[0])
      ? rows[0].map((value) => String(value ?? ''))
      : null;

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(
    (options.sheetName || 'Imported Data').slice(0, 31) || 'Imported Data',
  );

  const startIndex = header ? 1 : 0;
  if (header) {
    worksheet.addRow(header);
    formatHeaderRow(worksheet.getRow(1));
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: header.length || 1 },
    };
  }

  for (const row of rows.slice(startIndex)) {
    worksheet.addRow(
      Array.isArray(row)
        ? row.map((value) => parseValue(value))
        : [parseValue(row)],
    );
  }

  setColumnWidths(worksheet);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  await workbook.xlsx.writeFile(options.outputPath);

  emit(
    {
      success: true,
      encoding: encodingUsed,
      delimiter: delimiter === '\t' ? '\\t' : delimiter,
      header_detected: Boolean(header),
      row_count: rows.length - (header ? 1 : 0),
      column_count: rows.reduce(
        (max, row) => Math.max(max, Array.isArray(row) ? row.length : 1),
        0,
      ),
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
