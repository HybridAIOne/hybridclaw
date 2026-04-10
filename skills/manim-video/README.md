# Manim Video Skill

Production pipeline for mathematical and technical animations using Manim Community Edition.

## What it does

Creates 3Blue1Brown-style animated videos from text prompts. The agent handles the full pipeline end-to-end: planning, code generation, rendering, stitching, and refinement.

## Project structure

The normal output is a small project directory containing:

- `plan.md`
- `script.py`
- `concat.txt`
- rendered scene clips under `media/`
- a stitched draft or final `.mp4` when rendering succeeds

## Use cases

- Concept explainers
- Equation derivations
- Algorithm visualizations
- Data stories
- Architecture diagrams

## Prerequisites

Python 3.10+, Manim CE, LaTeX for `MathTex`/`Tex`, and ffmpeg.

Install Manim with either `uv tool install manim` or `python3 -m pip install manim`.

```bash
python3 skills/manim-video/scripts/check_setup.py --format text
```
