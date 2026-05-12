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
      - id: manim
        kind: uv
        package: manim
        bins: ["manim"]
        label: Install Manim Community Edition with uv
      - id: ffmpeg
        kind: brew
        formula: ffmpeg
        bins: ["ffmpeg"]
        label: Install ffmpeg (brew)
---

# Manim Video

Use this skill for Python-based Manim projects that need a clean planning phase, strong visual direction, reusable scene structure, and a deterministic render pipeline.

The output contract is usually a workspace project directory containing `plan.md`, `script.py`, `concat.txt`, draft renders, and optionally a stitched `final.mp4`.

## Creative Standard

This is educational cinema, not animated slides.

- Make it beautiful and professional. The draft should feel intentional, polished, and presentation-ready, not like a rough internal diagram dump.
- Before writing code, define the narrative arc: confusion -> visual hook -> mechanism -> payoff -> recap.
- Geometry before algebra. Show the shape, motion, system flow, or data change before the formal equation.
- Every scene teaches one dominant idea. If a scene has two unrelated claims, split it.
- Direct attention with opacity layering: primary elements at 1.0, contextual elements around 0.35-0.45, and structural elements like axes or grids around 0.12-0.2.
- Give reveals breathing room. Add `self.wait()` after every important animation and make the main aha moment the longest pause.
- Keep one cohesive visual language across the whole project: shared palette, shared timing constants, shared font rules, and stable concept-color meaning.
- Avoid repetitive scenes. Vary dominant color, layout, and entry animation across scenes while keeping the overall palette consistent.
- First-render quality matters. If the layout is cluttered, the typography is inconsistent, or the pacing feels rushed, the scene is not done.

## Modes

| Mode | Input | Output | Primary references |
|------|-------|--------|--------------------|
| Concept explainer | topic or feature | intuitive multi-scene explainer | `scene-planning.md`, `visual-design.md` |
| Equation derivation | symbolic expression or proof goal | stepwise animated derivation | `equations.md`, `python-patterns.md` |
| Algorithm visualization | algorithm or invariant | stepwise state evolution | `graphs-and-data.md`, `python-patterns.md` |
| Data story | metrics, counters, or comparisons | animated charts and deltas | `graphs-and-data.md`, `visual-design.md` |
| Architecture diagram | system or service flow | progressive build with data flow | `scene-planning.md`, `python-patterns.md` |
| Paper explainer | paper, abstract, or finding | hook -> method -> evidence explainer | `scene-planning.md`, `visual-design.md` |
| Camera or 3D explainer | spatial or geometric topic | moving-camera or 3D scene set | `camera-and-3d.md`, `visual-design.md` |

## Stack

Single Python script per project. No browser, no Node.js, no GPU requirement.

| Layer | Tool | Purpose |
|-------|------|---------|
| Core | Manim Community Edition | scene rendering and animation engine |
| Math | LaTeX via `MathTex` / `Tex` | equation rendering |
| Video I/O | ffmpeg | stitching, muxing, and format conversion |
| Narration | subtitles by default, voiceover optional | accessibility and pacing |
| Setup check | `check_setup.py` | host capability validation and install hints |

## Pipeline

`PLAN --> CODE --> RENDER --> STITCH --> AUDIO --> REVIEW`

- `PLAN`: write `plan.md` with the narrative arc, misconception, aha moment, palette, typography, and scene beats.
- `CODE`: write `script.py` with one independently renderable `Scene` subclass per clip.
- `RENDER`: draft render all scenes at `-ql` unless a real render blocker prevents it.
- `STITCH`: update `concat.txt` and stitch a draft video when `ffmpeg` is available.
- `AUDIO`: add narration or music only when the user asks for it or the project explicitly includes it.
- `REVIEW`: verify timing, readability, clean exits, and overall visual coherence before claiming the output is done.

## Creative Direction

### Color Palettes

| Palette | Background | Primary | Secondary | Accent | Use case |
|---------|------------|---------|-----------|--------|----------|
| HybridClaw Dark | `#0B1220` | `#7DA2FF` | `#9AB6FF` | `#7EE3A5` | default for systems, tools, and architecture |
| HybridClaw Light | `#F8FAFC` | `#4A6CF7` | `#3657E9` | `#15803D` | brighter docs-style explainer look |
| HybridClaw Neutral | `#111827` | `#E5EDF7` | `#93A4B8` | `#7DA2FF` | minimal or formal topics |

Start with a HybridClaw palette unless the user explicitly asks for a different visual language.

### Animation Speed

| Context | Typical `run_time` | Typical `self.wait()` after |
|---------|--------------------|-----------------------------|
| Title or intro hook | `1.2-1.8s` | `0.8-1.2s` |
| Key equation or mechanism reveal | `1.8-2.2s` | `1.5-2.5s` |
| Transform or morph | `1.2-1.8s` | `1.0-1.5s` |
| Supporting annotation | `0.6-1.0s` | `0.3-0.6s` |
| Fade-out cleanup | `0.4-0.7s` | `0.2-0.4s` |
| Aha moment | `2.0-2.8s` | `2.0-3.0s` |

### Typography Scale

| Role | Font size | Usage |
|------|-----------|-------|
| Title | `34-38` | scene titles and opening claims |
| Heading | `28-32` | section headers within a scene |
| Body | `20-24` | explanatory text |
| Label | `18-20` | annotations, axis labels, component names |
| Caption | `18` | subtitles and supporting notes |

### Font Rules

| Text type | Default choice | Notes |
|-----------|----------------|-------|
| Titles and sentence copy | `Text(..., font=SANS)` | prefer a clean sans like `SANS = "Avenir Next"` or another installed equivalent |
| Styled inline emphasis | `MarkupText(..., font=SANS)` | best for colored spans or bold fragments |
| Code-like labels | `Text(..., font=MONO)` | use `MONO = "Menlo"` only for identifiers, commands, chips, or short technical tags |
| Math | `MathTex(...)` / `Tex(...)` | requires LaTeX |

Minimum readable text size is `font_size=18`.

Text density rules:

- If more than 4 text elements are strongly visible, reduce body text toward `20-24` instead of `26-30`.
- Keep title/subtitle stacks to 2 text blocks. If a third block is needed, move it to a side label, caption, or a new scene.
- Clamp all titles before `.to_edge(...)`, for example `fit_text(title, max_width=11.0)`.
- Clamp any potentially long text block to the usable frame width instead of trusting the raw `font_size`.
- If a width-clamped title still feels oversized, lower it toward `34-36` or split it into 2 lines. Do not keep a full-sentence title at `48`.
- Do not write new text on top of old text in the same area. Use `ReplacementTransform`, `FadeOut`, or a layout shift first.
- Use `buff >= 0.5` for edge-positioned text so draft renders do not clip.

### Performance Targets

| Quality | Resolution | FPS | Use case |
|---------|------------|-----|----------|
| `-ql` | 854x480 | 15 | draft iteration and timing checks |
| `-qm` | 1280x720 | 30 | text-heavy preview and layout review |
| `-qh` | 1920x1080 | 60 | production export only |

## Default Workflow

1. Run the bundled setup check first:
```bash
python3 skills/manim-video/scripts/check_setup.py
```
Treat the setup check as advisory by default. Missing `manim`, `ffmpeg`, or `pdflatex` should stop render commands, but it must not stop planning or script editing.
2. If the user wants a new project, create the target directory and write `plan.md`, `script.py`, and `concat.txt` directly. Preserve the exact requested output path.
3. Fill in `plan.md` before heavy coding. Read [references/scene-planning.md](references/scene-planning.md) and [references/visual-design.md](references/visual-design.md) when the narrative, pacing, or screen layout is still fuzzy. When the user already gave a topic, draft the audience, teaching objective, misconception, aha moment, narrative arc, palette, typography, subtitle strategy, and scene beats yourself instead of asking the user to fill placeholders.
4. Keep reference loading small. For a normal request, start with only these core references:
   - planning and scene beats: [references/scene-planning.md](references/scene-planning.md)
   - layout, typography, and pacing: [references/visual-design.md](references/visual-design.md)
   - shared constants, title helpers, and scene structure: [references/python-patterns.md](references/python-patterns.md)
   Read at most 3 references before the first draft of `script.py`. Do not bulk-read the whole reference folder.
5. Add only one specialty reference when the task actually needs it:
   - symbolic derivations: [references/equations.md](references/equations.md)
   - charts, counters, and algorithm state: [references/graphs-and-data.md](references/graphs-and-data.md)
   - moving cameras or 3D scenes: [references/camera-and-3d.md](references/camera-and-3d.md)
   - reactive geometry or continuously changing values: [references/updaters-and-trackers.md](references/updaters-and-trackers.md)
6. Read stage-specific references only when you reach that stage:
   - render and stitch commands: [references/rendering.md](references/rendering.md)
   - failures or confusing Manim behavior: [references/troubleshooting.md](references/troubleshooting.md)
   - final polish before `-qh` or claiming the draft is done: [references/production-quality.md](references/production-quality.md)
7. Implement `script.py` with one `Scene` subclass per clip. Use shared constants for palette, typography, and timing. Put subtitles on significant animations, keep scene exits clean, and make every scene independently renderable.
8. For ordinary requests like "create a short animation explaining X", do not stop after planning and scripting when rendering is available. Produce a draft render in the same turn: render all scene classes at `-ql`, update `concat.txt`, and stitch a draft video if `ffmpeg` is available. Render is part of the normal pipeline, not an optional next step.
9. Use `manim ...` as the default render entry point. A global `manim` CLI from `uv tool install manim` is fine. Fall back to `python3 -m manim ...` only when Manim is installed into the host interpreter but the CLI is unavailable.
10. Before production render, run the production checklist in [references/production-quality.md](references/production-quality.md). Use `-qh` only when the user explicitly asks for a final or high-quality export. For the default one-turn path, a stitched draft render is the finish line. Use [references/rendering.md](references/rendering.md) for the exact command shapes.

If required tools are missing, the fallback is still useful:

- create `plan.md`
- write or revise `script.py`
- explain what still needs to be installed
- stop short of claiming a video was rendered

## Working Rules

- Keep all project files in the workspace or in a user-specified output directory. Do not write task-specific files under `skills/manim-video/`.
- If the user supplies a target directory such as `./tmp/manim-smoke`, preserve that path exactly. Do not invent a new directory name, prepend the repo name, or compress the topic into the path.
- Prefer `manim ...` as the default render command. `python3 -m manim ...` is a fallback, not the primary path.
- For explicit planning-only requests such as "just plan it", "only write the files", or "stop after creating files", first run `check_setup.py`, then write `plan.md`, `script.py`, and `concat.txt`, then stop and report the created files.
- For ordinary requests such as "create a short animation explaining X", continue through the full pipeline in the same turn: fill `plan.md`, write topic-specific `script.py`, render the draft scenes, and stitch a draft video when possible. Only stop early if the user asked to stop after setup or a real render blocker prevents progress.
- If `check_setup.py` reports missing render dependencies, continue with planning and script generation. Only block `manim ...`, `python3 -m manim ...`, preview renders, and final stitching when the missing dependency actually matters for that step.
- Do not ask "Would you like me to continue?" or offer a preview-vs-full-render choice for an ordinary create request. If draft rendering is available, do it. Reserve follow-up questions for real blockers, explicit quality choices, or user-directed revisions.
- Treat `plan.md` as the source of truth for audience, teaching goal, misconception, palette, typography, scene order, pacing, and scene variation.
- Do not reply that the generated plan is empty or ask the user to provide basic teaching goals, visuals, or narration when those can be inferred from the request.
- Make every scene independently renderable. One class per scene keeps rerenders cheap.
- Prefer visual intuition before dense symbolic derivation. Show the shape or process before the final formula.
- Make every scene look presentation-ready. If the frame feels amateur, cramped, or default-looking, revise layout, typography, spacing, or color before calling it done.
- Use shared constants at the top of `script.py` for colors, opacities, fonts, sizes, and timing so scenes stay visually consistent.
- Use a clean sans font for titles, subtitles, and sentence-level copy. Reserve `MONO = "Menlo"` for code-like chips, identifiers, terminal snippets, or very short technical labels.
- Good starter constants are `SANS = "Avenir Next"` or another installed sans, `MONO = "Menlo"`, `TITLE_SIZE = 38`, `BODY_SIZE = 22`, `LABEL_SIZE = 18`, and `CAPTION_SIZE = 18`.
- Use `MarkupText` when a label needs mixed emphasis, inline colors, or controlled span styling. Do not simulate styled text by stacking many tiny `Text` objects unless the layout truly requires it.
- If more than 4 text elements are simultaneously visible, reduce body text toward `20-24` and labels toward `18-20` instead of leaving the default larger sizes.
- Keep centered title stacks to at most 2 text blocks. If more explanation is needed, move it to a side callout, a bottom note, or the next scene.
- Clamp long text to the usable frame width. Do not assume long copy will fit just because the font size looks reasonable in code.
- Create titles through a width-clamp helper before calling `.to_edge(...)`. Do not place a raw long title at `font_size=48` and hope it fits.
- Use `buff >= 0.5` for `.to_edge(...)` text placement.
- Replace or fade old text before writing new text in the same screen region.
- Put `self.add_subcaption(...)` or `subcaption=` on every title beat, key reveal, and summary beat.
- Vary dominant color, layout, and animation entry from scene to scene. Do not make every scene a centered title plus subtitle with the same motion.
- Keep no more than 5-6 strongly visible elements at once. Dim older context instead of leaving every object at full emphasis.
- For math-heavy scenes, use raw strings with `MathTex`, for example `MathTex(r"\\frac{1}{2}")`.
- If `pdflatex` is unavailable, avoid `MathTex` and `Tex` until LaTeX is installed; use `Text` placeholders instead. Fast package hints: macOS `brew install --cask mactex-no-gui`, Debian/Ubuntu `sudo apt install texlive-full`, Fedora `sudo dnf install texlive-scheme-full`.
- Use `Group(*self.mobjects)` rather than `VGroup(*self.mobjects)` when fading out mixed `Text`, `MathTex`, and shape content.
- Use `ValueTracker`, `add_updater`, or `always_redraw` when the scene depends on a continuously changing parameter. Do not hand-recompute dependent geometry before every `self.play()` if the relationship is conceptually continuous.
- Prefer a well-labeled static diagram when motion does not teach anything new. Do not animate just because Manim can.
- End scenes cleanly. Fade or transform old content away before the next major section instead of hard-cutting between unrelated layouts.
- Iterate at `-ql` or `-qm`. Only render `-qh` after the draft timing and layout are already correct.
- For long scenes or videos with clear chapter boundaries, use `self.next_section(...)` and render with `--save_sections` so rerenders stay local and review is easier.
- The default delivery for a normal request is: `plan.md`, topic-specific `script.py`, rendered draft scene clips, updated `concat.txt`, and a stitched draft video when `ffmpeg` is available.
- Run the production checklist before claiming a scene is final.
- Do not claim `final.mp4` exists unless the render and stitch steps actually succeeded.

## Common Commands

Setup check:

```bash
python3 skills/manim-video/scripts/check_setup.py
```

Strict render gate:

```bash
python3 skills/manim-video/scripts/check_setup.py --strict
```

Install Manim globally with uv:

```bash
uv tool install manim
```

LaTeX install hints for `MathTex` and `Tex`:

```bash
brew install --cask mactex-no-gui
sudo apt install texlive-full
sudo dnf install texlive-scheme-full
```

Create a new project directory:

```bash
mkdir -p my-video
cd my-video
```

Render a draft:

```bash
cd my-video
manim -ql script.py Scene1Introduction Scene2Invariant
```

Host-Python fallback render:

```bash
cd my-video
python3 -m manim -ql script.py Scene1Introduction Scene2Invariant
```

Host-CLI fallback render:

```bash
cd my-video
manim -ql script.py Scene1Introduction Scene2Invariant
```

Preview a still frame:

```bash
cd my-video
manim -s -ql script.py Scene2Invariant
```

Stitch clips:

```bash
ffmpeg -y -f concat -safe 0 -i concat.txt -c copy final.mp4
```

## References

- [references/scene-planning.md](references/scene-planning.md)
- [references/visual-design.md](references/visual-design.md)
- [references/equations.md](references/equations.md)
- [references/graphs-and-data.md](references/graphs-and-data.md)
- [references/camera-and-3d.md](references/camera-and-3d.md)
- [references/updaters-and-trackers.md](references/updaters-and-trackers.md)
- [references/python-patterns.md](references/python-patterns.md)
- [references/rendering.md](references/rendering.md)
- [references/troubleshooting.md](references/troubleshooting.md)
- [references/production-quality.md](references/production-quality.md)

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/manim-video
```
