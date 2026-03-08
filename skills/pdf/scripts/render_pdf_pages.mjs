#!/usr/bin/env node

import process from 'node:process';

import { renderPdfPages } from './_pdf_runtime.mjs';

function parseArgs(argv) {
  const args = {
    inputPath: '',
    outputDir: '',
    pageNumbers: '',
    maxDimension: 1400,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (value === '--pages') {
      args.pageNumbers = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (value === '--max-dimension') {
      const parsed = Number.parseInt(argv[index + 1] || '', 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.maxDimension = parsed;
      }
      index += 1;
      continue;
    }
    if (!args.inputPath) {
      args.inputPath = value;
      continue;
    }
    if (!args.outputDir) {
      args.outputDir = value;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inputPath || !args.outputDir) {
    console.error(
      'Usage: node skills/pdf/scripts/render_pdf_pages.mjs <input.pdf> <output-dir> [--pages 1,3-5] [--max-dimension 1400]',
    );
    process.exitCode = 1;
    return;
  }

  const result = await renderPdfPages({
    inputPath: args.inputPath,
    outputDir: args.outputDir,
    pageNumbers: args.pageNumbers,
    maxDimension: args.maxDimension,
  });

  for (const filePath of result.written) {
    console.log(filePath);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
