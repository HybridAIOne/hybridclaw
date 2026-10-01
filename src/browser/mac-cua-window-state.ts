/**
 * Pure parsers for cua-driver `list_windows` and `get_window_state` payloads.
 *
 * They only read driver output. Deciding which window a session may control
 * (and refusing the operator's own windows) stays in mac-cua-driver.ts.
 */
import type { MacCuaTarget } from './mac-cua-driver.js';

export function normalizePositiveInteger(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export function normalizeWindowId(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const candidates: Array<{
    id: number;
    onCurrentSpace: boolean;
    layer: number;
    area: number;
  }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = normalizePositiveInteger(record.window_id);
    if (id === null) continue;
    const bounds =
      record.bounds && typeof record.bounds === 'object'
        ? (record.bounds as Record<string, unknown>)
        : {};
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    candidates.push({
      id,
      onCurrentSpace: record.on_current_space === true,
      layer: typeof record.layer === 'number' ? record.layer : 0,
      area:
        Number.isFinite(width) && Number.isFinite(height)
          ? Math.max(0, width * height)
          : 0,
    });
  }
  candidates.sort((a, b) => {
    if (a.layer !== b.layer) return a.layer - b.layer;
    if (a.onCurrentSpace !== b.onCurrentSpace) {
      return a.onCurrentSpace ? -1 : 1;
    }
    return b.area - a.area;
  });
  return candidates[0]?.id ?? null;
}

export function resolveMacCuaWindowStateElementIndex(
  record: Record<string, unknown>,
): number | null {
  const structured =
    normalizePositiveInteger(record.element_index) ||
    normalizePositiveInteger(record.elementIndex) ||
    normalizePositiveInteger(record.index);
  if (structured !== null) return structured;
  const tree = String(record.tree_markdown || record.markdown || '');
  const match = tree.match(/\[element_index\s+(\d+)\]/u);
  if (match?.[1]) return Number(match[1]);
  const indexedLine = tree.match(/^\s*(?:-\s+)?\[(\d+)\]\s+\w+/mu);
  return indexedLine?.[1] ? Number(indexedLine[1]) : null;
}

export function firstElementIndex(
  record: Record<string, unknown>,
): number | null {
  return resolveMacCuaWindowStateElementIndex(record);
}

export function firstEditableElementSelector(
  record: Record<string, unknown>,
  windowId?: string | number,
): string | null {
  const target = firstEditableElementTarget(record, windowId);
  if (!target || target.kind !== 'ax') return null;
  return `@e${target.elementIndex}${target.windowId ? `@window:${target.windowId}` : ''}`;
}

export function firstEditableElementTarget(
  record: Record<string, unknown>,
  windowId?: string | number,
): MacCuaTarget | null {
  const tree = String(record.tree_markdown || record.markdown || '');
  for (const line of tree.split(/\r?\n/u)) {
    const indexMatch = line.match(/\[element_index\s+(\d+)\]/u);
    const roleMatch = line.match(
      /\b(?:AX)?(?:TextField|TextArea|SearchField|ComboBox)\b/iu,
    );
    if (indexMatch?.[1] && roleMatch) {
      const elementIndex = Number(indexMatch[1]);
      if (Number.isFinite(elementIndex)) {
        return {
          kind: 'ax',
          elementIndex,
          ...(windowId ? { windowId } : {}),
        };
      }
    }
  }
  const elementPattern =
    /^\s*(?:-\s+)?\[(\d+)\]\s+(\w+)(?:\s+"([^"]*)"|(?:\s+\(\d+\))?\s+id=([^\s[\]]*))?/gmu;
  for (const match of tree.matchAll(elementPattern)) {
    const index = match[1] ? Number(match[1]) : null;
    const role = String(match[2] || '').toLowerCase();
    if (
      index !== null &&
      Number.isFinite(index) &&
      (role.includes('textfield') ||
        role.includes('textarea') ||
        role.includes('searchfield') ||
        role.includes('combobox'))
    ) {
      return {
        kind: 'ax',
        elementIndex: index,
        ...(windowId ? { windowId } : {}),
      };
    }
  }
  return null;
}
