# Examples

These are complete `elements` arrays. Wrap them in the `.excalidraw` envelope from `SKILL.md` before saving.

## Example 1: Simple Flow

```json
[
  {
    "type": "text",
    "id": "title",
    "x": 270,
    "y": 40,
    "text": "Simple Flow",
    "fontSize": 28,
    "fontFamily": 1,
    "strokeColor": "#1e1e1e",
    "originalText": "Simple Flow",
    "autoResize": true
  },
  {
    "type": "rectangle",
    "id": "start",
    "x": 100,
    "y": 130,
    "width": 200,
    "height": 90,
    "roundness": { "type": 3 },
    "backgroundColor": "#a5d8ff",
    "fillStyle": "solid",
    "boundElements": [{ "id": "text-start", "type": "text" }]
  },
  {
    "type": "text",
    "id": "text-start",
    "x": 110,
    "y": 160,
    "width": 180,
    "height": 24,
    "text": "Start",
    "fontSize": 20,
    "fontFamily": 1,
    "strokeColor": "#1e1e1e",
    "textAlign": "center",
    "verticalAlign": "middle",
    "containerId": "start",
    "originalText": "Start",
    "autoResize": true
  },
  {
    "type": "rectangle",
    "id": "finish",
    "x": 430,
    "y": 130,
    "width": 200,
    "height": 90,
    "roundness": { "type": 3 },
    "backgroundColor": "#b2f2bb",
    "fillStyle": "solid",
    "boundElements": [{ "id": "text-finish", "type": "text" }]
  },
  {
    "type": "text",
    "id": "text-finish",
    "x": 440,
    "y": 160,
    "width": 180,
    "height": 24,
    "text": "Finish",
    "fontSize": 20,
    "fontFamily": 1,
    "strokeColor": "#1e1e1e",
    "textAlign": "center",
    "verticalAlign": "middle",
    "containerId": "finish",
    "originalText": "Finish",
    "autoResize": true
  },
  {
    "type": "arrow",
    "id": "arrow-start-finish",
    "x": 300,
    "y": 175,
    "width": 130,
    "height": 0,
    "points": [[0, 0], [130, 0]],
    "endArrowhead": "arrow",
    "startBinding": { "elementId": "start", "fixedPoint": [1, 0.5] },
    "endBinding": { "elementId": "finish", "fixedPoint": [0, 0.5] }
  }
]
```

## Example 2: Client -> API -> Database

```json
[
  {
    "type": "text",
    "id": "title",
    "x": 210,
    "y": 30,
    "text": "Service Overview",
    "fontSize": 28,
    "fontFamily": 1,
    "strokeColor": "#1e1e1e",
    "originalText": "Service Overview",
    "autoResize": true
  },
  {
    "type": "rectangle",
    "id": "client",
    "x": 70,
    "y": 150,
    "width": 180,
    "height": 80,
    "roundness": { "type": 3 },
    "backgroundColor": "#a5d8ff",
    "fillStyle": "solid",
    "boundElements": [{ "id": "text-client", "type": "text" }]
  },
  {
    "type": "text",
    "id": "text-client",
    "x": 80,
    "y": 178,
    "width": 160,
    "height": 24,
    "text": "Web Client",
    "fontSize": 20,
    "fontFamily": 1,
    "strokeColor": "#1e1e1e",
    "textAlign": "center",
    "verticalAlign": "middle",
    "containerId": "client",
    "originalText": "Web Client",
    "autoResize": true
  },
  {
    "type": "rectangle",
    "id": "api",
    "x": 330,
    "y": 150,
    "width": 200,
    "height": 80,
    "roundness": { "type": 3 },
    "backgroundColor": "#d0bfff",
    "fillStyle": "solid",
    "boundElements": [{ "id": "text-api", "type": "text" }]
  },
  {
    "type": "text",
    "id": "text-api",
    "x": 340,
    "y": 178,
    "width": 180,
    "height": 24,
    "text": "API Service",
    "fontSize": 20,
    "fontFamily": 1,
    "strokeColor": "#1e1e1e",
    "textAlign": "center",
    "verticalAlign": "middle",
    "containerId": "api",
    "originalText": "API Service",
    "autoResize": true
  },
  {
    "type": "rectangle",
    "id": "db",
    "x": 620,
    "y": 150,
    "width": 190,
    "height": 80,
    "roundness": { "type": 3 },
    "backgroundColor": "#c3fae8",
    "fillStyle": "solid",
    "boundElements": [{ "id": "text-db", "type": "text" }]
  },
  {
    "type": "text",
    "id": "text-db",
    "x": 630,
    "y": 178,
    "width": 170,
    "height": 24,
    "text": "Database",
    "fontSize": 20,
    "fontFamily": 1,
    "strokeColor": "#1e1e1e",
    "textAlign": "center",
    "verticalAlign": "middle",
    "containerId": "db",
    "originalText": "Database",
    "autoResize": true
  },
  {
    "type": "arrow",
    "id": "arrow-client-api",
    "x": 250,
    "y": 190,
    "width": 80,
    "height": 0,
    "points": [[0, 0], [80, 0]],
    "endArrowhead": "arrow",
    "boundElements": [{ "id": "text-http", "type": "text" }],
    "startBinding": { "elementId": "client", "fixedPoint": [1, 0.5] },
    "endBinding": { "elementId": "api", "fixedPoint": [0, 0.5] }
  },
  {
    "type": "text",
    "id": "text-http",
    "x": 270,
    "y": 162,
    "width": 40,
    "height": 20,
    "text": "HTTP",
    "fontSize": 16,
    "fontFamily": 1,
    "strokeColor": "#1e1e1e",
    "textAlign": "center",
    "verticalAlign": "middle",
    "containerId": "arrow-client-api",
    "originalText": "HTTP",
    "autoResize": true
  },
  {
    "type": "arrow",
    "id": "arrow-api-db",
    "x": 530,
    "y": 190,
    "width": 90,
    "height": 0,
    "points": [[0, 0], [90, 0]],
    "endArrowhead": "arrow",
    "boundElements": [{ "id": "text-sql", "type": "text" }],
    "startBinding": { "elementId": "api", "fixedPoint": [1, 0.5] },
    "endBinding": { "elementId": "db", "fixedPoint": [0, 0.5] }
  },
  {
    "type": "text",
    "id": "text-sql",
    "x": 555,
    "y": 162,
    "width": 40,
    "height": 20,
    "text": "SQL",
    "fontSize": 16,
    "fontFamily": 1,
    "strokeColor": "#1e1e1e",
    "textAlign": "center",
    "verticalAlign": "middle",
    "containerId": "arrow-api-db",
    "originalText": "SQL",
    "autoResize": true
  }
]
```

## Common Mistakes

- Do not use `"label"` on shapes or arrows.
- Do not forget `containerId` on bound text.
- Do not forget `boundElements` on the container.
- Do not use tiny labels or cramped node spacing.
- Do not put bound text far away from the shape it belongs to in the array.
