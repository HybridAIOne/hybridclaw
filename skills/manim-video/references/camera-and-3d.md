# Camera And 3D

Use this reference when the scene needs zoom, pan, spatial rotation, or true 3D geometry.

## MovingCameraScene

```python
class ZoomExample(MovingCameraScene):
    def construct(self) -> None:
        circle = Circle(radius=2, color=PRIMARY)
        self.play(Create(circle))
        self.play(self.camera.frame.animate.set(width=4).move_to(circle), run_time=2)
        self.wait(1.5)
        self.play(self.camera.frame.animate.set(width=14.222).move_to(ORIGIN), run_time=2)
```

Use camera motion only when it clarifies attention. Do not zoom just because you can.

## Useful Camera Moves

```python
self.camera.frame.animate.set(width=6)
self.camera.frame.animate.move_to(target)
self.camera.frame.save_state()
self.play(Restore(self.camera.frame))
```

## ThreeDScene

```python
class SurfaceExample(ThreeDScene):
    def construct(self) -> None:
        self.set_camera_orientation(phi=60 * DEGREES, theta=-45 * DEGREES)
        axes = ThreeDAxes()
        surface = Surface(
            lambda u, v: axes.c2p(u, v, np.sin(u) * np.cos(v)),
            u_range=[-PI, PI],
            v_range=[-PI, PI],
            resolution=(30, 30),
        )
        surface.set_color_by_gradient(PRIMARY, SECONDARY, ACCENT)
        self.play(Create(axes), Create(surface))
        self.begin_ambient_camera_rotation(rate=0.15)
        self.wait(3)
        self.stop_ambient_camera_rotation()
```

## 3D Labels

For readable text in 3D scenes, pin it to the camera frame:

```python
label = Text("Gradient surface", font=MONO, font_size=24)
self.add_fixed_in_frame_mobjects(label)
```

## When To Use 3D

- surfaces
- vector fields
- spatial geometry
- camera fly-throughs where depth is the concept

## When Not To Use 3D

- text-heavy scenes
- flat charts
- simple 2D mechanisms that only become harder to read in perspective

## Failure Modes

- rotating the camera while new text appears
- too much depth without fixed labels
- using 3D for a concept that is really 2D
