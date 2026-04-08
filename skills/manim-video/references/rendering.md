# Rendering

Use this reference when the plan and `script.py` are ready.

## Draft First

Render only the scenes you are actively changing:

```bash
python3 -m manim -ql script.py Scene1Introduction
python3 -m manim -ql script.py Scene2CoreConcept Scene3WrapUp
```

Use `-qm` when 480p is too rough to judge spacing:

```bash
python3 -m manim -qm script.py Scene2CoreConcept
```

## Still Preview

For a fast layout check:

```bash
python3 -m manim -s -ql script.py Scene2CoreConcept
```

## Production Render

Only after the draft timing and layout are correct:

```bash
python3 -m manim -qh script.py Scene1Introduction Scene2CoreConcept Scene3WrapUp
```

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

- `No module named manim`: install the Python package first.
- `FileNotFoundError` during stitch: regenerate or edit `concat.txt` so the quality folder and scene names match the actual renders.
- `LaTeX Error`: remove `MathTex` temporarily or install `pdflatex`.
- Very slow iteration: render a single scene at `-ql` instead of the whole project.
