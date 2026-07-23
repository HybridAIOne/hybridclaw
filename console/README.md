# HybridClaw Console UI conventions

The Admin Console uses one component and theme system. New pages and changes to
existing pages follow these conventions so navigation, forms, and operational
actions behave consistently.

## Page anatomy

- The app shell owns the page title. Do not repeat it inside the route.
- Use `PageHeader` for contextual status or page-level actions. Supporting copy
  is optional and should explain a constraint or consequence, not restate the
  visible UI.
- Put the primary page action at the right of `PageHeader` or `TabbedPage`.
- Use `TabbedPage` for consolidated workflows. Contextual search, filters, and
  refresh actions live in its stable action area.
- Use `Card` for bounded groups and the shared table styles for collections.
- IDs, paths, and fingerprints use monospace styling. Numeric values use
  tabular numerals. Status must include text or an icon in addition to color.

## Shared controls

Import controls from their canonical component paths:

```tsx
import { Button } from '../components/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/card';
import { Field, FieldLabel } from '../components/field';
```

Do not add route-level primary, ghost, outline, or danger button styles. Use a
`Button` variant instead. Route CSS may describe page-specific layout and data
visualization; reusable control appearance belongs in the component module.

## Save and action behavior

- Configuration-shaped pages use an explicit Save action, dirty tracking, and
  `useUnsavedChangesGuard`. Show Discard only while the draft differs from the
  saved value.
- Operational actions apply immediately and report success or failure through
  a toast. Destructive operations require confirmation when they cannot be
  undone.
- Disable or show loading state on the action that owns an in-flight request;
  do not freeze unrelated navigation.
- Secret values remain write-only. Use `SecretRefPicker` for stored-secret
  references and never render secret values back into a form.

## Themes and visual checks

All shared color, surface, status, radius, and control-size tokens live in
`src/theme.css`. Both light and dark themes consume the same semantic tokens.
Component and route styles must not hard-code a parallel theme palette.

Run the console gates before review:

```bash
npm --workspace console run typecheck
npm --workspace console run test
npm --workspace console run build
npm --workspace console run test:visual
```

`test:visual` renders every primary Admin destination at the desktop baseline
in both themes and compares it with the committed screenshots. Update baselines
only after reviewing the rendered diff.
