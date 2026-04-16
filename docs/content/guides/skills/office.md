---
title: Office Skills
description: PDF extraction, XLSX spreadsheets, DOCX documents, PPTX presentations, and cross-format office workflows.
sidebar_position: 2
---

# Office Skills

## pdf

Extract text, render pages, inspect or fill forms, and overlay content on PDFs
with bundled Node/JS tools.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `poppler` | PDF-to-image rendering (`pdftoppm`) | `hybridclaw skill install pdf brew-poppler` |
| `qpdf` | PDF merging, splitting, linearization | `hybridclaw skill install pdf brew-qpdf` |

Both are optional — the skill degrades gracefully without them.

> 💡 The skill ships bundled Node scripts under `skills/pdf/scripts/` — always prefer them over external CLIs.

> 💡 For invoice extraction, let the skill try text extraction first; it falls back to page rendering and vision only when text is unusable.

> 💡 Use `--format json` on extraction scripts when you need structured downstream processing.

> 🎯 **Try it yourself**

> 🎯 `Extract the text from invoice.pdf and list all line items with totals`

> 🎯 `Fill the "Name" and "Date" fields in application-form.pdf with "Jane Doe" and "2026-04-16", then save as filled-form.pdf`

> 🎯 `Merge report-q1.pdf and report-q2.pdf into combined-report.pdf`

> 🎯 `Render page 3 of blueprint.pdf as a PNG so I can inspect the diagram`

> 🎯 `Check if contract.pdf has fillable form fields`

> 🎯 `Extract all tables from quarterly-report.pdf, find every table with financial data, and save each table as a separate CSV file in ./extracted/`

**Troubleshooting**

- **"Cannot find module"** — ensure `node` is available on PATH. The pdf skill
  is Node-only; it does not use Python.
- **Blank text extraction** — the PDF may be image-based (scanned). The skill
  does not include OCR; render pages to PNG and use vision tooling instead.
- **Missing `pdftoppm`** — install Poppler via the command above. Without it,
  page-to-image rendering is unavailable.

---

## xlsx

Create, edit, inspect, and analyze `.xlsx` spreadsheets and Excel workbooks
using bundled Node scripts and `xlsx-populate`.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `node` | Required runtime | System install |
| LibreOffice (optional) | Formula recalculation and format conversion | See [Office Dependencies](../office-dependencies.md) |

> 💡 Use the bundled `create_xlsx.cjs` for quick creation from headers + rows or JSON data.

> 💡 `xlsx-populate` does **not** auto-recalculate formulas — run `recalc.cjs` with LibreOffice after formula edits.

> 💡 For CSV/TSV imports, use the bundled `import_delimited.cjs` instead of manual parsing.

> 💡 Prefer `.xlsx` as the final deliverable; convert from CSV only as an intermediate step.

> 🎯 **Try it yourself**

> 🎯 `Create a spreadsheet with headers "Name", "Revenue", "Quarter" and these rows: Alice 48000 Q1, Bob 52000 Q1, Alice 51000 Q2, Bob 49000 Q2`

> 🎯 `Add a SUM formula to column D in sales.xlsx and recalculate`

> 🎯 `Import transactions.csv into an xlsx with proper column formatting`

> 🎯 `Build a financial model spreadsheet for a SaaS product at $29/mo with 5% monthly growth over 12 months`

> 🎯 `Read the raw data in survey-results.xlsx, add a pivot summary sheet grouping responses by department, insert a SUM row at the bottom, and recalculate all formulas`

**Troubleshooting**

- **Formulas show stale values** — `xlsx-populate` cannot recalculate. Run
  `recalc.cjs` (requires LibreOffice) or open the file in Excel/Sheets.
- **`node` not found** — install Node.js (v18+) on the host.
- **Large file performance** — for workbooks over ~50 MB, consider splitting
  into multiple sheets or files.

---

## docx

Create, inspect, and edit `.docx` files safely, including comments and
OOXML-preserving changes.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `node` | Required runtime | System install |
| `pandoc` (optional) | Markdown-to-DOCX conversion | `brew install pandoc` |

> 💡 For **new documents**, write Markdown first and convert with `pandoc` — it is faster and produces cleaner output than programmatic generation.

> 💡 For **existing documents**, use the OOXML unpack-edit-repack workflow to preserve original formatting.

> 💡 Always escape XML-sensitive characters (`&`, `<`, `>`) when editing raw OOXML.

> 💡 Prefer user-provided `.docx` templates over generating from scratch.

> 🎯 **Try it yourself**

> 🎯 `Create a project proposal document with sections: Executive Summary, Problem Statement, Proposed Solution, Timeline (3 milestones), and Budget ($50k total)`

> 🎯 `Add a comment to paragraph 3 of report.docx saying "Needs updated figures"`

> 🎯 `Convert my notes.md into a formatted Word document with a table of contents`

> 🎯 `Update the header in template.docx to say "Q2 2026 Report"`

> 🎯 `Open proposal-template.docx, replace the Executive Summary placeholder with a 200-word overview of our cloud migration, update the header date to today, and save as cloud-migration-proposal.docx`

**Troubleshooting**

- **Corrupted output after edit** — relationship IDs likely drifted. Keep
  `_rels/*.rels` consistent when adding or removing OOXML parts.
- **Formatting lost** — if you used `pandoc` on an existing file, switch to
  OOXML editing to preserve the original styles.

---

## pptx

Create and edit `.pptx` presentations, export thumbnails for QA, and build
polished decks with pptxgenjs plus OOXML editing.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `node` | Required runtime | System install |
| LibreOffice (optional) | Thumbnail export for visual QA | See [Office Dependencies](../office-dependencies.md) |

> 💡 **New decks** — use `pptxgenjs` from a CommonJS `.cjs` script.

> 💡 **Template edits** — unpack the `.pptx`, edit the OOXML XML parts, repack. Never round-trip a template through pptxgenjs.

> 💡 Use the visual QA loop: export to PDF, render thumbnails, inspect, fix.

> 💡 One clear message per slide keeps presentations focused.

> 🎯 **Try it yourself**

> 🎯 `Create a 10-slide pitch deck for an AI-powered customer support tool: problem, solution, market size ($8B), product demo flow, pricing (3 tiers), team, traction (500 beta users), roadmap, and ask ($2M seed)`

> 🎯 `Update the title slide in template.pptx with company name "Acme Corp" and tagline "Ship faster, break nothing"`

> 🎯 `Add speaker notes to every slide in workshop.pptx`

> 🎯 `Export all slides as PNG thumbnails so I can review the layout`

> 🎯 `Read the key findings from analysis.xlsx, create a 6-slide presentation with one chart per finding, add speaker notes explaining each chart, and export slide thumbnails for review`

**Troubleshooting**

- **Broken slide after template edit** — use OOXML unpack/repack, not
  pptxgenjs, for existing templates.
- **Missing thumbnails** — the visual QA loop requires LibreOffice and
  `pdftoppm` (Poppler). Install both via [Office Dependencies](../office-dependencies.md).

---

## office-workflows

Coordinate cross-format office workflows across CSV/TSV, XLSX, DOCX, and PPTX
deliverables. This skill orchestrates the other office skills.

**Prerequisites** — none beyond what the individual office skills require.

> 💡 Use chain mode when later outputs depend on prior findings (e.g., XLSX analysis then PPTX summary).

> 💡 Use parallel mode for independent research branches.

> 💡 Always produce fresh outputs from source files rather than editing previously generated artifacts.

> 🎯 **Try it yourself**

> 🎯 `Import sales.csv into xlsx, add a summary sheet with totals per region, then create a 5-slide pptx deck from the highlights`

> 🎯 `Analyze the data in report.xlsx and write a one-page executive memo as docx`

> 🎯 `Merge north.csv, south.csv, and west.csv into one xlsx with a sheet per region, then generate a presentation comparing revenue across regions`
