# Rendering

Use this reference when the plan and `script.py` are ready.

## CLI Reference

```bash
manim -ql script.py Scene1Introduction Scene2CoreConcept
manim -qm script.py Scene2CoreConcept
manim -qh script.py Scene1Introduction
manim -s -ql script.py Scene2CoreConcept
manim --save_sections -ql script.py Scene3LongWalkthrough
```

`-ql` is the default draft loop. Use `-qm` when text density makes 480p too noisy to judge. Use `-qh` only after timing and layout are already correct.

For an ordinary user request like "create a short animation explaining X", the default finish line is:

- all scene classes render successfully at draft quality
- `concat.txt` matches the rendered clip paths
- a stitched draft video exists when `ffmpeg` is available

Do not stop after writing `plan.md` and `script.py` if draft rendering is possible.

Use `manim ...` as the default render command. This works well with `uv tool install manim`.

Use `python3 -m manim ...` only when the host interpreter has Manim installed but the `manim` CLI is not available on `PATH`.

## Draft First

Read `production-quality.md` before committing to `-qh`.

Render workflow:

1. Draft render all scenes at `-ql`.
2. Fix and re-render only the scenes that are broken or unclear.
3. Update `concat.txt` to match the rendered clip paths.
4. Stitch the draft clips with `ffmpeg`.
5. Review the stitched draft before any `-qh` production render.

For the normal one-turn path, render all scene classes at `-ql`, then stitch the draft clips. Only escalate to `-qh` when the user explicitly asks for a final or high-quality export.

Render only the scenes you are actively changing:

```bash
manim -ql script.py Scene1Introduction
manim -ql script.py Scene2CoreConcept Scene3WrapUp
```

If the scene list is stable, rendering all scenes in one command is fine:

```bash
manim -ql script.py Scene1Introduction Scene2CoreConcept Scene3WrapUp
```

Use `-qm` when 480p is too rough to judge spacing:

```bash
manim -qm script.py Scene2CoreConcept
```

## Still Preview

For a fast layout check:

```bash
manim -s -ql script.py Scene2CoreConcept
```

## Production Render

Only after the draft timing and layout are correct:

```bash
manim -qh script.py Scene1Introduction Scene2CoreConcept Scene3WrapUp
```

Before this step, confirm:

- subtitles exist for major beats
- all scenes have clean exits
- typography and palette are consistent
- `concat.txt` points at the quality folder you just rendered

Do not ask the user to choose between a preview render and a full render unless they explicitly asked for that choice. Default to the stitched draft render first.

## `manim.cfg`

For repeat renders in the same project, prefer a local `manim.cfg` over repeating long flag strings.

The file must be named `manim.cfg` and sit in the same directory as `script.py`.

```ini
[CLI]
quality = low_quality
media_dir = ./media
background_color = #0D1117
save_sections = False
```

Use it when:

- the same quality preset is being rerun repeatedly
- you want a stable `media/` location
- the project needs predictable background color or output behavior

Do not create `manim.cfg` for a one-off toy render unless it reduces repeated command noise.

## Sections And Long Scenes

Use sections when one scene contains multiple reviewable chapters.

```python
class Scene3LongWalkthrough(Scene):
    def construct(self) -> None:
        self.next_section("Overview")
        self.play(FadeIn(title))
        self.wait(0.5)

        self.next_section("Failure path")
        self.play(GrowArrow(error_path))
        self.wait(0.5)
```

Then render with:

```bash
manim --save_sections -ql script.py Scene3LongWalkthrough
```

Rules:

- each section needs at least one real animation
- use sections for long explainers, not every tiny beat
- keep section names descriptive enough for rerendering and review

## Voiceover Workflow

If the project truly needs narration, prefer one of these paths:

1. render visually first and mux audio with `ffmpeg`
2. if you control a Python environment that contains both `manim` and `manim-voiceover`, use `VoiceoverScene` for timing-sensitive narration

```python
from manim import *
from manim_voiceover import VoiceoverScene


class NarratedScene(VoiceoverScene):
    def construct(self) -> None:
        with self.voiceover(text="The email arrives at the gateway.") as tracker:
            self.play(GrowArrow(flow_arrow), run_time=tracker.duration)
```

Use voiceover when spoken timing is central to the animation. Otherwise subtitles plus a clean visual beat structure are enough.

## Stitching

Generate `concat.txt` with one line per scene clip, then run:

```bash
ffmpeg -y -f concat -safe 0 -i concat.txt -c copy final.mp4
```

If you switch quality presets, update the paths in `concat.txt` to match the rendered media directory.

## Output Paths

Typical Manim output layout:

```text
media/
  videos/
    script/
      480p15/
      720p30/
      1080p60/
```

## Troubleshooting

- `No module named manim`: if `manim --version` works, a global uv tool install is fine and you can use the `manim ...` CLI directly. Otherwise install with `uv tool install manim` or `python3 -m pip install manim`.
- `pdflatex: command not found`: install a TeX distribution. Good defaults are `brew install --cask mactex-no-gui` on macOS, `sudo apt install texlive-full` on Debian/Ubuntu, or `sudo dnf install texlive-scheme-full` on Fedora.
- `Text clips off the frame or feels huge`: switch titles and sentence copy back to a sans font, reduce title size toward `34-38`, and clamp width before `.to_edge(...)`.
- `Small labels look noisy`: use `MONO = "Menlo"` only for code-like chips or identifiers, not for full-sentence titles.
- `FileNotFoundError` during stitch: regenerate or edit `concat.txt` so the quality folder and scene names match the actual renders.
- `LaTeX Error`: remove `MathTex` temporarily or install `pdflatex`.
- `A long scene is painful to rerender`: add `next_section(...)` markers and render with `--save_sections`.
- `Voiceover timing drifts`: drive animation length from the voiceover tracker or move narration back to a post-production ffmpeg pass.
- Very slow iteration: render a single scene at `-ql` instead of the whole project.
