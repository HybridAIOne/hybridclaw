#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 2) {
    throw new Error(
      'Usage: node skills/pptx/scripts/thumbnail.cjs <input_path> <output_dir> [--count 8] [--json]',
    );
  }
  const options = {
    inputPath: path.resolve(args[0]),
    outputDir: path.resolve(args[1]),
    count: 8,
    asJson: false,
  };
  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === '--json') {
      options.asJson = true;
      continue;
    }
    if (args[index] === '--count' && args[index + 1]) {
      options.count = Math.max(1, Number.parseInt(args[index + 1], 10) || 8);
      index += 1;
    }
  }
  return options;
}

function emit(payload, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (payload.success) {
    process.stdout.write(
      `Rendered ${Array.isArray(payload.artifacts) ? payload.artifacts.length : 0} thumbnail(s).\n`,
    );
    return;
  }
  process.stdout.write(`${payload.error || 'Thumbnail generation failed.'}\n`);
}

function main() {
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

  if (!fs.existsSync(options.inputPath) || !fs.statSync(options.inputPath).isFile()) {
    emit(
      {
        success: false,
        error: `File does not exist: ${options.inputPath}`,
      },
      options.asJson,
    );
    return 1;
  }

  const pdftoppmCheck = spawnSync('sh', ['-lc', 'command -v pdftoppm'], {
    encoding: 'utf8',
  });
  if (pdftoppmCheck.status !== 0) {
    emit(
      {
        success: false,
        error: '`pdftoppm` is not installed.',
      },
      options.asJson,
    );
    return 1;
  }

  fs.mkdirSync(options.outputDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-pptx-thumb-'));
  try {
    const sofficeScript = path.resolve('skills/office/soffice.cjs');
    const officeResult = spawnSync(
      process.execPath,
      [
        sofficeScript,
        'convert',
        options.inputPath,
        tempDir,
        '--format',
        'pdf',
        '--json',
      ],
      { encoding: 'utf8' },
    );
    if (officeResult.status !== 0) {
      emit(
        {
          success: false,
          error:
            officeResult.stderr.trim() ||
            officeResult.stdout.trim() ||
            'LibreOffice PDF export failed.',
        },
        options.asJson,
      );
      return 1;
    }

    let officePayload;
    try {
      officePayload = JSON.parse(officeResult.stdout);
    } catch (error) {
      emit(
        {
          success: false,
          error: `Invalid office conversion JSON output: ${error instanceof Error ? error.message : String(error)}`,
        },
        options.asJson,
      );
      return 1;
    }

    const pdfPath = path.resolve(String(officePayload.output_path || ''));
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      emit(
        {
          success: false,
          error: 'LibreOffice conversion did not produce a PDF.',
        },
        options.asJson,
      );
      return 1;
    }

    const prefix = path.join(options.outputDir, 'slide');
    const renderResult = spawnSync(
      'pdftoppm',
      [
        '-png',
        '-f',
        '1',
        '-l',
        String(options.count),
        pdfPath,
        prefix,
      ],
      { encoding: 'utf8' },
    );
    if (renderResult.status !== 0) {
      emit(
        {
          success: false,
          error:
            renderResult.stderr.trim() ||
            renderResult.stdout.trim() ||
            'pdftoppm failed.',
        },
        options.asJson,
      );
      return 1;
    }

    const artifacts = fs
      .readdirSync(options.outputDir)
      .filter((name) => /^slide-\d+\.png$/i.test(name))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .map((name) => ({
        path: path.join(options.outputDir, name),
        filename: name,
        mimeType: 'image/png',
      }));

    emit({ success: true, artifacts }, options.asJson);
    return 0;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

process.exitCode = main();
