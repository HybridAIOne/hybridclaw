---
name: docx
description: Create, inspect, and edit `.docx` files safely, including comments and OOXML-preserving changes.
category: office
user-invocable: true
disable-model-invocation: false
requires:
  bins:
    - node
metadata:
  hybridclaw:
    tags:
      - office
      - document
      - docx
    related_skills:
      - xlsx
---

# DOCX

Use this skill whenever the user asks to create, revise, comment on, or inspect a `.docx` document.

## Default Workflow

- For new documents with straightforward structure, write Markdown first and convert it with `pandoc`.
- For programmatic creation, write a CommonJS `.cjs` script and use `require("docx")`. The container exposes global Node packages through `NODE_PATH`; avoid bare ESM `import "docx"` examples.
- For editing an existing `.docx`, never round-trip the original file through `docx` or `pandoc`. Unpack the OOXML, edit the XML you need, and repack it.

## Existing-File Editing Workflow

```bash
node skills/office/unpack.cjs input.docx tmp/docx-edit
node skills/office/validate.cjs tmp/docx-edit
node skills/office/pack.cjs tmp/docx-edit output.docx
```

Edit only the relevant parts under `tmp/docx-edit/word/`:

- `document.xml` for the main body
- `styles.xml` for styles
- `numbering.xml` for list definitions
- `header*.xml` / `footer*.xml` for page furniture
- `_rels/*.rels` when you add new parts

## Rules

- Preserve existing formatting by editing OOXML directly for in-place revisions.
- Escape XML-sensitive characters (`&`, `<`, `>`) and preserve `xml:space="preserve"` when surrounding spaces matter.
- Use DXA table widths and explicit cell widths instead of percentages when layout must survive Word and Google Docs.
- Keep relationship ids, comment ids, and content-type overrides consistent when adding parts.
- Never write plain text or placeholder text directly to a `.docx` file path. If generation fails, stop and report the error.

## Comments And Reviews

- Use `node skills/docx/scripts/comment.cjs --help` to insert a comment around an exact text match inside an unpacked DOCX tree.
- Use `node skills/docx/scripts/accept_changes.cjs /tmp/docx-edit --json` to accept straightforward tracked changes after unpacking.
- The helper currently targets `word/document.xml`. For complex tracked changes, nested fields, or multi-run matches, edit the OOXML manually after unpacking.

## Useful Commands

```bash
pandoc draft.docx -t gfm -o draft.md
pandoc outline.md -o report.docx
```

## Templates

- Prefer user-provided `.docx` templates from the current workspace for letterhead, memos, and branded report formats.
- Preserve headers, footers, styles, numbering, and section geometry unless the user explicitly asks for a layout change.

## Minimal Creation Pattern

```js
const fs = require("node:fs");
const { Document, Packer, Paragraph, TextRun } = require("docx");

const document = new Document({
  sections: [
    {
      children: [
        new Paragraph({
          children: [new TextRun({ text: "Quarterly Update", bold: true })],
        }),
        new Paragraph("Prepared for leadership review."),
      ],
    },
  ],
});

Packer.toBuffer(document).then((buffer) => {
  fs.writeFileSync("quarterly-update.docx", buffer);
});
```
