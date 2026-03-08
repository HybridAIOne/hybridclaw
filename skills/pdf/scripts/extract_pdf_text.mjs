#!/usr/bin/env node

import process from 'node:process';

import { extractPdfText } from './_pdf_runtime.mjs';

function parseArgs(argv) {
  const args = {
    inputPath: '',
    pageNumbers: '',
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (value === '--json') {
      args.json = true;
      continue;
    }
    if (value === '--pages') {
      args.pageNumbers = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (!args.inputPath) {
      args.inputPath = value;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inputPath) {
    console.error(
      'Usage: node skills/pdf/scripts/extract_pdf_text.mjs <input.pdf> [--pages 1,3-5] [--json]',
    );
    process.exitCode = 1;
    return;
  }

  const result = await extractPdfText(args.inputPath, args.pageNumbers);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  for (const page of result.pages) {
    console.log(`--- Page ${page.pageNumber} ---`);
    console.log(page.text || '[no extractable text]');
    if (page !== result.pages.at(-1)) console.log('');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
