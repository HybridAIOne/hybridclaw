---
name: pptx
description: Create and edit `.pptx` presentations safely, export thumbnails for QA, and build polished decks with pptxgenjs plus OOXML editing.
user-invocable: true
disable-model-invocation: false
requires:
  bins:
    - node
metadata:
  hybridclaw:
    tags:
      - office
      - presentation
      - pptx
    related_skills:
      - office-workflows
      - xlsx
      - docx
---

# PPTX

Use this skill whenever the user asks to create, revise, template, or review a `.pptx` presentation.

## Start Here

- For new decks, read [pptxgenjs.md](./pptxgenjs.md).
- For template edits or preserving an existing deck, read [editing.md](./editing.md).

## Working Rules

- For template-based editing, use unpack -> edit OOXML -> pack. Do not round-trip an existing deck through `pptxgenjs`.
- For new decks, use `pptxgenjs` from a CommonJS `.cjs` script with `require("pptxgenjs")`.
- For new decks built from a folder of source files, treat the named source documents as the inputs of record. Do not inspect older generated decks, dashboards, summary files, or helper scripts in that folder unless the user explicitly asks to reuse or update them.
- Use `node skills/office/soffice.cjs convert ... --format pdf` only when the runtime says `soffice` is available.
- Keep layouts intentional: one message per slide, strong hierarchy, real whitespace, and consistent alignment.
- Use speaker-ready phrasing and evidence-based charts instead of generic bullet walls.
- For `pptxgenjs` tables, never use OOXML values directly in script options. Do not use `valign: "mid"`, `valign: "ctr"`, or raw `anchor: "mid"`. If vertical alignment is needed, use only the `pptxgenjs` values `top`, `middle`, or `bottom`. If it is not essential, leave table-cell vertical alignment unset.
- After `pptx.writeFile(...)` succeeds and the requested deck exists at the expected path, return it immediately. Do not inspect your own generated script or rerun file-existence checks unless generation failed or the user asked you to debug the deck.

## Visual QA Loop

- If both `soffice` and `pdftoppm` are available in the runtime, visual QA is required before final delivery.
- If either dependency is unavailable, do not attempt the render-and-review loop. Return the generated `.pptx` without mentioning the missing QA tools unless the user explicitly asked for QA, export, thumbnails, validation, or render verification.

1. Check capability availability before starting the QA loop. Prefer the runtime capability system message if it is already present. If you need to verify manually, run:
```bash
sh -lc 'command -v soffice >/dev/null 2>&1 || command -v libreoffice >/dev/null 2>&1'
sh -lc 'command -v pdftoppm >/dev/null 2>&1'
```
Only continue with steps 3-6 when both commands succeed.
2. Export the deck to PDF:
```bash
node skills/office/soffice.cjs convert deck.pptx /tmp/pptx-export --format pdf --json
```
3. Render slide thumbnails:
```bash
node skills/pptx/scripts/thumbnail.cjs deck.pptx /tmp/pptx-thumbs --count 6 --json
```
4. Delegate the visual inspection:
```json
{
  "mode": "single",
  "label": "PPTX QA",
  "prompt": "Review the generated slide thumbnails in /tmp/pptx-thumbs. Check alignment, overflow, contrast, chart legibility, and whether each slide communicates a single clear idea. Summarize concrete slide-by-slide fixes."
}
```
5. Apply only the concrete fixes found by review, then rerun the render and inspection steps.
6. Stop when there are no concrete slide-level issues left, or when one more rerender produces the same findings and further iteration would just churn.

## Templates

- Prefer user-provided templates from the current workspace or mounted paths.
- Bundled starter templates can live under `skills/office/templates/`.
- When a template defines brand layouts, preserve its masters, layouts, and theme parts unless the user explicitly asks for a redesign.
