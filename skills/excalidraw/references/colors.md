# Excalidraw Palette

Use a small, consistent palette. Excalidraw diagrams look better when color meaning stays stable across the canvas.

## Fill Colors

| Use | Fill | Hex |
|-----|------|-----|
| Primary nodes | Light Blue | `#a5d8ff` |
| Outputs / success | Light Green | `#b2f2bb` |
| Warnings / external systems | Light Orange | `#ffd8a8` |
| Processing / orchestration | Light Purple | `#d0bfff` |
| Errors / critical states | Light Red | `#ffc9c9` |
| Notes / decisions | Light Yellow | `#fff3bf` |
| Storage / data | Light Teal | `#c3fae8` |

## Stroke And Accent Colors

| Use | Stroke | Hex |
|-----|--------|-----|
| Default outline / text | Dark Gray | `#1e1e1e` |
| Blue accent | Blue | `#4a9eed` |
| Green accent | Green | `#22c55e` |
| Orange accent | Amber | `#f59e0b` |
| Red accent | Red | `#ef4444` |
| Purple accent | Purple | `#8b5cf6` |

## Background Zones

For layered diagrams, use large low-opacity rectangles behind content:

| Layer | Color | Hex |
|-------|-------|-----|
| UI / frontend | Blue zone | `#dbe4ff` |
| Logic / agent layer | Purple zone | `#e5dbff` |
| Data / tools layer | Green zone | `#d3f9d8` |

Use `opacity: 30-35` for those background zones so they do not overpower the main nodes.

## Contrast Rules

- On white backgrounds, prefer `#1e1e1e` for text.
- Secondary text on white should stay at or darker than `#757575`.
- Do not use pale gray text on white.
- On light fills, keep text dark; do not match the fill color with bright text.
