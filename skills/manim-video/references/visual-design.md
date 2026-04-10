# Visual Design

Use this reference when the animation is technically correct but the layout, pacing, or hierarchy still feels weak.

## Core Principles

1. Geometry before algebra. Show the shape, process, or flow before the equation.
2. One new idea per scene. Older context should dim instead of competing.
3. Use opacity layering: primary 1.0, context 0.35-0.45, structure 0.12-0.2.
4. Keep concept-color meaning stable across the whole video.
5. Leave intentional empty space. A full frame is not always a readable frame.
6. Reuse a small motion vocabulary instead of inventing new animation styles every scene.
7. Give the viewer breathing room after each reveal.
8. Vary layout and dominant color between neighboring scenes so the video does not feel templated.

## Visual Hierarchy

Use these bands consistently:

| Layer | Typical opacity | Role |
|-------|-----------------|------|
| Primary | `1.0` | the thing the viewer should read first |
| Context | `0.35-0.45` | previous state or supporting comparison |
| Structure | `0.12-0.2` | axes, guides, grids, background scaffolding |

## Layout Templates

- `FULL_CENTER`: one hero object in the middle, title above, short note below
- `LEFT_RIGHT`: equation or labels on one side, mechanism on the other
- `TOP_BOTTOM`: headline or claim above, worked example below
- `GRID`: comparison matrices, algorithm states, multiple cases
- `PROGRESSIVE`: one item at a time arranged downward with aligned text
- `ANNOTATED_DIAGRAM`: central object with arrows and floating labels

## Palettes

Start with a HybridClaw palette unless the user explicitly wants a different visual language.

### HybridClaw Dark

```python
BG = "#0B1220"
PRIMARY = "#7DA2FF"
SECONDARY = "#9AB6FF"
ACCENT = "#7EE3A5"
HIGHLIGHT = "#E5EDF7"
SUBTLE = "#93A4B8"
```

### HybridClaw Light

```python
BG = "#F8FAFC"
PRIMARY = "#4A6CF7"
SECONDARY = "#3657E9"
ACCENT = "#15803D"
HIGHLIGHT = "#1F2937"
SUBTLE = "#6B7280"
```

### HybridClaw Neutral

```python
BG = "#111827"
PRIMARY = "#E5EDF7"
SECONDARY = "#93A4B8"
ACCENT = "#7DA2FF"
HIGHLIGHT = "#7EE3A5"
SUBTLE = "#263347"
```

## Typography

- Default to a clean sans font for titles, subtitles, and sentence copy, for example `SANS = "Avenir Next"` or another installed equivalent.
- Reserve `MONO = "Menlo"` for code-like labels, identifiers, or terminal-style chips.
- Minimum readable size: `font_size=18`.
- Suggested scale:
  - title: `34-38`
  - heading: `28-32`
  - body: `20-24`
  - label: `18-20`
  - caption: `18`
- Use `MathTex` for math instead of trying to fake equations with `Text`.
- Long sentence titles are the first place drafts go wrong. Clamp them before `.to_edge(...)` and split them into 2 lines before making the font huge.

## Text Density

Use these rules before adding another line of copy:

- 1-2 centered text blocks is normal
- 3 centered text blocks is a warning sign
- 4+ visible text elements means the scene should usually shrink body text toward `20-24`
- if the copy is still long after shrinking, change layout or split the beat

Long text should be width-clamped before render. Large font plus unconstrained width is the main reason scenes look crowded.
Long titles should be width-clamped before edge placement. Oversized monospace titles are the most common clipping failure in system explainers.

## Timing Feel

| Beat | Visual feel |
|------|-------------|
| Hook | crisp and readable |
| Build | steady and cumulative |
| Aha | slightly slower, with the longest pause |
| Cleanup | fast and decisive |

If every beat feels identical, the scene will feel mechanical even when the code is correct.

## Layout Examples

- `FULL_CENTER`: single hero object, short subtitle, clean negative space
- `LEFT_RIGHT`: mechanism on one side, explanation on the other
- `TOP_BOTTOM`: claim first, worked example below
- `GRID`: comparisons, matrices, state snapshots
- `ANNOTATED_DIAGRAM`: central box or object with minimal callouts

## Per-Scene Variation

For each scene, deliberately vary at least two of these:

- dominant color
- layout
- entry animation
- camera framing
- density of visible elements

Do not vary the whole system. The palette, font family, and timing vocabulary should still feel related.

## Quick Polish Moves

- dim stale context before revealing the new focal object
- replace stacked tiny labels with one stronger callout
- add a `BackgroundRectangle` behind text over dense visuals
- trade one busy scene for two smaller scenes
- keep at least one side of the frame visually light
- replace a third centered paragraph with a side note or caption

## Frame Checklist

For every important frame, ask:

- What is the one thing the viewer should look at?
- What can be dimmed to context?
- Is there enough empty space?
- Is the text readable at phone size?
- Does the color emphasis match the conceptual emphasis?
- Would a static frame explain this better than another animation?
- Is the text stack too tall for the chosen layout?
