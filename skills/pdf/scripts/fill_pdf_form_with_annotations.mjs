#!/usr/bin/env node

import fs from 'node:fs/promises';
import process from 'node:process';

import { PDFDocument } from 'pdf-lib';

import {
  pageInfoByNumber,
  parseRgbColor,
  resolveStandardFont,
  topOriginRectToPdfRect,
} from './_pdf_form_runtime.mjs';

async function fillPdfFormWithAnnotations(inputPath, fieldsData, outputPath) {
  const inputBytes = await fs.readFile(inputPath);
  const pdfDoc = await PDFDocument.load(inputBytes);
  const pages = pdfDoc.getPages();
  const pageData = pageInfoByNumber(fieldsData, pages);
  const fontCache = new Map();
  let annotationCount = 0;

  for (const field of fieldsData.form_fields || []) {
    const pageNumber = Number(field.page_number);
    const page = pages[pageNumber - 1];
    if (!page) continue;

    const entryText = field.entry_text;
    if (!entryText || typeof entryText !== 'object' || !entryText.text)
      continue;

    const pageInfo = pageData.get(pageNumber);
    const pageSize = page.getSize();
    const rect = topOriginRectToPdfRect(
      field.entry_bounding_box,
      pageInfo,
      pageSize,
    );
    const font = await resolveStandardFont(pdfDoc, entryText.font, fontCache);
    const fontSize = Number(entryText.font_size || 14);
    const lineHeight = Math.max(fontSize + 2, fontSize * 1.2);
    const text = String(entryText.text);
    const x = rect.left + 2;
    const y = Math.max(rect.bottom + 2, rect.top - fontSize - 2);

    page.drawText(text, {
      x,
      y,
      font,
      size: fontSize,
      color: parseRgbColor(entryText.font_color),
      lineHeight,
      maxWidth: Math.max(1, rect.right - rect.left - 4),
    });
    annotationCount += 1;
  }

  await fs.writeFile(outputPath, await pdfDoc.save());
  return { outputPath, annotationCount };
}

async function main() {
  const inputPath = process.argv[2] || '';
  const fieldsPath = process.argv[3] || '';
  const outputPath = process.argv[4] || '';

  if (!inputPath || !fieldsPath || !outputPath) {
    console.error(
      'Usage: node skills/pdf/scripts/fill_pdf_form_with_annotations.mjs <input.pdf> <fields.json> <output.pdf>',
    );
    process.exitCode = 1;
    return;
  }

  const fieldsData = JSON.parse(await fs.readFile(fieldsPath, 'utf8'));
  const result = await fillPdfFormWithAnnotations(
    inputPath,
    fieldsData,
    outputPath,
  );
  console.log(`Successfully filled PDF form and saved to ${result.outputPath}`);
  console.log(`Added ${result.annotationCount} text overlays`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
