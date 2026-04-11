# Equations

Use this reference for derivations, symbolic transformations, and math-heavy scenes.

## Raw Strings Always

```python
MathTex(r"\frac{a}{b}")
MathTex(r"\nabla L = \frac{\partial L}{\partial w}")
```

Do not pass LaTeX without a raw string.

## Build Equations Step By Step

```python
step1 = MathTex(r"a^2 + b^2 = c^2")
step2 = MathTex(r"a^2 = c^2 - b^2")

self.play(Write(step1), run_time=1.5)
self.wait(1.2)
self.play(TransformMatchingTex(step1, step2), run_time=1.5)
self.wait(1.2)
```

## Selective Color

```python
eq = MathTex(r"a^2", r"+", r"b^2", r"=", r"c^2")
eq[0].set_color(PRIMARY)
eq[2].set_color(SECONDARY)
eq[4].set_color(ACCENT)
```

Use color to track concept meaning, not decoration.

## Incremental Reveal

```python
parts = MathTex(
    r"f(x)",
    r"=",
    r"\sum_{n=0}^{\infty}",
    r"\frac{f^{(n)}(a)}{n!}",
    r"(x-a)^n",
)
self.play(Write(parts[0:2]))
self.wait(0.5)
self.play(Write(parts[2]))
self.wait(0.5)
self.play(Write(parts[3:]))
```

## Highlighting And Annotation

```python
highlight = SurroundingRectangle(eq[2], color=ACCENT, buff=0.1)
brace = Brace(eq, DOWN, color=ACCENT)
label = brace.get_text("Key term", font_size=24)
```

Use highlights to focus attention, then remove them after the idea lands.

## Dense Equations

For complex expressions, isolate substrings:

```python
lagrangian = MathTex(
    r"\mathcal{L} = \bar{\psi}(i \gamma^\mu D_\mu - m)\psi - \tfrac{1}{4}F_{\mu\nu}F^{\mu\nu}",
    substrings_to_isolate=[r"\psi", r"D_\mu", r"F_{\mu\nu}"],
)
lagrangian.set_color_by_tex(r"\psi", PRIMARY)
lagrangian.set_color_by_tex(r"F_{\mu\nu}", ACCENT)
```

## Fallback When LaTeX Is Missing

- replace `MathTex` with short `Text` placeholders
- keep the scene structure and narration intact
- note clearly that the math formatting still needs `pdflatex`

## Failure Modes

- introducing the final dense equation before intuition
- too many simultaneous terms at full opacity
- no pause after a transformation
- changing color meaning halfway through the derivation
