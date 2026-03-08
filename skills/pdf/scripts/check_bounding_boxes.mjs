#!/usr/bin/env node

import fs from 'node:fs/promises';
import process from 'node:process';

function rectsIntersect(left, right) {
  const disjointHorizontal = left[0] >= right[2] || left[2] <= right[0];
  const disjointVertical = left[1] >= right[3] || left[3] <= right[1];
  return !(disjointHorizontal || disjointVertical);
}

function getMessages(fieldsData) {
  const formFields = Array.isArray(fieldsData.form_fields)
    ? fieldsData.form_fields
    : [];
  const messages = [`Read ${formFields.length} fields`];
  const rects = [];

  for (const field of formFields) {
    rects.push({ rect: field.label_bounding_box, rectType: 'label', field });
    rects.push({ rect: field.entry_bounding_box, rectType: 'entry', field });
  }

  let hasError = false;
  for (let index = 0; index < rects.length; index += 1) {
    const left = rects[index];
    for (
      let rightIndex = index + 1;
      rightIndex < rects.length;
      rightIndex += 1
    ) {
      const right = rects[rightIndex];
      const samePage =
        Number(left.field.page_number) === Number(right.field.page_number);
      if (!samePage || !rectsIntersect(left.rect, right.rect)) continue;

      hasError = true;
      if (left.field === right.field) {
        messages.push(
          `FAILURE: intersection between label and entry bounding boxes for \`${left.field.description}\` (${JSON.stringify(left.rect)}, ${JSON.stringify(right.rect)})`,
        );
      } else {
        messages.push(
          `FAILURE: intersection between ${left.rectType} bounding box for \`${left.field.description}\` (${JSON.stringify(left.rect)}) and ${right.rectType} bounding box for \`${right.field.description}\` (${JSON.stringify(right.rect)})`,
        );
      }

      if (messages.length >= 20) {
        messages.push(
          'Aborting further checks; fix bounding boxes and try again',
        );
        return messages;
      }
    }

    if (left.rectType !== 'entry') continue;
    const fontSize = Number(left.field.entry_text?.font_size || 14);
    const entryHeight = Number(left.rect[3]) - Number(left.rect[1]);
    if (entryHeight < fontSize) {
      hasError = true;
      messages.push(
        `FAILURE: entry bounding box height (${entryHeight}) for \`${left.field.description}\` is too short for the text content (font size: ${fontSize}). Increase the box height or decrease the font size.`,
      );
      if (messages.length >= 20) {
        messages.push(
          'Aborting further checks; fix bounding boxes and try again',
        );
        return messages;
      }
    }
  }

  if (!hasError) messages.push('SUCCESS: All bounding boxes are valid');
  return messages;
}

async function main() {
  const inputPath = process.argv[2] || '';
  if (!inputPath) {
    console.error(
      'Usage: node skills/pdf/scripts/check_bounding_boxes.mjs <fields.json>',
    );
    process.exitCode = 1;
    return;
  }

  const fieldsData = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  for (const message of getMessages(fieldsData)) {
    console.log(message);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
