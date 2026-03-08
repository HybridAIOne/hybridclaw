#!/usr/bin/env node

import process from 'node:process';

import { hasFillableFields } from './_pdf_form_runtime.mjs';

async function main() {
  const inputPath = process.argv[2] || '';
  if (!inputPath) {
    console.error(
      'Usage: node skills/pdf/scripts/check_fillable_fields.mjs <input.pdf>',
    );
    process.exitCode = 1;
    return;
  }

  if (await hasFillableFields(inputPath)) {
    console.log('This PDF has fillable form fields');
  } else {
    console.log(
      'This PDF does not have fillable form fields; you will need to visually determine where to enter data',
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
