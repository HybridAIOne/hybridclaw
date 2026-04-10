# Production Quality

Use this checklist before claiming the scene or final video is done.

## Pre-Code Checklist

- [ ] `plan.md` defines audience, misconception, aha moment, and narrative arc
- [ ] each scene has a target duration and one dominant idea
- [ ] palette and concept-color meaning are defined
- [ ] `SANS`, `MONO`, and shared size/timing constants are defined
- [ ] subtitle strategy is clear for each scene
- [ ] adjacent scenes vary in layout or dominant color

## Pre-Render Checklist

Before `-qh`:

- [ ] every scene renders at `-ql`
- [ ] the overall look feels beautiful, professional, and presentation-ready
- [ ] significant reveals include subtitles
- [ ] no text smaller than `font_size=18`
- [ ] titles and sentence copy use `SANS`; only code-like labels use `MONO`
- [ ] `MarkupText` is used for inline emphasis instead of awkward text stacking
- [ ] any scene with more than 4 visible text elements reduces body text toward `20-24`
- [ ] no centered stack uses more than 2 text blocks
- [ ] long titles are width-clamped before `.to_edge(...)`
- [ ] long text blocks are width-clamped before they can hit the frame edge
- [ ] `.to_edge(...)` text uses `buff >= 0.5`
- [ ] old text is replaced or faded before new text appears in the same region
- [ ] structural elements are dimmed
- [ ] every reveal has a pause
- [ ] every scene has a clean exit
- [ ] no scene keeps more than 5-6 strong elements on screen
- [ ] `concat.txt` matches the quality preset you intend to stitch

## Post-Render Checklist

After stitching:

- [ ] the opening 5 seconds are clear and visually intentional
- [ ] the pacing never feels rushed
- [ ] labels stay on screen long enough to read
- [ ] scene transitions feel smooth rather than abrupt
- [ ] the final takeaway frame stays up long enough to absorb
- [ ] the narration, subtitles, and visible beat timing agree with each other

## Tempo Curve

A good explainer usually feels like:

- scene 1: slow setup
- scene 2: medium build
- scene 3: medium-fast core motion
- scene 4: slower recap and takeaway

Not every scene should move at the same tempo.

## Beat Timing Reference

| Beat type | Animation time | Pause after |
|-----------|----------------|-------------|
| Title | `1.2-1.8s` | `0.8-1.2s` |
| Mechanism reveal | `1.5-2.2s` | `1.5-2.5s` |
| Aha moment | `2.0-2.8s` | `2.0-3.0s` |
| Supporting note | `0.6-1.0s` | `0.3-0.6s` |
| Scene exit | `0.4-0.7s` | `0.2-0.4s` |

## Text Layout Rules

Use these as hard heuristics:

- 1-2 centered text blocks: normal title-card layout is fine
- 3+ text blocks: switch to side notes, top/bottom layout, or split the scene
- 4+ strongly visible text elements: reduce body text toward `20-24`
- anything long: clamp width before rendering

Example:

```python
text = Text("This explanation can run long if left unconstrained.", font=SANS, font_size=22)
if text.width > config.frame_width - 1.0:
    text.set_width(config.frame_width - 1.0)
```

## Quality Failures

- scenes look like rough diagrams instead of polished explainers
- every scene uses the same centered layout
- every scene uses the same color emphasis
- no pause after the key reveal
- crowded frames with full-brightness context
- final render produced before draft layout issues were fixed
- subtitle timing that ends before the viewer can read the frame
- large text blocks colliding because width was never clamped
- oversized monospace titles clipped off the frame
- three stacked paragraphs in the middle of the frame
