#!/usr/bin/env node

import fs from 'node:fs/promises';
import process from 'node:process';

import { fillFillableFields, loadJsonShape } from './_pdf_form_runtime.mjs';

function parseArgs(argv) {
  const args = {
    inputPath: '',
    valuesPath: '',
    outputPath: '',
    flatten: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (value === '--flatten') {
      args.flatten = true;
      continue;
    }
    if (!args.inputPath) {
      args.inputPath = value;
      continue;
    }
    if (!args.valuesPath) {
      args.valuesPath = value;
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
  if (!args.inputPath || !args.valuesPath || !args.outputPath) {
    console.error(
      'Usage: node skills/pdf/scripts/fill_fillable_fields.mjs <input.pdf> <field-values.json> <output.pdf> [--flatten]',
    );
    process.exitCode = 1;
    return;
  }

  const rawFields = JSON.parse(await fs.readFile(args.valuesPath, 'utf8'));
  const fieldValues = loadJsonShape(rawFields);
  if (!Array.isArray(fieldValues)) {
    throw new Error('Field values JSON must be an array');
  }

  const result = await fillFillableFields(
    args.inputPath,
    fieldValues,
    args.outputPath,
    {
      flatten: args.flatten,
    },
  );
  console.log(`Successfully filled PDF form and saved to ${result.outputPath}`);
  console.log(`Updated ${result.updatedCount} field(s)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
