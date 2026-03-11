---
name: xlsx
description: Use this skill for spreadsheet work: inspect .xlsx sheets, clean CSV or TSV inputs into .xlsx, analyze tabular data, create workbooks, edit formulas, and apply workbook formatting with Node.js and ExcelJS.
user-invocable: true
disable-model-invocation: false
requires:
  bins:
    - node
metadata:
  hybridclaw:
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

1. Use a workspace CommonJS `.cjs` script with `require("exceljs")` for workbook creation and structural edits.
2. Use `skills/xlsx/scripts/import_delimited.cjs` for messy CSV or TSV inputs when it saves time, then polish the workbook with `exceljs`.
3. Do table reshaping in plain JavaScript, then write the final workbook with `exceljs`.
4. After meaningful formula edits, run LibreOffice-backed recalculation when `soffice` is available so cached values and error checks are current.
5. Save the finished workbook inside the workspace and return the `.xlsx` artifact.

## Rules

- Keep formulas as formulas. Do not replace derived cells with hardcoded values unless the user explicitly asks for static outputs.
- Keep formulas dynamic. Put user-editable assumptions and drivers in dedicated cells or sheets instead of burying hardcoded constants inside long formulas.
- `exceljs` does not recalculate formulas. Keep formula strings intact and use LibreOffice-backed verification when cached values matter and the runtime says `soffice` is available.
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
const ExcelJS = require("exceljs");

async function main() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Summary");

  sheet.addRow(["Revenue", "Cost", "Profit"]);
  sheet.addRow([120000, 45000, { formula: "A2-B2" }]);

  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFD9EAF7" },
    };
    cell.alignment = { horizontal: "center" };
  });

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 16;
  sheet.getColumn(3).width = 16;

  await workbook.xlsx.writeFile("profit-summary.xlsx");
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
