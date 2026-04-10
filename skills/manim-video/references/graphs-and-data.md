# Graphs And Data

Use this reference for algorithms, plots, counters, charts, and data-story scenes.

## Axes And Structural Elements

```python
axes = Axes(
    x_range=[-3, 3, 1],
    y_range=[-2, 2, 1],
    x_length=8,
    y_length=5,
    axis_config={"include_numbers": True, "font_size": 24},
)
axes.set_opacity(0.15)
```

Axes, grids, and guides should stay quieter than the thing you want the viewer to follow.

## Plotting

```python
graph = axes.plot(lambda x: x**2, color=PRIMARY)
label = axes.get_graph_label(graph, label=r"x^2", x_val=2)
area = axes.get_area(graph, x_range=[0, 2], color=PRIMARY, opacity=0.3)
```

## Animated Plotting

```python
tracker = ValueTracker(1)
dynamic = always_redraw(
    lambda: axes.plot(lambda x: tracker.get_value() * x**2, color=PRIMARY)
)
self.add(dynamic)
self.play(tracker.animate.set_value(3), run_time=2)
```

## Number Lines

```python
line = NumberLine(x_range=[0, 10, 1], length=10, include_numbers=True)
pointer = Arrow(line.n2p(3) + UP * 0.5, line.n2p(3), color=ACCENT, buff=0)
```

Use number lines for search, intervals, thresholds, and pointer-style algorithm motion.

## Bar Charts And Counters

```python
chart = BarChart(
    values=[4, 6, 2, 8],
    bar_names=["A", "B", "C", "D"],
    y_range=[0, 10, 2],
)

counter = DecimalNumber(0, font_size=48, num_decimal_places=0, font=MONO)
self.play(counter.animate.set_value(1000), run_time=3)
```

## Algorithm Visualization Pattern

- start with the initial state clearly labeled
- highlight only the active item or range
- animate updates one step at a time
- dim inactive context instead of deleting it immediately
- end on the invariant or final answer

## Data Story Pattern

- show the baseline first
- introduce the comparison second
- label the delta explicitly
- keep colors semantically stable

## Failure Modes

- bar charts without axis meaning
- too many labels at once
- fast counters without a pause on the final value
- algorithm scenes that animate several moving parts simultaneously
