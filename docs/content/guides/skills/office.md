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
| `node` | Required runtime — the skill is Node-only | System install |

The Node libraries (`pdf-lib`, `pdfjs-dist`, `@napi-rs/canvas`) are bundled
with HybridClaw. No external CLI tools are required.

> 💡 **Tips & Tricks**
>
> The skill ships bundled Node scripts under `skills/pdf/scripts/` — always prefer them over external CLIs.
>
> Let the skill try text extraction first; it falls back to page rendering and vision only when text is unusable.
>
> Use `--json` on `extract_pdf_text.mjs` when you need structured downstream processing.
>
> When filling a fillable form, add `--flatten` so the values are baked into the page content and survive re-extraction.

> 🎯 **Try it yourself**
>
> Creation and extraction:
>
> `Create a one-page PDF titled "Quarterly Report" with three body lines: revenue, growth, and team size`
>
> `Create a one-page PDF invoice for "Acme Corp" with 3 line items (Widget A 120, Widget B 250, Consulting 500), a subtotal, 8% tax, and grand total, then extract the text back as JSON so I can see exactly what was written`
>
> `Render page 1 of ~/Downloads/some-report.pdf as a PNG so I can inspect the layout`
>
> Fillable forms:
>
> `Create a PDF registration form with fields "last_name" (text), "country" (dropdown with DE/US/FR), and "is_adult" (checkbox), then report the extracted field metadata`
>
> `Fill the registration form with last_name="Simpson", country="US", and is_adult=true, save both a regular filled.pdf and a flattened filled-flat.pdf, and extract text from the flattened copy to confirm the values stuck`
>
> Non-fillable overlays:
>
> `Check whether ~/Downloads/tax-form.pdf has native fillable fields; if it doesn't, render its pages to PNG and extract the best-effort structure so I can plan coordinate boxes`
>
> `Given a fields.json for a non-fillable PDF, validate the bounding boxes, draw a validation overlay onto the rendered page image, then write the filled PDF with the text annotations in place`
>
> Multi-step flow:
>
> `1. Create a 2-page PDF titled "Annual Review 2025" with a cover page and an executive summary`
> `2. Extract the text as JSON and render both pages to PNGs`
> `3. Check whether the PDF has fillable fields, and if not, add a "Signed By: Jane Doe" overlay near the bottom of page 2`

**Troubleshooting**

- **"Cannot find module"** — ensure `node` is available on PATH. The pdf skill
  is Node-only; it does not use Python.
- **Blank text extraction** — the PDF may be image-based (scanned). The skill
  does not include OCR; render pages to PNG and use vision tooling instead.
- **Filled form fields disappear on re-extraction** — use `--flatten` when
  calling `fill_fillable_fields.mjs` so values are baked into the content
  stream rather than left as interactive widgets.

---

## xlsx

Create, edit, inspect, and analyze `.xlsx` spreadsheets and Excel workbooks
using bundled Node scripts and `xlsx-populate`.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `node` | Required runtime | System install |
| LibreOffice (optional) | Formula recalculation and format conversion | See [Office Dependencies](../office-dependencies.md) |

> 💡 **Tips & Tricks**
>
> Use the bundled `create_xlsx.cjs` for quick creation from headers + rows or JSON data.
>
> `xlsx-populate` does **not** auto-recalculate formulas — run `recalc.cjs` with LibreOffice after formula edits.
>
> For CSV/TSV imports, use the bundled `import_delimited.cjs` instead of manual parsing.
>
> Prefer `.xlsx` as the final deliverable; convert from CSV only as an intermediate step.

> 🎯 **Try it yourself**
>
> `Create a spreadsheet with headers "Name", "Revenue", "Quarter" and these rows: Alice 48000 Q1, Bob 52000 Q1, Alice 51000 Q2, Bob 49000 Q2`
>
> `Create a sales spreadsheet with columns "Product", "Units", "Price", "Total" and 10 rows of sample data, then add a SUM formula at the bottom of the Total column and recalculate`
>
> `Create a CSV file with 20 rows of transaction data (Date, Description, Amount, Category), then import it into an xlsx with proper column formatting and date parsing`
>
> `Build a financial model spreadsheet for a SaaS product at $29/mo with 5% monthly growth over 12 months`
>
> `Create a spreadsheet with 50 rows of employee survey responses (Name, Department, Rating 1-5, Comment), add a pivot summary sheet grouping responses by department with average ratings, insert a COUNT row at the bottom, and recalculate all formulas`
>
> **Conversation flow:**
>
> `1. Create a spreadsheet with monthly revenue data for 3 product lines (Pro, Team, Enterprise) across Jan-Dec 2025`
> `2. Add a "Trends" sheet with month-over-month growth formulas and conditional formatting that highlights months with negative growth in red`
> `3. Create a "Forecast" sheet that projects Q1 2026 using a 3-month moving average from the existing data`

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

> 💡 **Tips & Tricks**
>
> For **new documents**, write Markdown first and convert with `pandoc` — it is faster and produces cleaner output than programmatic generation.
>
> For **existing documents**, use the OOXML unpack-edit-repack workflow to preserve original formatting.
>
> Always escape XML-sensitive characters (`&`, `<`, `>`) when editing raw OOXML.
>
> Prefer user-provided `.docx` templates over generating from scratch.

> 🎯 **Try it yourself**
>
> `Create a project proposal document with sections: Executive Summary, Problem Statement, Proposed Solution, Timeline (3 milestones), and Budget ($50k total)`
>
> `Create a short report document about Q1 sales performance with 3 paragraphs, then add a comment to paragraph 2 saying "Needs updated figures"`
>
> `Create a markdown file with meeting notes (Attendees, Agenda, Action Items, Decisions) from a fictional product launch meeting, then convert it into a formatted Word document with a table of contents`
>
> `Create a Word document with header "Q1 2026 Report", 2 pages of placeholder content, then update the header to say "Q2 2026 Report" and save as updated-report.docx`
>
> `Create a proposal template document with placeholder sections (Executive Summary, Technical Approach, Timeline, Budget), then replace the Executive Summary placeholder with a 200-word overview of a cloud migration project, update the header date to today, and save as cloud-migration-proposal.docx`
>
> **Conversation flow:**
>
> `1. Create a Word document with a project charter for "Platform Modernization" including sections for Scope, Objectives, Stakeholders, and Success Criteria`
> `2. Add a comment on the Scope section saying "Needs sign-off from VP Engineering" and insert a revision table at the top`
> `3. Convert the final document to PDF and create a one-page executive summary version as a separate docx`

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

> 💡 **Tips & Tricks**
>
> **New decks** — use `pptxgenjs` from a CommonJS `.cjs` script.
>
> **Template edits** — unpack the `.pptx`, edit the OOXML XML parts, repack. Never round-trip a template through pptxgenjs.
>
> Use the visual QA loop: export to PDF, render thumbnails, inspect, fix.
>
> One clear message per slide keeps presentations focused.

> 🎯 **Try it yourself**
>
> `Create a 10-slide pitch deck for an AI-powered customer support tool: problem, solution, market size ($8B), product demo flow, pricing (3 tiers), team, traction (500 beta users), roadmap, and ask ($2M seed)`
>
> `Create a 5-slide presentation titled "Acme Corp — Ship faster, break nothing" with slides for Mission, Product, Team, Traction, and Contact`
>
> `Create an 8-slide workshop presentation on "Intro to Kubernetes" with one concept per slide, then add speaker notes to every slide explaining the key talking points`
>
> `Create a 4-slide deck and export all slides as PNG thumbnails so I can review the layout`
>
> `Create a spreadsheet with key findings from a fictional product analytics review (6 metrics: DAU, retention, churn, NPS, conversion, ARPU — each with a trend), then create a 6-slide presentation with one chart per finding, add speaker notes explaining each chart, and export slide thumbnails for review`
>
> **Conversation flow:**
>
> `1. Create a 6-slide investor update deck with slides for Vision, Problem, Solution, Market Size ($12B TAM), Business Model, and Ask ($5M Series A)`
> `2. Add speaker notes to every slide with 3 key talking points each, and insert a "Team" slide after Business Model with 4 fictional co-founders`
> `3. Export all slides as PNG thumbnails and create a companion one-page PDF leave-behind summarizing the pitch`

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

> 💡 **Tips & Tricks**
>
> Use chain mode when later outputs depend on prior findings (e.g., XLSX analysis then PPTX summary).
>
> Use parallel mode for independent research branches.
>
> Always produce fresh outputs from source files rather than editing previously generated artifacts.

> 🎯 **Try it yourself**
>
> `Create a CSV with 30 rows of sales data (Region, Product, Units, Revenue) across 4 regions, import it into xlsx, add a summary sheet with totals per region, then create a 5-slide pptx deck from the highlights`
>
> `Create a spreadsheet with quarterly performance data (Revenue, Costs, Headcount, NPS) for Q1-Q4 2025, then analyze the trends and write a one-page executive memo as docx`
>
> `Create three CSV files — north.csv, south.csv, and west.csv — each with 10 rows of regional sales data (Product, Units, Revenue), merge them into one xlsx with a sheet per region, then generate a presentation comparing revenue across regions`
>
> **Conversation flow:**
>
> `1. Create a CSV with 40 rows of employee data (Name, Department, Title, Start Date, Salary) across Engineering, Marketing, Sales, and Design`
> `2. Import it into an xlsx, add a summary sheet with headcount and average salary per department, and create a Word doc with an HR overview narrative`
> `3. Build a 4-slide presentation with one department spotlight per slide showing key stats, and export it alongside the xlsx and docx as a complete reporting package`
