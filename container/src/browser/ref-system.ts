import type { CdpTransport } from './cdp-transport.js';
import type {
  AriaNode,
  FormattedAriaSnapshot,
  RoleRef,
  RoleRefMap,
  SnapshotNode,
  SnapshotNodeKind,
} from './types.js';

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
]);

const CONTENT_ROLES = new Set([
  'heading',
  'cell',
  'article',
  'region',
  'main',
  'navigation',
]);

const STRUCTURAL_ROLES = new Set([
  'generic',
  'group',
  'list',
  'table',
  'row',
  'document',
]);

type RefResolutionTransport = Pick<CdpTransport, 'send'>;

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeRole(node: AriaNode): string {
  const raw = normalizeText(node.role?.value).toLowerCase();
  if (!raw || raw === 'rootwebarea') return 'document';
  return raw;
}

function normalizeName(node: AriaNode): string | undefined {
  const value = normalizeText(node.name?.value);
  return value || undefined;
}

function normalizeValue(node: AriaNode): string | undefined {
  const rawValue = normalizeText(node.value?.value);
  if (rawValue) return rawValue;
  const checked = node.properties?.find((property) => property.name === 'checked');
  const checkedValue = normalizeText(checked?.value?.value);
  if (checkedValue && checkedValue !== 'false') return checkedValue;
  return undefined;
}

function classifyRole(role: string): SnapshotNodeKind {
  if (INTERACTIVE_ROLES.has(role)) return 'interactive';
  if (CONTENT_ROLES.has(role)) return 'content';
  if (STRUCTURAL_ROLES.has(role)) return 'structural';
  if (!role || role === 'text') return 'structural';
  return 'content';
}

function shouldAssignRef(node: {
  role: string;
  kind: SnapshotNodeKind;
  name?: string;
  backendNodeId?: number;
}): boolean {
  if (!node.backendNodeId) return false;
  if (node.kind === 'interactive') return true;
  if (node.kind === 'content') return Boolean(node.name);
  return false;
}

function formatSnapshotLine(node: SnapshotNode): string {
  const parts: string[] = [];
  if (node.ref) parts.push(node.ref);
  parts.push(node.role);
  if (node.name) parts.push(`"${node.name}"`);
  if (!node.name && node.value) parts.push(`"${node.value}"`);
  return parts.join(' ');
}

function buildRoleNameCounts(
  nodes: AriaNode[],
  childrenByParent: Map<string, AriaNode[]>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (node: AriaNode): void => {
    const role = normalizeRole(node);
    const name = normalizeName(node);
    const kind = classifyRole(role);
    if (
      shouldAssignRef({
        role,
        kind,
        name,
        backendNodeId: node.backendDOMNodeId,
      })
    ) {
      const key = `${role}\u0000${(name || '').toLowerCase()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const child of childrenByParent.get(node.nodeId) || []) {
      visit(child);
    }
  };

  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  for (const node of nodes) {
    if (node.parentId && nodeIds.has(node.parentId)) continue;
    visit(node);
  }
  return counts;
}

function createFindElementExpression(roleRef: RoleRef): string {
  const payload = JSON.stringify({
    role: roleRef.role,
    name: roleRef.name || '',
    nth: roleRef.nth ?? 0,
  });
  return `(() => {
    const input = ${payload};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const roleSelectors = {
      button: 'button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]',
      link: 'a[href],[role="link"]',
      textbox: 'textarea,input:not([type]),input[type="text"],input[type="email"],input[type="url"],input[type="password"],input[type="tel"],[role="textbox"],[contenteditable="true"]',
      searchbox: 'input[type="search"],[role="searchbox"],[role="textbox"]',
      checkbox: 'input[type="checkbox"],[role="checkbox"]',
      radio: 'input[type="radio"],[role="radio"]',
      combobox: 'select,[role="combobox"]',
      listbox: 'select[multiple],[role="listbox"]',
      menuitem: '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]',
      slider: 'input[type="range"],[role="slider"]',
      spinbutton: 'input[type="number"],[role="spinbutton"]',
      switch: '[role="switch"]',
      tab: '[role="tab"]',
      treeitem: '[role="treeitem"]',
      heading: 'h1,h2,h3,h4,h5,h6,[role="heading"]',
      cell: 'td,th,[role="cell"],[role="gridcell"]',
      article: 'article,[role="article"]',
      region: 'section,[role="region"]',
      main: 'main,[role="main"]',
      navigation: 'nav,[role="navigation"]',
    };
    const implicitRole = (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
      if (tag === 'input') {
        const type = normalize(el.getAttribute('type'));
        if (!type || ['text', 'email', 'url', 'password', 'tel'].includes(type)) return 'textbox';
        if (type === 'search') return 'searchbox';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (['button', 'submit', 'reset'].includes(type)) return 'button';
      }
      if (tag === 'main') return 'main';
      if (tag === 'nav') return 'navigation';
      if (tag === 'article') return 'article';
      if (tag === 'section') return 'region';
      if (tag === 'td' || tag === 'th') return 'cell';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (el.isContentEditable) return 'textbox';
      return '';
    };
    const labelText = (el) => {
      if (typeof el.labels !== 'undefined' && el.labels && el.labels.length > 0) {
        return Array.from(el.labels).map((label) => label.textContent || '').join(' ');
      }
      return '';
    };
    const getName = (el) => {
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return normalize(ariaLabel);
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy
          .split(/\\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((node) => node.textContent || '')
          .join(' ');
        if (normalize(text)) return normalize(text);
      }
      const alt = el.getAttribute('alt');
      if (alt) return normalize(alt);
      const title = el.getAttribute('title');
      if (title) return normalize(title);
      const value = typeof el.value === 'string' ? el.value : '';
      if (value && ['button', 'submit', 'reset'].includes(normalize(el.getAttribute('type')))) {
        return normalize(value);
      }
      const label = labelText(el);
      if (normalize(label)) return normalize(label);
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return normalize(placeholder);
      return normalize(el.innerText || el.textContent || '');
    };
    const matchesRole = (el) => {
      const explicitRole = normalize(el.getAttribute('role'));
      const role = explicitRole || implicitRole(el);
      if (!role) return false;
      if (input.role === 'textbox' && role === 'searchbox') return true;
      if (input.role === 'searchbox' && role === 'textbox') return true;
      return role === input.role;
    };
    const selector = roleSelectors[input.role] || '*';
    const candidates = Array.from(document.querySelectorAll(selector)).filter((el) => matchesRole(el));
    const targetName = normalize(input.name);
    const filtered = targetName
      ? candidates.filter((el) => {
          const elementName = getName(el);
          return elementName === targetName || elementName.includes(targetName);
        })
      : candidates;
    return filtered[input.nth || 0] || null;
  })()`;
}

export function buildRoleSnapshotFromAriaSnapshot(
  ariaNodes: AriaNode[],
  options: { compact?: boolean } = {},
): FormattedAriaSnapshot {
  const nodeById = new Map<string, AriaNode>();
  const childrenByParent = new Map<string, AriaNode[]>();
  for (const node of ariaNodes) {
    nodeById.set(node.nodeId, node);
    if (!node.parentId) continue;
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }

  const counts = buildRoleNameCounts(ariaNodes, childrenByParent);
  const seen = new Map<string, number>();
  const refMap: RoleRefMap = {};
  const lines: string[] = [];
  let nextRefId = 1;
  let totalCount = 0;
  let interactiveCount = 0;

  const visit = (node: AriaNode, depth: number): SnapshotNode[] => {
    if (node.ignored) return [];
    const role = normalizeRole(node);
    if (!role) return [];
    const name = normalizeName(node);
    const value = normalizeValue(node);
    const kind = classifyRole(role);
    const key = `${role}\u0000${(name || '').toLowerCase()}`;
    const duplicateCount = counts.get(key) ?? 0;
    const currentIndex = seen.get(key) ?? 0;
    if (shouldAssignRef({ role, kind, name, backendNodeId: node.backendDOMNodeId })) {
      seen.set(key, currentIndex + 1);
    }

    const children = (childrenByParent.get(node.nodeId) || []).flatMap((child) =>
      visit(child, depth + 1),
    );

    let ref: string | undefined;
    if (shouldAssignRef({ role, kind, name, backendNodeId: node.backendDOMNodeId })) {
      ref = `@e${nextRefId++}`;
      const roleRef: RoleRef = {
        role,
        backendNodeId: node.backendDOMNodeId,
      };
      if (name) roleRef.name = name;
      if (duplicateCount > 1) roleRef.nth = currentIndex;
      refMap[ref] = roleRef;
      if (kind === 'interactive') interactiveCount += 1;
    }

    const snapshotNode: SnapshotNode = {
      ref,
      role,
      name,
      value,
      backendNodeId: node.backendDOMNodeId,
      kind,
      children,
    };

    const compactPrune =
      options.compact &&
      !ref &&
      !name &&
      kind === 'structural' &&
      role !== 'document';
    if (compactPrune) return children;

    totalCount += 1;
    lines.push(`${'  '.repeat(depth)}${formatSnapshotLine(snapshotNode)}`);
    return [snapshotNode];
  };

  const roots = ariaNodes.filter(
    (node) => !node.parentId || !nodeById.has(node.parentId),
  );
  const tree = roots.flatMap((node) => visit(node, 0));

  return {
    text: lines.join('\n'),
    refMap,
    tree,
    totalCount,
    interactiveCount,
  };
}

export async function resolveRoleRef(
  connection: RefResolutionTransport,
  sessionId: string,
  refMap: RoleRefMap,
  rawRef: string,
): Promise<{ backendNodeId: number; objectId: string }> {
  const normalizedRef = rawRef.startsWith('@') ? rawRef : `@${rawRef}`;
  const roleRef = refMap[normalizedRef];
  if (!roleRef) throw new Error(`Unknown browser ref: ${normalizedRef}`);

  const tryResolveBackendNode = async (
    backendNodeId: number | undefined,
  ): Promise<{ backendNodeId: number; objectId: string } | null> => {
    if (!backendNodeId) return null;
    try {
      const resolved = await connection.send<{
        object?: { objectId?: string };
      }>('DOM.resolveNode', { backendNodeId }, { sessionId });
      const objectId = resolved.object?.objectId;
      if (!objectId) return null;
      return { backendNodeId, objectId };
    } catch {
      return null;
    }
  };

  const backendResolved = await tryResolveBackendNode(roleRef.backendNodeId);
  if (backendResolved) return backendResolved;

  const evaluated = await connection.send<{
    result?: { objectId?: string };
  }>(
    'Runtime.evaluate',
    {
      expression: createFindElementExpression(roleRef),
      returnByValue: false,
      awaitPromise: false,
    },
    { sessionId },
  );
  const objectId = evaluated.result?.objectId;
  if (!objectId) {
    throw new Error(`Could not resolve ${normalizedRef} on the current page`);
  }

  const described = await connection.send<{
    node?: { backendNodeId?: number };
  }>('DOM.describeNode', { objectId }, { sessionId });
  const backendNodeId = described.node?.backendNodeId;
  if (!backendNodeId) {
    throw new Error(`Resolved ${normalizedRef} but missing backend node id`);
  }
  return {
    backendNodeId,
    objectId,
  };
}
