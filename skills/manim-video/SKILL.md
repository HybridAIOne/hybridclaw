---
name: manim-video
description: Plan, script, render, and stitch Manim Community Edition videos in Python. Use when the user asks for animated math explanations, algorithm walkthroughs, equation derivations, technical concept videos, 3Blue1Brown-style explainers, or programmatic educational motion graphics.
user-invocable: true
disable-model-invocation: false
requires:
  bins:
    - python3
metadata:
  hybridclaw:
    category: publishing
    short_description: "Python-first Manim video pipeline."
    tags:
      - video
      - animation
      - manim
      - python
      - math
    install:
      - id: uv-manim
        kind: uv
        package: manim
        bins: ["manim"]
        label: Install Manim Community Edition with uv
      - id: brew-ffmpeg
        kind: brew
        formula: ffmpeg
        bins: ["ffmpeg"]
        label: Install ffmpeg (brew)
---

# Manim Video

Use this skill for Python-based Manim projects that need a clean planning phase, reusable scene structure, and a deterministic render pipeline.

The output contract is usually a workspace project directory containing `plan.md`, `script.py`, `concat.txt`, draft renders, and optionally a stitched `final.mp4`.

## Default Workflow

1. Run the bundled setup check first:
```bash
python3 skills/manim-video/scripts/check_setup.py --format text
```
2. If the user wants a new project scaffold, initialize one:
```bash
python3 skills/manim-video/scripts/init_project.py manim-video-project --title "Why Gradient Descent Works" --scene Introduction --scene Geometry --scene UpdateRule
```
3. Fill in `plan.md` before heavy coding. Read [references/scene-planning.md](references/scene-planning.md) when the narrative or scene order is still fuzzy.
4. Implement `script.py` with one `Scene` subclass per clip. Use [references/python-patterns.md](references/python-patterns.md) for the starter structure and common Manim patterns.
5. Iterate in draft quality first with `python3 -m manim -ql ...`. Do not jump straight to high-quality renders.
6. When the scenes are correct, stitch the clip files with `ffmpeg`. Use [references/rendering.md](references/rendering.md) for the exact command shapes.

If required tools are missing, the fallback is still useful:

- create `plan.md`
- write or revise `script.py`
- explain what still needs to be installed
- stop short of claiming a video was rendered

## Working Rules

- Keep all project files in the workspace or in a user-specified output directory. Do not write task-specific files under `skills/manim-video/`.
- Use Python entry points by default: prefer `python3 -m manim ...` over shell wrappers.
- Treat `plan.md` as the source of truth for audience, teaching goal, palette, and scene order.
- Make every scene independently renderable. One class per scene keeps rerenders cheap.
- Prefer visual intuition before dense symbolic derivation. Show the shape or process before the final formula.
- Use shared constants at the top of `script.py` for colors, sizes, and timing so scenes stay visually consistent.
- For math-heavy scenes, use raw strings with `MathTex`, for example `MathTex(r"\\frac{1}{2}")`.
- If `pdflatex` is unavailable, avoid `MathTex` and `Tex` until LaTeX is installed; use `Text` placeholders instead.
- Iterate at `-ql` or `-qm`. Only render `-qh` after the draft timing and layout are already correct.
- Do not claim `final.mp4` exists unless the render and stitch steps actually succeeded.

## Common Commands

Setup check:

```bash
python3 skills/manim-video/scripts/check_setup.py --format text
```

Initialize a new project:

```bash
python3 skills/manim-video/scripts/init_project.py my-video --title "Binary Search" --scene Introduction --scene Invariant --scene Conclusion
```

Draft render:

```bash
cd my-video
python3 -m manim -ql script.py Scene1Introduction Scene2Invariant
```

Preview a still frame:

```bash
python3 -m manim -s -ql script.py Scene2Invariant
```

Stitch clips:

```bash
ffmpeg -y -f concat -safe 0 -i concat.txt -c copy final.mp4
```

## References

- [references/scene-planning.md](references/scene-planning.md)
- [references/python-patterns.md](references/python-patterns.md)
- [references/rendering.md](references/rendering.md)

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/manim-video
```
