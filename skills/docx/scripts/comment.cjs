#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  collectElements,
  createXmlDocument,
  getElementChildren,
  needsSpacePreserve,
  parseXmlFile,
  writeXmlFile,
} = require('../../office/xml.cjs');

const WORD_NS =
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS =
  'http://schemas.openxmlformats.org/package/2006/relationships';

const COMMENTS_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const COMMENTS_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';

function copyAttributes(source, target) {
  for (const attribute of Array.from(source.attributes || [])) {
    target.setAttribute(attribute.name, attribute.value);
  }
}

function replaceText(element, text) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
  element.appendChild(element.ownerDocument.createTextNode(text));
}

function cloneRunWithText(document, run, text) {
  const clone = document.createElement(run.tagName);
  copyAttributes(run, clone);

  const runProperties = getElementChildren(run).find(
    (child) => child.tagName === 'w:rPr',
  );
  if (runProperties) {
    clone.appendChild(runProperties.cloneNode(true));
  }

  const textNode = document.createElement('w:t');
  if (needsSpacePreserve(text)) {
    textNode.setAttribute('xml:space', 'preserve');
  }
  replaceText(textNode, text);
  clone.appendChild(textNode);
  return clone;
}

function ensureCommentsPart(docxDir) {
  const commentsPath = path.join(docxDir, 'word', 'comments.xml');
  if (fs.existsSync(commentsPath)) {
    return parseXmlFile(commentsPath);
  }

  fs.mkdirSync(path.dirname(commentsPath), { recursive: true });
  const document = createXmlDocument('w:comments', { 'xmlns:w': WORD_NS });
  writeXmlFile(commentsPath, document, { pretty: true });
  return document;
}

function ensureCommentsRelationship(docxDir) {
  const relsPath = path.join(docxDir, 'word', '_rels', 'document.xml.rels');
  fs.mkdirSync(path.dirname(relsPath), { recursive: true });

  const document = fs.existsSync(relsPath)
    ? parseXmlFile(relsPath)
    : createXmlDocument('Relationships', { xmlns: REL_NS });
  const root = document.documentElement;

  const relationships = collectElements(
    root,
    (node) => node.tagName === 'Relationship',
  );
  if (
    relationships.some((relationship) => relationship.getAttribute('Type') === COMMENTS_REL_TYPE)
  ) {
    writeXmlFile(relsPath, document, { pretty: true });
    return;
  }

  const nextId =
    relationships.reduce((maxId, relationship) => {
      const currentId = String(relationship.getAttribute('Id') || '');
      if (!currentId.startsWith('rId')) return maxId;
      const numericPart = Number.parseInt(currentId.slice(3), 10);
      return Number.isFinite(numericPart) ? Math.max(maxId, numericPart) : maxId;
    }, 0) + 1;

  const relationship = document.createElement('Relationship');
  relationship.setAttribute('Id', `rId${nextId}`);
  relationship.setAttribute('Type', COMMENTS_REL_TYPE);
  relationship.setAttribute('Target', 'comments.xml');
  root.appendChild(relationship);
  writeXmlFile(relsPath, document, { pretty: true });
}

function ensureCommentsContentType(docxDir) {
  const contentTypesPath = path.join(docxDir, '[Content_Types].xml');
  const document = parseXmlFile(contentTypesPath);
  const root = document.documentElement;
  const overrides = collectElements(root, (node) => node.tagName === 'Override');

  if (
    overrides.some((override) => override.getAttribute('PartName') === '/word/comments.xml')
  ) {
    writeXmlFile(contentTypesPath, document, { pretty: true });
    return;
  }

  const override = document.createElement('Override');
  override.setAttribute('PartName', '/word/comments.xml');
  override.setAttribute('ContentType', COMMENTS_CONTENT_TYPE);
  root.appendChild(override);
  writeXmlFile(contentTypesPath, document, { pretty: true });
}

function nextCommentId(commentsRoot) {
  return (
    collectElements(commentsRoot, (node) => node.tagName === 'w:comment').reduce(
      (maxId, node) => {
        const value = Number.parseInt(node.getAttribute('w:id') || '', 10);
        return Number.isFinite(value) ? Math.max(maxId, value) : maxId;
      },
      -1,
    ) + 1
  );
}

function appendComment(commentsRoot, commentId, commentText, author, initials) {
  const document = commentsRoot.ownerDocument;
  const comment = document.createElement('w:comment');
  comment.setAttribute('w:id', String(commentId));
  comment.setAttribute('w:author', author);
  comment.setAttribute('w:initials', initials);
  comment.setAttribute('w:date', new Date().toISOString());

  const paragraph = document.createElement('w:p');
  const run = document.createElement('w:r');
  const textNode = document.createElement('w:t');
  if (needsSpacePreserve(commentText)) {
    textNode.setAttribute('xml:space', 'preserve');
  }
  replaceText(textNode, commentText);

  run.appendChild(textNode);
  paragraph.appendChild(run);
  comment.appendChild(paragraph);
  commentsRoot.appendChild(comment);
}

function buildReferenceRun(document, commentId) {
  const run = document.createElement('w:r');
  const runProperties = document.createElement('w:rPr');
  const runStyle = document.createElement('w:rStyle');
  runStyle.setAttribute('w:val', 'CommentReference');
  runProperties.appendChild(runStyle);

  const reference = document.createElement('w:commentReference');
  reference.setAttribute('w:id', String(commentId));
  run.appendChild(runProperties);
  run.appendChild(reference);
  return run;
}

function locateTextRun(documentRoot, matchText, occurrence) {
  let matchesSeen = 0;
  const textNodes = collectElements(documentRoot, (node) => node.tagName === 'w:t');
  for (const textNode of textNodes) {
    const textValue = textNode.textContent || '';
    let start = textValue.indexOf(matchText);
    while (start !== -1) {
      matchesSeen += 1;
      if (matchesSeen === occurrence) {
        const run = textNode.parentNode;
        if (!run || run.nodeType !== 1 || run.tagName !== 'w:r') {
          throw new Error('Matched text is not inside a Word run.');
        }
        return { run, textNode, start };
      }
      start = textValue.indexOf(matchText, start + 1);
    }
  }

  throw new Error(
    `Could not find match #${occurrence} for "${matchText}" in word/document.xml.`,
  );
}

function insertCommentMarkup(run, textNode, start, matchText, commentId) {
  const paragraph = run.parentNode;
  if (!paragraph || paragraph.nodeType !== 1) {
    throw new Error('Matched run does not have a paragraph parent.');
  }

  const runChildren = getElementChildren(run);
  const textNodes = runChildren.filter((child) => child.tagName === 'w:t');
  if (textNodes.length !== 1 || textNodes[0] !== textNode) {
    throw new Error(
      'The helper currently supports only runs with a single w:t element.',
    );
  }

  if (runChildren.some((child) => !['w:rPr', 'w:t'].includes(child.tagName))) {
    throw new Error(
      'The matched run contains unsupported OOXML children. Edit it manually.',
    );
  }

  const originalText = textNode.textContent || '';
  const end = start + matchText.length;
  const before = originalText.slice(0, start);
  const matched = originalText.slice(start, end);
  const after = originalText.slice(end);

  const document = run.ownerDocument;
  const nodes = [];
  if (before) {
    nodes.push(cloneRunWithText(document, run, before));
  }

  const rangeStart = document.createElement('w:commentRangeStart');
  rangeStart.setAttribute('w:id', String(commentId));
  nodes.push(rangeStart);
  nodes.push(cloneRunWithText(document, run, matched));

  const rangeEnd = document.createElement('w:commentRangeEnd');
  rangeEnd.setAttribute('w:id', String(commentId));
  nodes.push(rangeEnd);
  nodes.push(buildReferenceRun(document, commentId));

  if (after) {
    nodes.push(cloneRunWithText(document, run, after));
  }

  const nextSibling = run.nextSibling;
  paragraph.removeChild(run);
  for (const node of nodes) {
    paragraph.insertBefore(node, nextSibling);
  }

  return matched;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 1) {
    throw new Error(
      'Usage: node skills/docx/scripts/comment.cjs <docx_dir> --match "text" --comment "note" [--occurrence 1] [--author HybridClaw] [--initials HC] [--json]',
    );
  }

  const options = {
    docxDir: path.resolve(args[0]),
    match: null,
    comment: null,
    occurrence: 1,
    author: 'HybridClaw',
    initials: 'HC',
    asJson: false,
  };

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.asJson = true;
      continue;
    }
    if (
      ['--match', '--comment', '--occurrence', '--author', '--initials'].includes(arg) &&
      args[index + 1]
    ) {
      const value = args[index + 1];
      if (arg === '--match') options.match = value;
      if (arg === '--comment') options.comment = value;
      if (arg === '--occurrence') {
        options.occurrence = Number.parseInt(value, 10);
      }
      if (arg === '--author') options.author = value;
      if (arg === '--initials') options.initials = value;
      index += 1;
    }
  }

  if (!options.match || !options.comment) {
    throw new Error('Both --match and --comment are required.');
  }
  if (!Number.isInteger(options.occurrence) || options.occurrence < 1) {
    throw new Error('--occurrence must be a positive integer.');
  }

  return options;
}

function emit(payload, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (payload.success) {
    process.stdout.write(
      `Inserted comment #${payload.comment_id} for match "${payload.matched_text}".\n`,
    );
    return;
  }
  process.stdout.write(`${payload.error || 'Comment insertion failed.'}\n`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (error) {
    emit(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      true,
    );
    return 1;
  }

  const documentPath = path.join(options.docxDir, 'word', 'document.xml');
  if (!fs.existsSync(documentPath) || !fs.statSync(documentPath).isFile()) {
    emit(
      {
        success: false,
        error: `Missing word/document.xml in ${options.docxDir}`,
      },
      options.asJson,
    );
    return 1;
  }

  try {
    const documentTree = parseXmlFile(documentPath);
    const documentRoot = documentTree.documentElement;
    const { run, textNode, start } = locateTextRun(
      documentRoot,
      options.match,
      options.occurrence,
    );
    const commentsTree = ensureCommentsPart(options.docxDir);
    const commentsRoot = commentsTree.documentElement;
    const commentId = nextCommentId(commentsRoot);
    const matchedText = insertCommentMarkup(
      run,
      textNode,
      start,
      options.match,
      commentId,
    );

    appendComment(
      commentsRoot,
      commentId,
      options.comment,
      options.author,
      options.initials,
    );
    ensureCommentsRelationship(options.docxDir);
    ensureCommentsContentType(options.docxDir);
    writeXmlFile(documentPath, documentTree, { pretty: true });
    writeXmlFile(path.join(options.docxDir, 'word', 'comments.xml'), commentsTree, {
      pretty: true,
    });

    emit(
      {
        success: true,
        comment_id: commentId,
        matched_text: matchedText,
      },
      options.asJson,
    );
    return 0;
  } catch (error) {
    emit(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      options.asJson,
    );
    return 1;
  }
}

process.exitCode = main();
