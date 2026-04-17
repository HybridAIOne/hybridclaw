---
name: pdf
description: Extract text, render pages, inspect or fill forms, and overlay content on PDFs with bundled Node/JS tools.
user-invocable: true
disable-model-invocation: false
requires:
  bins:
    - node
metadata:
  hybridclaw:
    category: office
    short_description: "PDF text, forms, and overlays."
    tags:
      - pdf
      - documents
      - node
---
# PDF

Use this skill whenever the user mentions a `.pdf` file or asks to inspect, extract, summarize, render, or fill one.

This skill is intentionally **Node/JS-only** for supported workflows. Do not switch to Python, Poppler CLIs, browser tricks, local HTTP servers, `mdls`, `strings`, or ad-hoc PDF decompression unless the user explicitly asks you to debug the runtime itself.

## Supported Workflows

- **create new PDFs** with text content
- extract text from PDFs
- render PDF pages to PNG images
- extract invoice/document fields from PDF text
- inspect and fill native PDF form fields
- place text into non-fillable PDFs with explicit coordinates
- create validation overlays for non-fillable form coordinates
- merge or split PDFs with `pdf-lib`

## Non-Goals

The bundled skill does **not** guarantee:

- OCR
- encrypted/decrypted PDF workflows
- damaged/repair-oriented PDF recovery
- external CLI dependencies

If the user asks for one of those, state that it is outside the bundled Node workflow before considering anything else.

## Working Rules

- Assume commands run from the workspace root.
- If the current turn already includes extracted PDF text in an injected `<file>` block, use that text directly and answer. Do not rediscover the file.
- Use the bundled scripts in `skills/pdf/scripts/` first.
- For PDFs outside the workspace, keep the original absolute path when invoking the Node scripts from `bash`.
- For folder discovery outside the workspace, use `bash` with `find`. Do not use `glob`, ad-hoc Python file discovery, or browser tools.
- Use a **linear** workflow. Stop as soon as one step succeeds.
- Use `/tmp` for temporary output when page images are needed.
- For ordinary extraction tasks, do not probe `pdfinfo`, `pdftotext`, `pdftoppm`, `mdls`, `strings`, `qlmanage`, or browser tools.
- Before filling any form, read [forms.md](./forms.md).
- For advanced bundled JS patterns, read [reference.md](./reference.md).

## Current-Turn Attachment Rule

When the current turn already provides a single PDF attachment or local PDF path:

1. Use the supplied local path first.
2. Use the supplied CDN/remote URL only if no local path exists.
3. Run the bundled extractor once.
4. If the extracted text is usable, answer and stop.

Do **not** start with `glob "**/*.pdf"` or ad-hoc shell discovery for that case.

## Anti-Patterns

- Do not rewrite a single attached-file task into multi-step shell discovery.
- Do not keep searching after the first successful `extract_pdf_text.mjs` result.

## Default Extraction Workflow

For requests like:

- "extract data from these invoices"
- "read this PDF"
- "summarize this PDF"
- "get the text from these PDFs"

follow this exact order:

0. If the current turn already includes extracted `<file>` content for the PDF, parse that and answer. Stop there.
1. Discover candidate PDFs.
```bash
find "/absolute/path" -type f \( -iname '*.pdf' -o -iname '*.PDF' \) | sort
```
2. Run the bundled Node text extractor.
```bash
node skills/pdf/scripts/extract_pdf_text.mjs document.pdf --json
```
3. If the returned text is usable, parse it and answer. Stop there.
4. If the returned text is empty or clearly insufficient, render page images.
```bash
node skills/pdf/scripts/render_pdf_pages.mjs document.pdf /tmp/pdf-pages
```
5. Only then use image or vision tooling on the rendered PNGs.

## Bundled Scripts

### Create a New PDF

```bash
node skills/pdf/scripts/create_pdf.mjs output.pdf --text "Hello World"
node skills/pdf/scripts/create_pdf.mjs output.pdf --title "Heading" --text "Body content"
node skills/pdf/scripts/create_pdf.mjs output.pdf --text "Line 1\nLine 2" --font-size 18
```

For creation tasks ("make a PDF", "create a PDF with X"), always use this bundled
script or the recipe from [reference.md](./reference.md). Never call `drawText()`
without passing an embedded `font` — omitting it produces a blank/corrupt page.

### Text Extraction

```bash
node skills/pdf/scripts/extract_pdf_text.mjs input.pdf
node skills/pdf/scripts/extract_pdf_text.mjs input.pdf --json
node skills/pdf/scripts/extract_pdf_text.mjs input.pdf --pages 1,3-5 --json
```

### Page Rendering

```bash
node skills/pdf/scripts/render_pdf_pages.mjs input.pdf out-images
node skills/pdf/scripts/render_pdf_pages.mjs input.pdf out-images --pages 1-2
```

### Fillable Form Detection

```bash
node skills/pdf/scripts/check_fillable_fields.mjs form.pdf
```

### Fillable Form Metadata

```bash
node skills/pdf/scripts/extract_form_field_info.mjs input.pdf field-info.json
```

### Fill Fillable Form Fields

```bash
node skills/pdf/scripts/fill_fillable_fields.mjs input.pdf field-values.json filled.pdf
node skills/pdf/scripts/fill_fillable_fields.mjs input.pdf field-values.json filled.pdf --flatten
```

### Non-Fillable Form Structure / Validation

```bash
node skills/pdf/scripts/extract_form_structure.mjs input.pdf form-structure.json
node skills/pdf/scripts/check_bounding_boxes.mjs fields.json
node skills/pdf/scripts/create_validation_image.mjs 1 fields.json page-images/page_1.png validation-page-1.png
node skills/pdf/scripts/fill_pdf_form_with_annotations.mjs input.pdf fields.json filled.pdf
```

## Form Workflows

Always read [forms.md](./forms.md) before filling a PDF. The supported form workflows are:

- fillable forms via extracted field metadata
- non-fillable forms via rendered pages plus top-origin coordinate boxes

## Advanced JS Operations

For merge, split, and page-copy operations, use `pdf-lib` snippets from [reference.md](./reference.md).

## Troubleshooting Boundary

If a bundled Node script fails:

1. Report the actual Node failure.
2. Do not immediately jump to Python or external CLIs.
3. Only enter troubleshooting mode if the user wants the runtime debugged.

For normal user tasks, the bundled Node path is the only supported path.
