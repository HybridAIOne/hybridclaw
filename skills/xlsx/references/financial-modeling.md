# Financial Modeling Conventions

Use this only when the workbook is a financial model, the user asks for finance-standard formatting, or the workbook already follows these conventions. Existing template conventions always win.

## Presentation

- Inputs and scenario cells: blue text (`#0000FF`)
- Formulas and calculations: black text (`#000000`)
- Links to other sheets in the same workbook: green text (`#008000`)
- External workbook links: red text (`#FF0000`)
- Key assumptions or cells needing attention: yellow fill (`#FFFF00`)
- Keep one readable professional font throughout new workbooks unless the template already uses another style.

## Number Formats

- Years should display as four-digit labels without thousands separators. Use text or an explicit format such as `0000` when needed.
- Put units in headers for scaled values, for example `Revenue ($mm)` or `EBITDA (EURm)`.
- Currency should use the workbook's currency symbol with negatives in parentheses and zeros shown as `-`, for example `$#,##0;($#,##0);-`.
- Percentages should usually use `0.0%`.
- Valuation multiples should usually use `0.0x`.

## Formula Construction

- Keep assumptions such as growth, margin, tax, and multiple drivers in separate input cells or assumption sheets.
- Reference assumption cells from formulas instead of embedding hardcoded constants.
- Test a few formulas before filling across a long row or column so row and column offsets are correct.
- Guard divisions when the denominator can be zero.
- Keep cross-sheet references explicit and consistent.

## Hardcodes And Sources

- Add a nearby note or cell comment for material hardcoded assumptions or manually entered datapoints when source provenance matters.
- Use a compact format such as `Source: Company 10-K, FY2024, p.45, Revenue Note, https://...`.
