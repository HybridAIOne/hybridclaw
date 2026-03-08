#!/usr/bin/env node

import fs from 'node:fs/promises';
import process from 'node:process';

import { loadCanvas } from './_pdf_runtime.mjs';

async function main() {
  const pageNumber = Number.parseInt(process.argv[2] || '', 10);
  const fieldsPath = process.argv[3] || '';
  const inputImagePath = process.argv[4] || '';
  const outputImagePath = process.argv[5] || '';

  if (
    !Number.isFinite(pageNumber) ||
    !fieldsPath ||
    !inputImagePath ||
    !outputImagePath
  ) {
    console.error(
      'Usage: node skills/pdf/scripts/create_validation_image.mjs <page-number> <fields.json> <input.png> <output.png>',
    );
    process.exitCode = 1;
    return;
  }

  const { createCanvas, loadImage } = await loadCanvas();
  const fieldsData = JSON.parse(await fs.readFile(fieldsPath, 'utf8'));
  const sourceImage = await loadImage(inputImagePath);
  const canvas = createCanvas(sourceImage.width, sourceImage.height);
  const context = canvas.getContext('2d');

  context.drawImage(sourceImage, 0, 0, sourceImage.width, sourceImage.height);
  context.lineWidth = 2;

  let numBoxes = 0;
  for (const field of fieldsData.form_fields || []) {
    if (Number(field.page_number) !== pageNumber) continue;

    context.strokeStyle = 'rgba(0, 102, 255, 0.85)';
    const [labelX0, labelY0, labelX1, labelY1] = field.label_bounding_box;
    context.strokeRect(labelX0, labelY0, labelX1 - labelX0, labelY1 - labelY0);
    numBoxes += 1;

    context.strokeStyle = 'rgba(220, 38, 38, 0.9)';
    const [entryX0, entryY0, entryX1, entryY1] = field.entry_bounding_box;
    context.strokeRect(entryX0, entryY0, entryX1 - entryX0, entryY1 - entryY0);
    numBoxes += 1;
  }

  await fs.writeFile(outputImagePath, canvas.toBuffer('image/png'));
  console.log(
    `Created validation image at ${outputImagePath} with ${numBoxes} bounding boxes`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
