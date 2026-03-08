#!/usr/bin/env node

import fs from 'node:fs/promises';
import process from 'node:process';

import { extractFormFieldInfo } from './_pdf_form_runtime.mjs';

function parseArgs(argv) {
  const args = {
    inputPath: '',
    outputPath: '',
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (value === '--json') {
      args.json = true;
      continue;
    }
    if (!args.inputPath) {
      args.inputPath = value;
      continue;
    }
    if (!args.outputPath) {
      args.outputPath = value;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inputPath) {
    console.error(
      'Usage: node skills/pdf/scripts/extract_form_field_info.mjs <input.pdf> [output.json] [--json]',
    );
    process.exitCode = 1;
    return;
  }

  const result = await extractFormFieldInfo(args.inputPath);

  if (args.outputPath) {
    await fs.writeFile(
      args.outputPath,
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
    console.log(`Wrote ${result.length} fields to ${args.outputPath}`);
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
