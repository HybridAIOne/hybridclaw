#!/usr/bin/env node

import fs from 'node:fs/promises';
import process from 'node:process';

import { openPdfDocument } from './_pdf_runtime.mjs';

function roundCoord(value) {
  return Math.round(Number(value) * 10) / 10;
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function groupLabelsByRow(labels) {
  const rows = [];

  for (const label of labels) {
    const tolerance = Math.max(3, (label.bottom - label.top) * 0.6);
    const previous = rows.at(-1);
    if (!previous || Math.abs(previous.top - label.top) > tolerance) {
      rows.push({
        page: label.page,
        top: label.top,
        bottom: label.bottom,
        labels: [label],
      });
      continue;
    }

    previous.labels.push(label);
    previous.top = Math.min(previous.top, label.top);
    previous.bottom = Math.max(previous.bottom, label.bottom);
  }

  return rows;
}

async function extractFormStructure(inputPath) {
  const pdf = await openPdfDocument(inputPath);
  const structure = {
    pages: [],
    labels: [],
    lines: [],
    checkboxes: [],
    row_boundaries: [],
  };

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    structure.pages.push({
      page_number: pageNumber,
      width: roundCoord(viewport.width),
      height: roundCoord(viewport.height),
    });

    const textContent = await page.getTextContent();
    const labels = textContent.items
      .map((item) => {
        if (!('str' in item)) return null;
        const text = normalizeText(item.str);
        if (!text) return null;
        const transform = Array.isArray(item.transform) ? item.transform : [];
        const x0 = Number(transform[4] || 0);
        const baselineY = Number(transform[5] || 0);
        const width = Number(item.width || 0);
        const height = Math.abs(Number(item.height || 0)) || 10;
        const top = viewport.height - baselineY - height;
        const bottom = top + height;
        return {
          page: pageNumber,
          text,
          x0: roundCoord(x0),
          top: roundCoord(top),
          x1: roundCoord(x0 + width),
          bottom: roundCoord(bottom),
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        if (left.top !== right.top) return left.top - right.top;
        return left.x0 - right.x0;
      });

    structure.labels.push(...labels);

    for (const row of groupLabelsByRow(labels)) {
      structure.row_boundaries.push({
        page: row.page,
        row_top: roundCoord(row.top),
        row_bottom: roundCoord(row.bottom),
        row_height: roundCoord(row.bottom - row.top),
      });
    }
  }

  return structure;
}

async function main() {
  const inputPath = process.argv[2] || '';
  const outputPath = process.argv[3] || '';

  if (!inputPath || !outputPath) {
    console.error(
      'Usage: node skills/pdf/scripts/extract_form_structure.mjs <input.pdf> <output.json>',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Extracting structure from ${inputPath}...`);
  const structure = await extractFormStructure(inputPath);
  await fs.writeFile(
    outputPath,
    `${JSON.stringify(structure, null, 2)}\n`,
    'utf8',
  );
  console.log('Found:');
  console.log(`  - ${structure.pages.length} pages`);
  console.log(`  - ${structure.labels.length} text labels`);
  console.log(`  - ${structure.lines.length} line candidates`);
  console.log(`  - ${structure.checkboxes.length} checkbox candidates`);
  console.log(`  - ${structure.row_boundaries.length} row boundaries`);
  console.log(`Saved to ${outputPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
