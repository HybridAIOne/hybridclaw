# Python Patterns

Use this reference when writing or revising `script.py`.

## Starter Structure

```python
from manim import *

BG = "#0F172A"
PRIMARY = "#38BDF8"
SECONDARY = "#F8FAFC"
ACCENT = "#F59E0B"


class Scene1Introduction(Scene):
    def construct(self) -> None:
        self.camera.background_color = BG

        title = Text("Why Binary Search Works", font_size=48, color=PRIMARY, weight=BOLD)
        subtitle = Text("Cut the search interval in half each step.", font_size=26, color=SECONDARY)
        stack = VGroup(title, subtitle).arrange(DOWN, buff=0.35)

        self.play(Write(title), run_time=1.2)
        self.wait(0.5)
        self.play(FadeIn(subtitle, shift=UP * 0.2), run_time=0.8)
        self.wait(1.0)
        self.play(FadeOut(stack), run_time=0.5)
```

## Rules

- Set `self.camera.background_color` in every scene.
- Keep shared color and timing constants at the top of the file.
- Prefer `VGroup(...).arrange(...)` over hand-tuned coordinates when layout is simple.
- Use `FadeOut` or `ReplacementTransform` before introducing competing text in the same area.
- Make scene classes independent so rerendering one scene does not depend on another.

## MathTex

Use raw strings:

```python
expr = MathTex(r"f(x) = x^2")
```

If LaTeX is unavailable, use a `Text` placeholder until `pdflatex` is installed.

## Geometry And Charts

- Use `NumberLine`, `Axes`, `BarChart`, `Dot`, `Line`, and `Arrow` to make the mechanism visible before showing equations.
- Highlight one moving or changing object at a time.
- Keep supporting grid or axis lines visually quieter than the primary object.

## Cleanup Pattern

```python
self.play(FadeOut(VGroup(*self.mobjects)), run_time=0.5)
```

Use it when the next scene should start from a blank canvas.

## Common Mistakes

- Writing new text on top of old text without transition
- Using `MathTex` without raw strings
- Starting at production quality instead of draft quality
- Reusing unrelated colors from scene to scene
- Building one giant scene when the idea should be split
