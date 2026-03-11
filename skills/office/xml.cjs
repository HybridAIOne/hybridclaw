const fs = require('node:fs');

const { DOMParser } = require('linkedom');

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

function localName(tagName) {
  return (
    String(tagName || '')
      .split(':')
      .pop() || ''
  );
}

function needsSpacePreserve(text) {
  return Boolean(text) && (/^\s/.test(text) || /\s$/.test(text));
}

function isWhitespaceText(node) {
  return (
    node &&
    (node.nodeType === 3 || node.nodeType === 4) &&
    /^[\t\n\r ]*$/.test(node.nodeValue || '')
  );
}

function getChildNodes(node) {
  return Array.from(node?.childNodes || []);
}

function getElementChildren(node) {
  return getChildNodes(node).filter((child) => child.nodeType === 1);
}

function collectElements(root, predicate) {
  const matches = [];
  const visit = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (predicate(node)) matches.push(node);
    for (const child of getElementChildren(node)) {
      visit(child);
    }
  };
  visit(root);
  return matches;
}

function declaredNamespace(element) {
  if (!element || element.nodeType !== 1) return '';
  const tagName = String(element.tagName || '');
  if (tagName.includes(':')) {
    const prefix = tagName.split(':', 1)[0];
    return element.getAttribute(`xmlns:${prefix}`) || '';
  }
  return element.getAttribute('xmlns') || '';
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function serializeAttributes(node) {
  return Array.from(node.attributes || [])
    .map(
      (attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`,
    )
    .join('');
}

function serializePrettyNode(node, level = 0) {
  const indent = '  '.repeat(level);
  if (!node || node.nodeType !== 1) {
    return '';
  }

  const children = getChildNodes(node);
  if (children.length === 0) {
    return `${indent}<${node.tagName}${serializeAttributes(node)} />`;
  }

  const textChildren = children.filter(
    (child) => child.nodeType === 3 || child.nodeType === 4,
  );
  const hasSignificantTextChild = textChildren.some(
    (child) => !isWhitespaceText(child),
  );
  const hasElementChild = children.some((child) => child.nodeType === 1);

  // Preserve leaf text and mixed-content nodes exactly as parsed.
  if (
    hasSignificantTextChild ||
    (textChildren.length > 0 && !hasElementChild)
  ) {
    return `${indent}${node.toString()}`;
  }

  const childBlocks = [];
  for (const child of children) {
    if (isWhitespaceText(child)) continue;
    if (child.nodeType === 8) {
      childBlocks.push(`${'  '.repeat(level + 1)}${child.toString()}`);
      continue;
    }
    if (child.nodeType === 1) {
      childBlocks.push(serializePrettyNode(child, level + 1));
    }
  }

  if (!hasElementChild || childBlocks.length === 0) {
    return `${indent}<${node.tagName}${serializeAttributes(node)} />`;
  }

  return `${indent}<${node.tagName}${serializeAttributes(node)}>\n${childBlocks.join('\n')}\n${indent}</${node.tagName}>`;
}

function normalizeDeclaration(serialized) {
  const normalized = String(serialized || '').replace(
    /^<\?xml[^>]*\?>/i,
    XML_DECLARATION,
  );
  if (normalized.startsWith(XML_DECLARATION)) {
    return normalized;
  }
  return `${XML_DECLARATION}${normalized}`;
}

function parseXml(payload) {
  const source = Buffer.isBuffer(payload)
    ? payload.toString('utf8')
    : String(payload);
  return new DOMParser().parseFromString(source, 'text/xml');
}

function parseXmlFile(filePath) {
  return parseXml(fs.readFileSync(filePath));
}

function createXmlDocument(rootTag, attributes = {}) {
  const attrs = Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
  return parseXml(`${XML_DECLARATION}<${rootTag}${attrs}></${rootTag}>`);
}

function compactElementWhitespace(node) {
  if (!node || node.nodeType !== 1) return;
  const children = getChildNodes(node);
  const hasElementChild = children.some((child) => child.nodeType === 1);
  for (const child of children) {
    if (child.nodeType === 1) {
      compactElementWhitespace(child);
      continue;
    }
    if (hasElementChild && isWhitespaceText(child)) {
      node.removeChild(child);
    }
  }
}

function compactDocument(document) {
  compactElementWhitespace(document?.documentElement);
}

function serializeXml(document, options = {}) {
  const pretty = options.pretty === true;
  const serialized = pretty
    ? `${XML_DECLARATION}\n${serializePrettyNode(document.documentElement, 0)}\n`
    : normalizeDeclaration(document.toString());
  return Buffer.from(serialized, 'utf8');
}

function writeXmlFile(filePath, document, options = {}) {
  fs.writeFileSync(filePath, serializeXml(document, options));
}

module.exports = {
  XML_DECLARATION,
  collectElements,
  compactDocument,
  createXmlDocument,
  declaredNamespace,
  getChildNodes,
  getElementChildren,
  isWhitespaceText,
  localName,
  needsSpacePreserve,
  parseXml,
  parseXmlFile,
  serializeXml,
  writeXmlFile,
};
