---
name: xlsx
description: Inspect, create, clean, analyze, and format `.xlsx` workbooks and tabular data with Node.js and XlsxPopulate.
user-invocable: true
disable-model-invocation: false
requires:
  bins:
    - node
metadata:
  hybridclaw:
    category: office
    short_description: "XLSX editing and analysis."
    tags:
      - office
      - spreadsheet
      - xlsx
    related_skills:
      - docx
---
# XLSX

Use this skill whenever the user asks to create, inspect, analyze, or edit an `.xlsx` workbook, or to turn delimited tabular data into a polished `.xlsx` file.

## Default Workflow

1. Use a workspace CommonJS `.cjs` script with `require("xlsx-populate")` for workbook creation and structural edits.
2. Use `skills/xlsx/scripts/import_delimited.cjs` for messy CSV or TSV inputs when it saves time, then polish the workbook with `xlsx-populate`.
3. Do table reshaping in plain JavaScript, then write the final workbook with `xlsx-populate`.
4. After meaningful formula edits, run LibreOffice-backed recalculation when `soffice` is available so cached values and error checks are current.
5. Save the finished workbook inside the workspace and return the `.xlsx` artifact.

## Rules

- Keep formulas as formulas. Do not replace derived cells with hardcoded values unless the user explicitly asks for static outputs.
- Keep formulas dynamic. Put user-editable assumptions and drivers in dedicated cells or sheets instead of burying hardcoded constants inside long formulas.
- `xlsx-populate` does not recalculate formulas. Keep formula strings intact and use LibreOffice-backed verification when cached values matter and the runtime says `soffice` is available.
- After significant formula edits, run `node skills/xlsx/scripts/recalc.cjs workbook.xlsx --json` when `soffice` is available and fix any `#REF!`, `#DIV/0!`, `#VALUE!`, `#N/A`, or `#NAME?` errors before delivery.
- Match existing workbook conventions exactly when editing templates or established models. Existing fonts, fills, borders, number formats, freeze panes, filters, named ranges, and color conventions override generic style rules.
- For new user-facing workbooks without a template, use consistent professional styling: one readable font, explicit header styling, sensible widths, and alignment or freeze panes where they help readability.
- Preserve existing worksheets, named ranges, freeze panes, filters, and formats unless the user asked for a redesign.
- Prefer `.xlsx` as the final deliverable. Only fall back to CSV/TSV if the user explicitly wants a flat export.
- Use number formats, explicit column widths, alignment, and header styling for user-facing workbooks.
- Treat `skills/` as bundled tooling. Do not write generated task scripts under `skills/xlsx/` or `skills/office/` for normal workbook jobs.
- Put new helper scripts in workspace `scripts/` or the workspace root, then run them from there. Use `skills/xlsx/scripts/...` and `skills/office/...` only as shipped helper commands.

## Variant Guidance

- For financial models or other heavily formatted analytical workbooks, read [references/financial-modeling.md](references/financial-modeling.md) before applying conventions.

## Useful Commands

```bash
node skills/xlsx/scripts/recalc.cjs workbook.xlsx --json
node skills/xlsx/scripts/import_delimited.cjs raw.csv cleaned.xlsx --json
```

## Starter Pattern

```js
const XlsxPopulate = require("xlsx-populate");

async function main() {
  const workbook = await XlsxPopulate.fromBlankAsync();
  const sheet = workbook.sheet(0).name("Summary");

  sheet.cell("A1").value("Revenue");
  sheet.cell("B1").value("Cost");
  sheet.cell("C1").value("Profit");
  sheet.cell("A2").value(120000);
  sheet.cell("B2").value(45000);
  sheet.cell("C2").formula("A2-B2");

  sheet.range("A1:C1").style({
    bold: true,
    horizontalAlignment: "center",
    fill: "D9EAF7"
  });

  sheet.freezePanes("A2");
  sheet.column("A").width(16);
  sheet.column("B").width(16);
  sheet.column("C").width(16);

  await workbook.toFileAsync("profit-summary.xlsx");
}

main();
```

## CSV / TSV Import

- Use `skills/xlsx/scripts/import_delimited.cjs` for messy CSV or TSV inputs.
- It auto-detects encoding and delimiter, infers whether the first row is a header, writes a styled workbook, and gives you a clean `.xlsx` starting point.

## Recalculation And Templates

- Use `skills/xlsx/scripts/recalc.cjs` after significant formula edits when `soffice` is available to refresh calculated values through LibreOffice.
- Prefer user-provided templates from the current workspace when the user needs a financial model or branded workbook preserved.
- If `recalc.cjs` cannot run because `soffice` is unavailable, keep formulas intact, do not guess cached values, and state the verification limitation plainly.
- For finance-specific presentation rules, source notes, and number formats, load [references/financial-modeling.md](references/financial-modeling.md).
