# PDF Forms

This guide is part of the bundled Node/JS PDF workflow.

Complete the form workflow in order. Do not start filling a PDF until you know whether it has native fillable fields.

## 1. Detect Fillable Fields

Run:

```bash
node skills/pdf/scripts/check_fillable_fields.mjs form.pdf
```

If the script reports native form fields, use the fillable workflow below. Otherwise use the non-fillable workflow.

## Fillable Forms

### 1. Extract Field Metadata

Run:

```bash
node skills/pdf/scripts/extract_form_field_info.mjs input.pdf field-info.json
```

This produces a JSON array like:

```json
[
  {
    "field_id": "last_name",
    "page": 1,
    "rect": [49.5, 299.5, 170.5, 324.5],
    "type": "text"
  },
  {
    "field_id": "is_adult",
    "page": 1,
    "rect": [49.5, 249.5, 62.5, 262.5],
    "type": "checkbox",
    "checked_value": "/Yes",
    "unchecked_value": "/Off"
  },
  {
    "field_id": "country",
    "page": 1,
    "rect": [49.5, 199.5, 170.5, 224.5],
    "type": "choice",
    "choice_options": [
      { "value": "DE", "text": "DE" },
      { "value": "US", "text": "US" }
    ]
  },
  {
    "field_id": "citizenship",
    "page": 1,
    "type": "radio_group",
    "radio_options": [
      { "value": "US", "page": 1, "rect": [49.5, 149.5, 62.5, 162.5] },
      { "value": "Other", "page": 1, "rect": [99.5, 149.5, 112.5, 162.5] }
    ]
  }
]
```

### 2. Render the PDF for Visual Mapping

Field IDs are often cryptic. Render page images so you can map each field to the visible form label:

```bash
node skills/pdf/scripts/render_pdf_pages.mjs input.pdf page-images
```

Use the images plus each field's `rect` or `radio_options[].rect` to identify which field is which.

### 3. Build `field-values.json`

Create a JSON array describing the values to apply:

```json
[
  {
    "field_id": "last_name",
    "description": "Applicant last name",
    "page": 1,
    "value": "Simpson"
  },
  {
    "field_id": "is_adult",
    "description": "Age confirmation checkbox",
    "page": 1,
    "value": true
  },
  {
    "field_id": "country",
    "description": "Country dropdown",
    "page": 1,
    "value": "DE"
  }
]
```

Rules:

- `field_id` must match `extract_form_field_info.mjs` output exactly.
- `page` should match the extracted `page`.
- For checkboxes, use `true`/`false` or the exact `checked_value` / `unchecked_value`.
- Radio groups must use one of the values from `radio_options`.
- Choice fields must use one of the values from `choice_options`.

### 4. Fill the PDF

Run:

```bash
node skills/pdf/scripts/fill_fillable_fields.mjs input.pdf field-values.json filled.pdf
```

If you want the result flattened:

```bash
node skills/pdf/scripts/fill_fillable_fields.mjs input.pdf field-values.json filled.pdf --flatten
```

The script validates field IDs, page numbers, and selected values before it writes the output file.

## Non-Fillable Forms

For non-fillable PDFs, add text directly to the document using explicit coordinates.

Use top-origin boxes in your `fields.json`:

- `left`, `top`, `right`, `bottom`
- origin is the top-left of the source space
- source space is either the PDF page itself or a rendered page image

### 1. Render Pages

```bash
node skills/pdf/scripts/render_pdf_pages.mjs input.pdf page-images
```

### 2. Optional: Extract Best-Effort Structure

If the PDF is text-based, get label positions first:

```bash
node skills/pdf/scripts/extract_form_structure.mjs input.pdf form-structure.json
```

This returns:

- `pages`: page widths and heights
- `labels`: best-effort text fragments with top-origin coordinates
- `row_boundaries`: best-effort text-row groupings
- `lines`: currently empty placeholder array
- `checkboxes`: currently empty placeholder array

Use the labels and row groupings as hints. Do not assume the structure output is complete.

### 3. Build `fields.json`

When your coordinates come from rendered images, declare `image_width` and `image_height` for each page:

```json
{
  "pages": [
    {
      "page_number": 1,
      "image_width": 1400,
      "image_height": 1812
    }
  ],
  "form_fields": [
    {
      "page_number": 1,
      "description": "Last name field",
      "field_label": "Last Name",
      "label_bounding_box": [120, 175, 242, 198],
      "entry_bounding_box": [255, 175, 720, 218],
      "entry_text": {
        "text": "Smith",
        "font_size": 10,
        "font": "Helvetica",
        "font_color": "#000000"
      }
    }
  ]
}
```

When your coordinates already match the PDF page size, declare `pdf_width` and `pdf_height` instead:

```json
{
  "pages": [
    {
      "page_number": 1,
      "pdf_width": 612,
      "pdf_height": 792
    }
  ],
  "form_fields": [
    {
      "page_number": 1,
      "description": "Last name field",
      "field_label": "Last Name",
      "label_bounding_box": [43, 63, 87, 73],
      "entry_bounding_box": [92, 63, 260, 79],
      "entry_text": {
        "text": "Smith",
        "font_size": 10,
        "font": "Helvetica"
      }
    }
  ]
}
```

The bundled overlay script always interprets these boxes as top-origin coordinates.

### 4. Validate Bounding Boxes

Before writing the final PDF, validate that your label and entry boxes do not collide:

```bash
node skills/pdf/scripts/check_bounding_boxes.mjs fields.json
```

### 5. Create Validation Images

Draw the boxes on top of the rendered page image for manual review:

```bash
node skills/pdf/scripts/create_validation_image.mjs 1 fields.json page-images/page_1.png validation-page-1.png
```

### 6. Fill the PDF

```bash
node skills/pdf/scripts/fill_pdf_form_with_annotations.mjs input.pdf fields.json filled.pdf
```

The script draws the supplied `entry_text` directly onto the PDF using bundled Node libraries.

## Coordinate Summary

### Fillable field metadata

`extract_form_field_info.mjs` returns `rect` in native PDF coordinates:

- `[left, bottom, right, top]`
- origin is the bottom-left of the page

### Non-fillable field overlays

`fields.json` always uses top-origin boxes:

- `[left, top, right, bottom]`
- origin is the top-left of the declared source space
- source space is the PDF page size when `pdf_width` / `pdf_height` are present
- source space is the rendered image size when `image_width` / `image_height` are present
