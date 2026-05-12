# Dark Mode

For dark diagrams, add a large background rectangle as the first element in the array:

```json
{
  "type": "rectangle",
  "id": "dark-bg",
  "x": -4000,
  "y": -3000,
  "width": 10000,
  "height": 7500,
  "backgroundColor": "#1e1e2e",
  "fillStyle": "solid",
  "strokeColor": "transparent",
  "strokeWidth": 0
}
```

## Text On Dark Backgrounds

- Primary text: `#e5e5e5`
- Secondary text: `#a0a0a0`
- Do not use the default `#1e1e1e` text color on a dark background.

## Useful Dark Fills

| Use | Fill | Hex |
|-----|------|-----|
| Primary nodes | Dark Blue | `#1e3a5f` |
| Success / output | Dark Green | `#1a4d2e` |
| Processing | Dark Purple | `#2d1b69` |
| Warning | Dark Orange | `#5c3d1a` |
| Error | Dark Red | `#5c1a1a` |
| Storage | Dark Teal | `#1a4d4d` |

Keep bright stroke colors for arrows and borders so the diagram still reads clearly.
