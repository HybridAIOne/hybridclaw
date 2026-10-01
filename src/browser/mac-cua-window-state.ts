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

export function windowStateTree(record: Record<string, unknown>): string {
  return String(record.tree_markdown || record.markdown || '');
}

/** One element of a cua-driver `get_window_state` tree. */
export interface MacCuaAxNode {
  index: number | null;
  role: string;
  title: string;
  value: string;
  description: string;
  help: string;
  id: string;
  disabled: boolean;
  parent: MacCuaAxNode | null;
  /** Inside a web page, not the browser's own toolbar, tabs or menus. */
  inPage: boolean;
}

// `  - [23] AXLink "Dashboard" = "value" (description) help="…" id=… DISABLED actions=[…]`
// Every part after the role is optional, and indices only mark actionable
// elements. A label can span lines; its continuation lines carry no `- `.
const AX_NODE_LINE_RE = /^(\s*)- (?:\[(\d+)\] )?(\S+)(.*)$/u;
const AX_NODE_ATTRS_RE =
  /^(?: "(?<title>[\s\S]*?)")?(?: = "(?<value>[\s\S]*?)")?(?: \((?<description>[\s\S]*?)\))?(?: help="(?<help>[\s\S]*?)")?(?: id=(?<id>\S*))?(?<disabled> DISABLED)?(?: actions=\[[^\]]*\])?\s*$/u;

export function parseMacCuaAxTree(markdown: string): MacCuaAxNode[] {
  const rows: Array<{
    depth: number;
    index: number | null;
    role: string;
    rest: string;
  }> = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const match = line.match(AX_NODE_LINE_RE);
    if (match) {
      rows.push({
        depth: (match[1] || '').length,
        index: match[2] ? Number(match[2]) : null,
        role: match[3] || '',
        rest: match[4] || '',
      });
    } else if (rows.length > 0 && line.trim()) {
      const last = rows[rows.length - 1];
      if (last) last.rest += ` ${line.trim()}`;
    }
  }
  const nodes: MacCuaAxNode[] = [];
  const ancestors: Array<{ depth: number; node: MacCuaAxNode }> = [];
  for (const row of rows) {
    while (
      ancestors.length > 0 &&
      (ancestors[ancestors.length - 1]?.depth ?? -1) >= row.depth
    ) {
      ancestors.pop();
    }
    const parent = ancestors[ancestors.length - 1]?.node ?? null;
    const attrs = row.rest.match(AX_NODE_ATTRS_RE)?.groups;
    const node: MacCuaAxNode = {
      index: row.index,
      role: row.role,
      // An unknown attribute layout still yields the first quoted label.
      title: attrs
        ? (attrs.title ?? '')
        : (row.rest.match(/"([^"]*)"/u)?.[1] ?? ''),
      value: attrs?.value ?? '',
      description: attrs?.description ?? '',
      help: attrs?.help ?? '',
      id: attrs?.id ?? '',
      disabled: Boolean(attrs?.disabled),
      parent,
      inPage: parent !== null && (parent.inPage || parent.role === 'AXWebArea'),
    };
    nodes.push(node);
    ancestors.push({ depth: row.depth, node });
  }
  return nodes;
}

function normalizeLabel(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** What the element is called, the way a person reading the page would say it. */
function axNodeName(node: MacCuaAxNode): string {
  return normalizeLabel(
    node.title ||
      node.description ||
      (EDITABLE_ROLES.has(node.role) ? '' : node.value) ||
      node.help,
  );
}

// Roles a click or AXPress acts on. Web content often omits AXPress from the
// advertised actions although pressing works, so the role decides, not the
// action list.
const CLICKABLE_ROLES = new Set([
  'AXLink',
  'AXButton',
  'AXMenuButton',
  'AXPopUpButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXMenuItem',
  'AXDisclosureTriangle',
  'AXSwitch',
  'AXComboBox',
  'AXTextField',
  'AXSecureTextField',
  'AXTextArea',
  'AXSearchField',
]);
const EDITABLE_ROLES = new Set([
  'AXComboBox',
  'AXTextField',
  'AXSecureTextField',
  'AXTextArea',
  'AXSearchField',
]);
// Text inside a link or button sits a few levels down (link > group > text).
const MAX_ANCESTOR_STEPS = 4;

export type MacCuaQueryPurpose = 'click' | 'fill';

function labelMatchStrength(node: MacCuaAxNode, needle: string): number {
  let best = 0;
  for (const text of [node.title, node.value, node.description, node.help]) {
    const label = normalizeLabel(text).toLowerCase();
    if (!label) continue;
    if (label === needle) return 3;
    if (label.startsWith(needle)) best = Math.max(best, 2);
    else if (label.includes(needle)) best = Math.max(best, 1);
  }
  return best;
}

function actionableSelfOrAncestor(
  node: MacCuaAxNode,
  roles: ReadonlySet<string>,
): MacCuaAxNode | null {
  let current: MacCuaAxNode | null = node;
  for (let step = 0; current?.inPage && step <= MAX_ANCESTOR_STEPS; step += 1) {
    if (current.index !== null && roles.has(current.role)) return current;
    current = current.parent;
  }
  return null;
}

/**
 * The element a text query means: one whose own label matches, or the link
 * or button around matching text. Only page content counts; the browser's
 * toolbar, tabs and menu bar are never a query target.
 *
 * cua-driver's `query` filter keeps every ancestor of a match, so the first
 * indexed line of a filtered tree is the application, not the match.
 */
export function resolveMacCuaQueryElementIndex(
  markdown: string,
  query: string,
  purpose: MacCuaQueryPurpose = 'click',
): number | null {
  const needle = normalizeLabel(query).toLowerCase();
  if (!needle) return null;
  const roles = purpose === 'fill' ? EDITABLE_ROLES : CLICKABLE_ROLES;
  let best: { index: number; rank: number } | null = null;
  for (const node of parseMacCuaAxTree(markdown)) {
    if (!node.inPage) continue;
    const strength = labelMatchStrength(node, needle);
    if (strength === 0) continue;
    const target = actionableSelfOrAncestor(node, roles);
    let rank: number;
    let index: number | null;
    if (target) {
      // Any match that names an actionable element beats a bare one; among
      // those, a closer label wins, then the element itself over its parent.
      rank = 10 + strength * 2 + (target === node ? 1 : 0);
      index = target.index;
    } else if (purpose === 'click' && node.index !== null) {
      // Pages make clickable divs; AXPress may still work on them.
      rank = strength;
      index = node.index;
    } else {
      continue;
    }
    if (index !== null && (!best || rank > best.rank)) {
      best = { index, rank };
    }
  }
  return best?.index ?? null;
}

export type MacCuaHistoryDirection = 'back' | 'forward';

// Safari gives its history buttons stable ids; Chromium browsers only a
// localized label, so the labels cover English and German.
const HISTORY_BUTTON_IDS: Record<MacCuaHistoryDirection, string> = {
  back: 'BackButton',
  forward: 'ForwardButton',
};
const HISTORY_BUTTON_LABELS: Record<MacCuaHistoryDirection, string[]> = {
  back: ['back', 'zurück'],
  forward: ['forward', 'vorwärts', 'weiter'],
};

/** The browser's own Back or Forward toolbar button, outside the page. */
export function findMacCuaHistoryButton(
  markdown: string,
  direction: MacCuaHistoryDirection,
): { index: number; disabled: boolean } | null {
  const buttons = parseMacCuaAxTree(markdown).filter(
    (node) => !node.inPage && node.role === 'AXButton' && node.index !== null,
  );
  const button =
    buttons.find((node) => node.id === HISTORY_BUTTON_IDS[direction]) ??
    buttons.find((node) =>
      HISTORY_BUTTON_LABELS[direction].includes(axNodeName(node).toLowerCase()),
    );
  return button?.index != null
    ? { index: button.index, disabled: button.disabled }
    : null;
}

function toHttpUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw || /\s/u.test(raw)) return null;
  // Chromium's omnibox may drop the scheme ("example.com/path").
  const candidate = /^https?:\/\//iu.test(raw)
    ? raw
    : /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/|$)/iu.test(raw)
      ? `https://${raw}`
      : '';
  if (!candidate) return null;
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

/**
 * The page URL from the browser's address field. It needs no page JavaScript,
 * which Safari blocks unless "Allow JavaScript from Apple Events" is on.
 */
export function findMacCuaAddressBarUrl(markdown: string): string | null {
  for (const node of parseMacCuaAxTree(markdown)) {
    if (node.inPage || !EDITABLE_ROLES.has(node.role)) continue;
    const url = toHttpUrl(node.value);
    if (url) return url;
  }
  return null;
}

const SNAPSHOT_ROLE_NAMES: Record<string, string> = {
  AXLink: 'link',
  AXButton: 'button',
  AXMenuButton: 'button',
  AXPopUpButton: 'button',
  AXDisclosureTriangle: 'button',
  AXCheckBox: 'checkbox',
  AXRadioButton: 'radio',
  AXSwitch: 'switch',
  AXMenuItem: 'menuitem',
  AXComboBox: 'combobox',
  AXTextField: 'textbox',
  AXSecureTextField: 'textbox',
  AXTextArea: 'textbox',
  AXSearchField: 'searchbox',
  AXHeading: 'heading',
  AXStaticText: 'text',
  AXImage: 'img',
};
const SNAPSHOT_TEXT_ROLES = new Set(['AXHeading', 'AXStaticText', 'AXImage']);
const DEFAULT_SNAPSHOT_MAX_CHARS = 12_000;

export interface MacCuaPageSnapshot {
  snapshot: string;
  truncated: boolean;
  elementCount: number;
  /** `e23` → what the element is, for the checkout guard. */
  refs: Record<string, { role: string; name: string }>;
}

function rendersInSnapshot(node: MacCuaAxNode): boolean {
  return (
    (node.index !== null && CLICKABLE_ROLES.has(node.role)) ||
    SNAPSHOT_TEXT_ROLES.has(node.role)
  );
}

// "Dashboard" inside link "Dashboard" says nothing new.
function repeatsAncestorLabel(node: MacCuaAxNode, label: string): boolean {
  for (let current = node.parent; current?.inPage; current = current.parent) {
    if (rendersInSnapshot(current) && axNodeName(current) === label) {
      return true;
    }
  }
  return false;
}

/**
 * The page as the model reads it: actionable elements with refs it can click
 * (`@e23`), plus headings and text unless only interactive elements are
 * asked for. Typed field values are left out; they can hold secrets.
 */
export function renderMacCuaPageSnapshot(
  markdown: string,
  opts: { interactiveOnly?: boolean; maxChars?: number } = {},
): MacCuaPageSnapshot {
  const maxChars = opts.maxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS;
  const lines: string[] = [];
  const refs: MacCuaPageSnapshot['refs'] = {};
  let length = 0;
  let truncated = false;
  for (const node of parseMacCuaAxTree(markdown)) {
    if (!node.inPage) continue;
    const role =
      SNAPSHOT_ROLE_NAMES[node.role] ||
      node.role.replace(/^AX/u, '').toLowerCase();
    const name = axNodeName(node);
    let line: string | null = null;
    if (node.index !== null && CLICKABLE_ROLES.has(node.role)) {
      const value =
        node.role === 'AXComboBox' && node.value
          ? ` = ${JSON.stringify(normalizeLabel(node.value))}`
          : '';
      line = `- ${role}${name ? ` ${JSON.stringify(name)}` : ''}${value}${
        node.disabled ? ' (disabled)' : ''
      } [ref=e${node.index}]`;
      refs[`e${node.index}`] = { role, name };
    } else if (
      !opts.interactiveOnly &&
      SNAPSHOT_TEXT_ROLES.has(node.role) &&
      name &&
      !repeatsAncestorLabel(node, name)
    ) {
      line = `- ${role} ${JSON.stringify(name)}`;
    }
    if (!line) continue;
    if (length + line.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return {
    snapshot: lines.join('\n'),
    truncated,
    elementCount: Object.keys(refs).length,
    refs,
  };
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
