# Updaters And Trackers

Use this reference when scene geometry depends on a changing value.

## The Core Pattern

1. create a tracker
2. create visible objects that read that tracker
3. animate the tracker

```python
progress = ValueTracker(0)

dot = always_redraw(
    lambda: Dot(line.n2p(progress.get_value()), color=ACCENT)
)
label = DecimalNumber(0, font_size=24, color=SECONDARY, font=MONO)
label.add_updater(lambda m: m.set_value(progress.get_value()))
label.add_updater(lambda m: m.next_to(dot, UP, buff=0.2))

self.add(dot, label)
self.play(progress.animate.set_value(5), run_time=2.5, rate_func=linear)
```

## Choose The Right Tool

| Need | Tool |
|------|------|
| simple position/color/opacity tracking | `add_updater(...)` |
| mobject geometry changes each frame | `always_redraw(...)` |
| animate a single numeric parameter | `ValueTracker` |
| live number readout | `DecimalNumber` or `Variable` |

## `add_updater`

```python
edge = Line()
edge.add_updater(
    lambda m: m.put_start_and_end_on(node_a.get_center(), node_b.get_center())
)
```

Use `add_updater` when the same object should persist while its properties change.

## `always_redraw`

```python
tangent = always_redraw(
    lambda: TangentLine(graph, alpha=alpha.get_value(), color=HIGHLIGHT, length=3)
)
```

Use `always_redraw` when the object must be rebuilt every frame. It is more expensive, so do not use it for simple repositioning.

## Updater Hygiene

```python
label.suspend_updating()
self.play(label.animate.to_corner(UR), run_time=0.8)
label.resume_updating()
```

- Suspend updating when an updater would fight a direct animation.
- Clear updaters when the dependency is over.
- Add updater-driven objects to the scene before expecting them to update.

## Practical Patterns

- counters that track queue depth, latency, or token count
- arrows or lines that stay attached to moving boxes
- parameter sweeps on charts
- braces or labels that follow rescaling geometry
- moving pointers on number lines or timelines

## Failure Modes

- rebuilding a cheap label every frame when an updater would do
- animating a mobject directly while its updater is still forcing a different position
- forgetting that only scene-owned mobjects update
