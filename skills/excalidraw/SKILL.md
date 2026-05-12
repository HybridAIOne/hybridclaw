---
name: excalidraw
description: Create and revise editable `.excalidraw` diagrams as Excalidraw JSON for architecture diagrams, flowcharts, sequence diagrams, concept maps, and other hand-drawn explainers.
user-invocable: true
disable-model-invocation: false
metadata:
  hybridclaw:
    category: publishing
    short_description: "Editable Excalidraw diagrams and share links."
    tags:
      - excalidraw
      - diagrams
      - flowcharts
      - architecture
      - visualization
    related_skills:
      - manim-video
      - write-blog-post
---
# Excalidraw

Use this skill when the user wants an editable diagram, not just a rendered image.

Typical requests:

- architecture or system diagrams
- flowcharts and process maps
- sequence diagrams
- concept maps and explainers
- hand-drawn style visuals that should stay editable in Excalidraw

Excalidraw files are plain JSON. The default deliverable is a `*.excalidraw` file in the workspace. The user can drag that file into [excalidraw.com](https://excalidraw.com) to view, edit, or export it.

## Default Workflow

1. Plan the diagram before writing JSON: title, nodes, connectors, groups, and rough canvas size.
2. Write a valid Excalidraw `elements` array.
3. Wrap the array in the standard file envelope.
4. Save the result as `*.excalidraw`.
5. If the user wants a shareable browser link, run:

```bash
node skills/excalidraw/scripts/upload.mjs diagram.excalidraw
```

The upload helper encrypts the diagram client-side and prints the Excalidraw share URL.

## File Envelope

Use this shape unless you are editing an existing file and need to preserve more fields:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "hybridclaw",
  "elements": [],
  "appState": {
    "viewBackgroundColor": "#ffffff"
  },
  "files": {}
}
```

When editing an existing `.excalidraw` file, preserve `appState`, `files`, and any other existing top-level keys unless the user asked for a deliberate reset.

## Rules

- Use Excalidraw JSON, not SVG or HTML, unless the user explicitly asked for another format.
- For labeled shapes or arrows, create a separate `text` element and bind it with `containerId` plus the container's `boundElements`.
- Do **not** invent a `"label"` property on rectangles, diamonds, ellipses, or arrows. Excalidraw ignores it.
- Place a bound text element immediately after its container in the `elements` array.
- Use readable sizes: `fontSize` 16+ for normal labels, 20+ for titles, and at least `120x60` for labeled boxes.
- Leave about `20-30px` of space between major elements.
- Prefer short stable ids such as `api`, `text-api`, `arrow-api-db`.
- Avoid emoji and decorative Unicode. Stick to plain text that Excalidraw renders reliably.
- Default to a white background with dark text unless the user explicitly asks for dark mode.
- For arrows, `points` are offsets relative to the arrow's `x` and `y`.

## Core Patterns

### Labeled Rectangle

```json
[
  {
    "type": "rectangle",
    "id": "api",
    "x": 120,
    "y": 120,
    "width": 220,
    "height": 80,
    "roundness": { "type": 3 },
    "backgroundColor": "#a5d8ff",
    "fillStyle": "solid",
    "boundElements": [{ "id": "text-api", "type": "text" }]
  },
  {
    "type": "text",
    "id": "text-api",
    "x": 130,
    "y": 145,
    "width": 200,
    "height": 24,
    "text": "API Service",
    "fontSize": 20,
    "fontFamily": 1,
    "strokeColor": "#1e1e1e",
    "textAlign": "center",
    "verticalAlign": "middle",
    "containerId": "api",
    "originalText": "API Service",
    "autoResize": true
  }
]
```

### Arrow Between Shapes

```json
{
  "type": "arrow",
  "id": "arrow-api-db",
  "x": 340,
  "y": 160,
  "width": 180,
  "height": 0,
  "points": [[0, 0], [180, 0]],
  "endArrowhead": "arrow",
  "startBinding": { "elementId": "api", "fixedPoint": [1, 0.5] },
  "endBinding": { "elementId": "db", "fixedPoint": [0, 0.5] }
}
```

## Reference Files

- For palette and contrast guidance, read [references/colors.md](references/colors.md).
- For copy-pasteable diagram patterns, read [references/examples.md](references/examples.md).
- For dark-background diagrams, read [references/dark-mode.md](references/dark-mode.md).

## Anti-Patterns

- Do not cram many tiny nodes into one canvas when two simpler diagrams would read better.
- Do not put all shapes first and all text last; that usually breaks layering and bindings.
- Do not guess at Excalidraw-only properties you have not already seen in a working example.
- Do not replace an editable diagram request with a static PNG export unless the user asked for the export.
