# Python Patterns

Use this reference when writing or revising `script.py`.

## Starter Structure

```python
from manim import *

BG = "#0B1220"
PRIMARY = "#7DA2FF"
SECONDARY = "#9AB6FF"
ACCENT = "#7EE3A5"
HIGHLIGHT = "#E5EDF7"
SUBTLE = "#93A4B8"
SANS = "Avenir Next"
MONO = "Menlo"
TITLE_SIZE = 38
HEADING_SIZE = 30
BODY_SIZE = 22
LABEL_SIZE = 18
CAPTION_SIZE = 18
REVEAL_TIME = 1.2
SHORT_WAIT = 0.6
KEY_WAIT = 1.2
EXIT_TIME = 0.5
TITLE_MAX_WIDTH = 11.0
TEXT_MAX_WIDTH = 10.6
EDGE_BUFF = 0.6


def clean_exit(scene: Scene) -> None:
    if scene.mobjects:
        scene.play(FadeOut(Group(*scene.mobjects)), run_time=EXIT_TIME)
        scene.wait(0.3)


def fit_text(mob: Mobject, *, max_width: float = TEXT_MAX_WIDTH) -> Mobject:
    if mob.width > max_width:
        mob.set_width(max_width)
    return mob


def make_title(text: str, color: str = PRIMARY) -> Mobject:
    title = Text(text, font=SANS, font_size=TITLE_SIZE, color=color, weight=BOLD)
    return fit_text(title, max_width=TITLE_MAX_WIDTH).to_edge(UP, buff=EDGE_BUFF)


class Scene1Introduction(Scene):
    def construct(self) -> None:
        self.camera.background_color = BG

        title = make_title("Why Binary Search Works")
        subtitle = MarkupText(
            '<span fgcolor="#E5EDF7">Cut the search interval in half each step.</span>',
            font=SANS,
            font_size=BODY_SIZE,
        )
        stack = fit_text(Group(title, subtitle).arrange(DOWN, buff=0.35), max_width=10.4)
        self.add_subcaption("Binary search works by shrinking the interval after each comparison.", duration=2.5)

        self.play(Write(title), run_time=REVEAL_TIME)
        self.wait(SHORT_WAIT)
        self.play(FadeIn(subtitle, shift=UP * 0.2), run_time=0.8)
        self.wait(KEY_WAIT)
        self.play(FadeOut(stack), run_time=EXIT_TIME)
```

## Rules

- Set `self.camera.background_color` in every scene.
- Keep shared palette, opacity, font, size, and timing constants at the top of the file.
- Use a clean sans font constant like `SANS = "Avenir Next"` for titles, subtitles, and sentence copy.
- Reserve `MONO = "Menlo"` for code-like labels, identifiers, queue names, terminal snippets, and short technical chips.
- Prefer `MarkupText` for inline emphasis, colored spans, or multi-weight labels.
- Put subtitles on every significant reveal with `self.add_subcaption(...)` or `subcaption=`.
- Prefer `VGroup(...).arrange(...)` over hand-tuned coordinates when layout is simple.
- Use `Group`, not `VGroup`, when mixed `Text` and shapes appear together.
- Clamp every title with `make_title(...)` or `fit_text(...)` before it reaches the frame edge.
- Keep titles around `34-38`, body copy around `20-24`, and labels around `16-18` unless the scene is intentionally sparse.
- Clamp long text with `fit_text(...)` or `set_width(...)` before it reaches the frame edge.
- Keep centered title stacks to 2 text blocks. If explanation keeps growing, move it into a side note, bottom caption, or a separate scene.
- If more than 4 text elements are strongly visible, reduce body text toward `20-24` and labels toward `18-20`.
- Use `buff >= EDGE_BUFF` for `.to_edge(...)` text.
- Use `FadeOut` or `ReplacementTransform` before introducing competing text in the same area.
- Make scene classes independent so rerendering one scene does not depend on another.
- Give scenes clean exits with `FadeOut(Group(*self.mobjects))`.
- Keep adjacent scenes from all using the same layout and same animation entry.
- Reach for `ValueTracker` plus `add_updater` or `always_redraw` when the scene depends on a continuously changing value.
- For long multi-part scenes, `self.next_section(...)` keeps rerenders and reviews local.

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
- Keep structural elements around 0.12-0.2 opacity instead of full brightness.

## Dense Text Pattern

```python
headline = fit_text(
    Text("Two routes into the gateway", font=SANS, font_size=HEADING_SIZE, color=PRIMARY, weight=BOLD),
    max_width=10.8,
)
left_note = MarkupText("<b>Inbound email</b><br/>becomes a queued task.", font=SANS, font_size=22, color=SECONDARY)
right_note = MarkupText("<b>Agent tools</b><br/>pick up the queued work.", font=SANS, font_size=22, color=ACCENT)

headline.to_edge(UP, buff=EDGE_BUFF)
left_note = fit_text(left_note, max_width=4.8).to_edge(LEFT, buff=EDGE_BUFF)
right_note = fit_text(right_note, max_width=4.8).to_edge(RIGHT, buff=EDGE_BUFF)
```

Use this instead of stacking three or four centered paragraphs.

## Reactive Pattern

```python
progress = ValueTracker(0)
pointer = always_redraw(lambda: Dot(line.n2p(progress.get_value()), color=ACCENT))
caption = Text("Scanning", font=MONO, font_size=CAPTION_SIZE, color=SECONDARY)
caption.add_updater(lambda m: m.next_to(pointer, UP, buff=0.2))

self.add(pointer, caption)
self.play(progress.animate.set_value(5), run_time=2.0, rate_func=linear)
```

## Cleanup Pattern

```python
self.play(FadeOut(Group(*self.mobjects)), run_time=0.5)
self.wait(0.3)
```

Use it when the next scene should start from a blank canvas.

## Common Mistakes

- Writing new text on top of old text without transition
- Keeping three or more centered text blocks stacked vertically
- Using `Menlo` for full-sentence titles or body copy
- Leaving a long title unclamped at `font_size=48`
- Leaving dense scenes at `font_size=28` when they need `20-24`
- Skipping subtitles on key reveals
- Using `MathTex` without raw strings
- Starting at production quality instead of draft quality
- Reusing unrelated colors from scene to scene
- Building one giant scene when the idea should be split
