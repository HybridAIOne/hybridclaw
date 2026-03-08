import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, test } from 'vitest';

const repoRoot = process.cwd();
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-pdf-test-'));
  tempDirs.push(dir);
  return dir;
}

function runNodeScript(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `Command failed: node ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return result;
}

async function createFillablePdf(outputPath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([400, 400]);
  page.drawText('Last Name', { x: 50, y: 330, size: 12 });
  page.drawText('Adult', { x: 70, y: 282, size: 12 });
  page.drawText('Country', { x: 50, y: 252, size: 12 });
  page.drawText('Citizenship', { x: 50, y: 202, size: 12 });

  const form = pdfDoc.getForm();
  const text = form.createTextField('last_name');
  text.addToPage(page, { x: 140, y: 320, width: 140, height: 24 });

  const checkBox = form.createCheckBox('is_adult');
  checkBox.addToPage(page, { x: 50, y: 280, width: 12, height: 12 });

  const dropdown = form.createDropdown('country');
  dropdown.addOptions(['DE', 'US']);
  dropdown.addToPage(page, { x: 140, y: 245, width: 120, height: 24 });

  const radio = form.createRadioGroup('citizenship');
  radio.addOptionToPage('US', page, { x: 50, y: 200, width: 12, height: 12 });
  radio.addOptionToPage('Other', page, {
    x: 100,
    y: 200,
    width: 12,
    height: 12,
  });

  fs.writeFileSync(outputPath, await pdfDoc.save());
}

async function createPlainPdf(outputPath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([400, 400]);
  page.drawText('Last Name', { x: 50, y: 330, size: 12 });
  page.drawText('Country', { x: 50, y: 280, size: 12 });
  page.drawText('Germany', { x: 140, y: 280, size: 12 });
  fs.writeFileSync(outputPath, await pdfDoc.save());
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('PDF skill docs', () => {
  test('document only the bundled Node workflow', () => {
    const docs = [
      fs.readFileSync(path.join(repoRoot, 'skills/pdf/SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(repoRoot, 'skills/pdf/forms.md'), 'utf8'),
      fs.readFileSync(path.join(repoRoot, 'skills/pdf/reference.md'), 'utf8'),
    ].join('\n');

    expect(docs).not.toMatch(/\bpython3\b/i);
    expect(docs).not.toMatch(/\bpypdf\b/i);
    expect(docs).not.toMatch(/\bpdfplumber\b/i);
    expect(docs).not.toMatch(/\bpdf2image\b/i);
    expect(docs).not.toMatch(/skills\/pdf\/scripts\/[A-Za-z0-9_-]+\.py\b/);
  });
});

describe('PDF skill Node scripts', () => {
  test('supports the fillable-form workflow end to end', async () => {
    const dir = makeTempDir();
    const inputPdf = path.join(dir, 'fillable.pdf');
    const fieldInfoPath = path.join(dir, 'field-info.json');
    const fieldValuesPath = path.join(dir, 'field-values.json');
    const outputPdf = path.join(dir, 'filled.pdf');

    await createFillablePdf(inputPdf);

    const fillableCheck = runNodeScript([
      'skills/pdf/scripts/check_fillable_fields.mjs',
      inputPdf,
    ]);
    expect(fillableCheck.stdout).toContain('This PDF has fillable form fields');

    runNodeScript([
      'skills/pdf/scripts/extract_form_field_info.mjs',
      inputPdf,
      fieldInfoPath,
    ]);

    const fieldInfo = JSON.parse(fs.readFileSync(fieldInfoPath, 'utf8'));
    expect(fieldInfo.map((field) => field.field_id)).toEqual(
      expect.arrayContaining([
        'last_name',
        'is_adult',
        'country',
        'citizenship',
      ]),
    );
    expect(
      fieldInfo.find((field) => field.field_id === 'is_adult'),
    ).toMatchObject({
      type: 'checkbox',
      checked_value: '/Yes',
      unchecked_value: '/Off',
    });
    expect(
      fieldInfo.find((field) => field.field_id === 'citizenship'),
    ).toMatchObject({
      type: 'radio_group',
    });

    fs.writeFileSync(
      fieldValuesPath,
      JSON.stringify(
        [
          { field_id: 'last_name', page: 1, value: 'Simpson' },
          { field_id: 'is_adult', page: 1, value: true },
          { field_id: 'country', page: 1, value: 'DE' },
          { field_id: 'citizenship', page: 1, value: 'Other' },
        ],
        null,
        2,
      ),
    );

    runNodeScript([
      'skills/pdf/scripts/fill_fillable_fields.mjs',
      inputPdf,
      fieldValuesPath,
      outputPdf,
    ]);

    expect(fs.existsSync(outputPdf)).toBe(true);

    const filledDoc = await PDFDocument.load(fs.readFileSync(outputPdf));
    const form = filledDoc.getForm();

    expect(form.getTextField('last_name').getText()).toBe('Simpson');
    expect(form.getCheckBox('is_adult').isChecked()).toBe(true);
    expect(form.getDropdown('country').getSelected()).toEqual(['DE']);
    expect(form.getRadioGroup('citizenship').getSelected()).toBe('Other');
  });

  test('supports the non-fillable overlay workflow end to end', async () => {
    const dir = makeTempDir();
    const inputPdf = path.join(dir, 'plain.pdf');
    const structurePath = path.join(dir, 'form-structure.json');
    const fieldsPath = path.join(dir, 'fields.json');
    const outputPdf = path.join(dir, 'overlay.pdf');

    await createPlainPdf(inputPdf);

    runNodeScript([
      'skills/pdf/scripts/extract_form_structure.mjs',
      inputPdf,
      structurePath,
    ]);

    const structure = JSON.parse(fs.readFileSync(structurePath, 'utf8'));
    expect(structure.labels.length).toBeGreaterThan(0);
    expect(structure.pages[0]).toMatchObject({
      page_number: 1,
      width: 400,
      height: 400,
    });

    fs.writeFileSync(
      fieldsPath,
      JSON.stringify(
        {
          pages: [{ page_number: 1, pdf_width: 400, pdf_height: 400 }],
          form_fields: [
            {
              page_number: 1,
              description: 'Last name field',
              field_label: 'Last Name',
              label_bounding_box: [48, 58, 112, 72],
              entry_bounding_box: [138, 54, 286, 80],
              entry_text: {
                text: 'Simpson',
                font_size: 12,
                font: 'Helvetica',
                font_color: '#000000',
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const validation = runNodeScript([
      'skills/pdf/scripts/check_bounding_boxes.mjs',
      fieldsPath,
    ]);
    expect(validation.stdout).toContain(
      'SUCCESS: All bounding boxes are valid',
    );

    runNodeScript([
      'skills/pdf/scripts/fill_pdf_form_with_annotations.mjs',
      inputPdf,
      fieldsPath,
      outputPdf,
    ]);

    expect(fs.existsSync(outputPdf)).toBe(true);
    expect(fs.statSync(outputPdf).size).toBeGreaterThan(
      fs.statSync(inputPdf).size,
    );
  });
});
