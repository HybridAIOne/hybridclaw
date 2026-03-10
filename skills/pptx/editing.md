# PPTX Template Editing

Use this workflow when you must preserve an existing deck or template.

## OOXML Workflow

```bash
node skills/office/unpack.cjs template.pptx /tmp/pptx-edit
node skills/office/validate.cjs /tmp/pptx-edit
node skills/office/pack.cjs /tmp/pptx-edit updated.pptx
```

Relevant parts inside `/tmp/pptx-edit`:

- `ppt/presentation.xml` for slide order and layout references
- `ppt/slides/slide*.xml` for slide content
- `ppt/slideLayouts/` and `ppt/slideMasters/` for reusable layouts
- `ppt/theme/` for colors and typography
- `ppt/_rels/presentation.xml.rels` and slide rels when adding new slide parts

## Template Rules

- Duplicate a template slide instead of rebuilding complex branded layouts from scratch.
- Keep masters, themes, and background assets intact.
- Update chart data, labels, and body text while preserving geometry.
- When adding a new slide, update slide ids, relationships, and `[Content_Types].xml`.

## Design QA Checklist

- Is there one dominant idea per slide?
- Does the title say something concrete instead of a topic label?
- Is every chart readable from a distance?
- Are margins, spacing, and alignment consistent?
- Is contrast high enough without relying on tiny text?
- Are decorative elements serving the message instead of crowding it?

## Anti-Patterns

- Dense bullet dumps
- Three unrelated charts on one slide
- Generic corporate clipart
- Center-aligning every text block
- Low-contrast text over photos
- Unlabeled axes or legends
