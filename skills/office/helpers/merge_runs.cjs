const {
  getElementChildren,
  localName,
  needsSpacePreserve,
} = require('../xml.cjs');

function textSignature(run, textTag) {
  if (localName(run?.tagName) !== 'r') {
    return null;
  }

  const allowed = new Set(['rPr', localName(textTag)]);
  const children = getElementChildren(run);
  if (children.length === 0) {
    return null;
  }

  if (children.some((child) => !allowed.has(localName(child.tagName)))) {
    return null;
  }

  const textNodes = children.filter((child) => child.tagName === textTag);
  if (textNodes.length === 0) {
    return null;
  }

  const formatting = children.find(
    (child) => localName(child.tagName) === 'rPr',
  );
  return formatting ? formatting.toString() : '';
}

function replaceText(element, text) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
  element.appendChild(element.ownerDocument.createTextNode(text));
}

function mergeRunSequence(paragraph, runTag, textTag) {
  let merged = 0;
  let changed = true;

  while (changed) {
    changed = false;
    const children = getElementChildren(paragraph);
    for (let index = 0; index < children.length - 1; index += 1) {
      const current = children[index];
      const following = children[index + 1];
      if (current.tagName !== runTag || following.tagName !== runTag) {
        continue;
      }

      const currentSignature = textSignature(current, textTag);
      const followingSignature = textSignature(following, textTag);
      if (currentSignature == null || currentSignature !== followingSignature) {
        continue;
      }

      const currentTextNodes = getElementChildren(current).filter(
        (child) => child.tagName === textTag,
      );
      const followingTextNodes = getElementChildren(following).filter(
        (child) => child.tagName === textTag,
      );
      if (currentTextNodes.length === 0 || followingTextNodes.length === 0) {
        continue;
      }

      const combined =
        currentTextNodes.map((node) => node.textContent || '').join('') +
        followingTextNodes.map((node) => node.textContent || '').join('');

      const lastCurrentText = currentTextNodes[currentTextNodes.length - 1];
      replaceText(lastCurrentText, combined);
      if (needsSpacePreserve(combined)) {
        lastCurrentText.setAttribute('xml:space', 'preserve');
      } else {
        lastCurrentText.removeAttribute('xml:space');
      }

      for (
        let textIndex = 0;
        textIndex < currentTextNodes.length - 1;
        textIndex += 1
      ) {
        current.removeChild(currentTextNodes[textIndex]);
      }
      paragraph.removeChild(following);
      merged += 1;
      changed = true;
      break;
    }
  }

  return merged;
}

function mergeAdjacentRuns(document) {
  const root = document?.documentElement;
  if (!root) return 0;

  let merged = 0;
  const wordParagraphs = [];
  const drawingParagraphs = [];

  const visit = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === 'w:p') {
      wordParagraphs.push(node);
    }
    if (node.tagName === 'a:p') {
      drawingParagraphs.push(node);
    }
    for (const child of getElementChildren(node)) {
      visit(child);
    }
  };

  visit(root);

  for (const paragraph of wordParagraphs) {
    merged += mergeRunSequence(paragraph, 'w:r', 'w:t');
  }
  for (const paragraph of drawingParagraphs) {
    merged += mergeRunSequence(paragraph, 'a:r', 'a:t');
  }

  return merged;
}

module.exports = {
  mergeAdjacentRuns,
};
