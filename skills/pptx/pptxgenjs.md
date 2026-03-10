# PPTXGenJS From Scratch

Use this path only for new decks where preserving an existing template is not required.

## Starter Pattern

```js
const pptxgen = require("pptxgenjs");

const pptx = new pptxgen();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "HybridClaw";
pptx.subject = "Executive summary";
pptx.theme = {
  headFontFace: "Aptos Display",
  bodyFontFace: "Aptos",
  lang: "en-US",
};

const slide = pptx.addSlide();
slide.background = { color: "F7F4EC" };
slide.addText("Q4 Revenue Accelerated", {
  x: 0.6,
  y: 0.4,
  w: 11.4,
  h: 0.6,
  fontFace: "Aptos Display",
  fontSize: 24,
  bold: true,
  color: "18242D",
});
slide.addText(
  "Revenue grew 18% year over year, led by enterprise renewals and improved expansion in EMEA.",
  {
    x: 0.6,
    y: 1.2,
    w: 5.6,
    h: 1.0,
    fontFace: "Aptos",
    fontSize: 16,
    color: "334A57",
    breakLine: false,
  },
);

await pptx.writeFile({ fileName: "exec-summary.pptx" });
```

For visual QA, export through the shared Office wrapper:

```bash
node skills/office/soffice.cjs convert exec-summary.pptx /tmp/pptx-export --format pdf --json
```

Use that path only when the runtime says `soffice` is available. If you need to verify manually, run:

```bash
sh -lc 'command -v soffice >/dev/null 2>&1 || command -v libreoffice >/dev/null 2>&1'
sh -lc 'command -v pdftoppm >/dev/null 2>&1'
```

If both checks succeed, treat render-and-review as required before final delivery: render thumbnails, review them, apply fixes, and rerender until there are no concrete slide-level issues left. If either dependency is unavailable, do not attempt that loop; return the generated `.pptx` without calling out the missing QA tools unless the user explicitly asked for QA, export, thumbnails, validation, or render verification.

## Layout Guidelines

- Use widescreen unless the user specifies another aspect ratio.
- Reserve the top-left for the primary message.
- Keep body copy below 40-60 words per slide.
- Use 2-3 colors consistently. Let emphasis come from hierarchy, not decoration.
- Prefer charts and key numbers over paragraph-heavy slides.
- For `addTable()` and table-like layouts, never use OOXML values directly in script options. Do not use `valign: "mid"`, `valign: "ctr"`, or raw `anchor: "mid"`. If you need vertical alignment, use only `top`, `middle`, or `bottom` through the `pptxgenjs` API. If vertical centering is not essential, leave table-cell vertical alignment unset.

Valid example:

```js
slide.addTable(rows, {
  x: 0.6,
  y: 1.4,
  w: 12.0,
  colW: [2.0, 3.0, 2.0],
  fontSize: 10,
  margin: 0.04,
  valign: "middle",
});
```

Invalid examples:

```js
// Wrong: OOXML shorthand, not a pptxgenjs API value
valign: "mid"

// Wrong: OOXML enum, not a pptxgenjs API value
valign: "ctr"
```
