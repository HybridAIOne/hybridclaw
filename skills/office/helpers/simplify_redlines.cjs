const ACCEPT_UNWRAP = new Set([
  `w:ins`,
  `w:moveTo`,
]);

const ACCEPT_DROP = new Set([
  `w:del`,
  `w:moveFrom`,
  `w:pPrChange`,
  `w:rPrChange`,
  `w:tblPrChange`,
  `w:trPrChange`,
  `w:tcPrChange`,
]);

function walkElements(node) {
  const nodes = [];
  const visit = (current) => {
    if (!current || current.nodeType !== 1) return;
    for (const child of Array.from(current.childNodes || [])) {
      if (child.nodeType === 1) {
        nodes.push(child);
        visit(child);
      }
    }
  };
  visit(node);
  return nodes;
}

function replaceWithChildren(parent, node) {
  while (node.firstChild) {
    parent.insertBefore(node.firstChild, node);
  }
  parent.removeChild(node);
  return 1;
}

function dropNode(parent, node) {
  parent.removeChild(node);
  return 1;
}

function acceptAllChanges(document) {
  let accepted = 0;
  let removed = 0;
  const root = document?.documentElement;
  if (!root) {
    return { accepted_wrappers: 0, removed_nodes: 0 };
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of walkElements(root)) {
      const parent = node.parentNode;
      if (!parent || parent.nodeType !== 1) continue;
      if (ACCEPT_UNWRAP.has(node.tagName)) {
        accepted += replaceWithChildren(parent, node);
        changed = true;
        break;
      }
      if (ACCEPT_DROP.has(node.tagName)) {
        removed += dropNode(parent, node);
        changed = true;
        break;
      }
    }
  }

  return {
    accepted_wrappers: accepted,
    removed_nodes: removed,
  };
}

module.exports = {
  acceptAllChanges,
};
