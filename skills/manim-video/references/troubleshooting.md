# Troubleshooting

Use this reference when Manim code or renders fail.

## LaTeX Errors

Missing raw string:

```python
# wrong
MathTex("\\frac{1}{2}")

# right
MathTex(r"\frac{1}{2}")
```

If `pdflatex` is missing, use `Text` placeholders until LaTeX is installed.

## Mixed Text And Shapes

`Text()` is not always safe inside `VGroup` with other object types.

```python
# safer for mixed content
group = Group(circle, Text("Label", font=MONO))
self.play(FadeOut(Group(*self.mobjects)))
```

## Invisible Or Confusing Animations

- add the object before animating it
- do not animate the same mobject twice in one `self.play(...)`
- suspend updaters when they fight direct animations

## Render Problems

- `No module named manim`: install with `uv tool install manim` or `python3 -m pip install manim`
- `pdflatex: command not found`: install a TeX distribution
- stale cached output: rerender the scene or use `--disable_caching`
- slow renders: drop to `-ql` and isolate one scene

## Stitch Problems

- `concat.txt` paths do not match the quality folder you rendered
- scene class names changed but `concat.txt` still references the old names
- mixed codecs or resolutions between clips

## Layout Debugging

- render a still: `manim -s -ql script.py SceneName`
- temporarily replace `self.play(...)` with `self.add(...)`
- print positions with `print(mob.get_center())`
- reduce the scene to one object at a time until the failure is obvious

## Common Failure Modes

- overlapping text because the previous label was never removed
- clipped text because `.to_edge()` used too little buffer
- too many simultaneously visible elements
- missing `self.camera.background_color = BG`
