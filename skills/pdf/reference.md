# PDF JS Reference

This reference covers the bundled Node/JS PDF stack used by this skill.

## Bundled Runtime

The supported PDF runtime is:

- `pdfjs-dist` for text extraction and page rendering
- `pdf-lib` for PDF creation, merging, splitting, and form work
- `@napi-rs/canvas` for image output and validation overlays

If a task cannot be done with those libraries, it is outside the guaranteed path of this skill.

## Bundled Scripts

### Extract page text

```bash
node skills/pdf/scripts/extract_pdf_text.mjs document.pdf
node skills/pdf/scripts/extract_pdf_text.mjs document.pdf --json
node skills/pdf/scripts/extract_pdf_text.mjs document.pdf --pages 1,3-5 --json
```

### Render page images

```bash
node skills/pdf/scripts/render_pdf_pages.mjs input.pdf out-images
node skills/pdf/scripts/render_pdf_pages.mjs input.pdf out-images --pages 1-2
node skills/pdf/scripts/render_pdf_pages.mjs input.pdf out-images --max-dimension 1800
```

### Inspect fillable fields

```bash
node skills/pdf/scripts/check_fillable_fields.mjs form.pdf
node skills/pdf/scripts/extract_form_field_info.mjs form.pdf field-info.json
```

### Fill native form fields

```bash
node skills/pdf/scripts/fill_fillable_fields.mjs input.pdf field-values.json filled.pdf
node skills/pdf/scripts/fill_fillable_fields.mjs input.pdf field-values.json filled.pdf --flatten
```

### Work with non-fillable forms

```bash
node skills/pdf/scripts/extract_form_structure.mjs input.pdf form-structure.json
node skills/pdf/scripts/check_bounding_boxes.mjs fields.json
node skills/pdf/scripts/create_validation_image.mjs 1 fields.json page-images/page_1.png validation-page-1.png
node skills/pdf/scripts/fill_pdf_form_with_annotations.mjs input.pdf fields.json filled.pdf
```

## `pdf-lib` Recipes

### Merge PDFs

```js
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";

const merged = await PDFDocument.create();

for (const inputPath of ["part-1.pdf", "part-2.pdf", "appendix.pdf"]) {
  const input = await PDFDocument.load(fs.readFileSync(inputPath));
  const pages = await merged.copyPages(input, input.getPageIndices());
  for (const page of pages) merged.addPage(page);
}

fs.writeFileSync("merged.pdf", await merged.save());
```

### Split a PDF into single pages

```js
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";

const source = await PDFDocument.load(fs.readFileSync("input.pdf"));

for (const [index] of source.getPages().entries()) {
  const output = await PDFDocument.create();
  const [page] = await output.copyPages(source, [index]);
  output.addPage(page);
  fs.writeFileSync(`page-${index + 1}.pdf`, await output.save());
}
```

### Copy selected pages into a new PDF

```js
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";

const source = await PDFDocument.load(fs.readFileSync("source.pdf"));
const output = await PDFDocument.create();
const pages = await output.copyPages(source, [0, 2, 4]);

for (const page of pages) output.addPage(page);

fs.writeFileSync("selected-pages.pdf", await output.save());
```

### Add a text watermark

```js
import fs from "node:fs";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

const pdfDoc = await PDFDocument.load(fs.readFileSync("input.pdf"));
const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

for (const page of pdfDoc.getPages()) {
  const { width, height } = page.getSize();
  page.drawText("CONFIDENTIAL", {
    x: width * 0.18,
    y: height * 0.5,
    size: 42,
    font,
    color: rgb(0.8, 0.1, 0.1),
    rotate: degrees(32),
    opacity: 0.35,
  });
}

fs.writeFileSync("watermarked.pdf", await pdfDoc.save());
```

## Troubleshooting

### Text extraction returns too little text

Use the page renderer next:

```bash
node skills/pdf/scripts/render_pdf_pages.mjs input.pdf /tmp/pdf-pages
```

Then inspect the resulting images.

### A form field is hard to map visually

Use both:

```bash
node skills/pdf/scripts/extract_form_field_info.mjs input.pdf field-info.json
node skills/pdf/scripts/render_pdf_pages.mjs input.pdf page-images
```

Match each `rect` to the rendered page image.

### A non-fillable overlay lands in the wrong place

Check the source-space declaration first:

- use `pdf_width` / `pdf_height` when coordinates are based on the PDF page size
- use `image_width` / `image_height` when coordinates are based on a rendered image

Then re-run:

```bash
node skills/pdf/scripts/check_bounding_boxes.mjs fields.json
node skills/pdf/scripts/create_validation_image.mjs 1 fields.json page-images/page_1.png validation-page-1.png
```

### A script fails because a bundled package is missing

That is a runtime packaging bug, not a reason to switch to Python. Fix the bundled Node runtime first.

## Out of Scope

These are not part of the bundled PDF skill path:

- OCR
- encrypted PDF handling
- broken PDF repair
- external CLI-only workflows
