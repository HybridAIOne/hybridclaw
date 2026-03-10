#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const posixPath = require('node:path').posix;

const {
  collectElements,
  declaredNamespace,
  localName,
  parseXmlFile,
} = require('./xml.cjs');

const REL_NS =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NS =
  'http://schemas.openxmlformats.org/package/2006/content-types';

const PACKAGE_SPECS = {
  docx: {
    mainPart: 'word/document.xml',
    mainNs:
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  },
  pptx: {
    mainPart: 'ppt/presentation.xml',
    mainNs:
      'http://schemas.openxmlformats.org/presentationml/2006/main',
    contentType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  },
  xlsx: {
    mainPart: 'xl/workbook.xml',
    mainNs:
      'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    contentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  },
};

function detectPackageFormat(rootDir, format = 'auto') {
  if (format !== 'auto') {
    return format;
  }
  if (fs.existsSync(path.join(rootDir, 'word'))) {
    return 'docx';
  }
  if (fs.existsSync(path.join(rootDir, 'xl'))) {
    return 'xlsx';
  }
  if (fs.existsSync(path.join(rootDir, 'ppt'))) {
    return 'pptx';
  }
  throw new Error(
    'Could not detect OOXML package type. Pass --format docx|xlsx|pptx.',
  );
}

function sourcePartForRelationships(relPath) {
  const normalized = relPath.replace(/^\/+/, '');
  if (normalized === '_rels/.rels') {
    return '';
  }

  const parent = posixPath.dirname(normalized);
  const filename = posixPath.basename(normalized);
  if (!filename.endsWith('.rels') || !parent.endsWith('/_rels')) {
    throw new Error(`Unsupported relationships path: ${relPath}`);
  }

  const sourceDir = parent.slice(0, -'/_rels'.length);
  const sourceName = filename.slice(0, -'.rels'.length);
  return posixPath.join(sourceDir, sourceName).replace(/^\/+/, '');
}

function resolveRelationshipTarget(sourcePart, target) {
  const normalized = String(target || '').trim();
  if (!normalized) return null;

  let candidate;
  if (normalized.startsWith('/')) {
    candidate = posixPath.normalize(normalized).replace(/^\/+/, '');
  } else {
    const baseDir = posixPath.dirname(sourcePart);
    const joined = baseDir && baseDir !== '.'
      ? posixPath.join(baseDir, normalized)
      : normalized;
    candidate = posixPath.normalize(joined);
  }

  if (!candidate || candidate === '.' || candidate === '..' || candidate.startsWith('../')) {
    return null;
  }
  return candidate.replace(/^\/+/, '');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    throw new Error(
      'Usage: node skills/office/validate.cjs <root_dir> [--format auto|docx|xlsx|pptx] [--json]',
    );
  }

  const options = {
    rootDir: path.resolve(args[0]),
    format: 'auto',
    asJson: false,
  };

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.asJson = true;
      continue;
    }
    if (arg === '--format' && args[index + 1]) {
      options.format = args[index + 1];
      index += 1;
    }
  }

  return options;
}

function findElementsByLocalName(root, name) {
  return collectElements(root, (node) => localName(node.tagName) === name);
}

function listFilesRecursively(rootDir) {
  const files = [];
  const visit = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  };
  visit(rootDir);
  return files;
}

function validatePackage(rootDir, format = 'auto') {
  const packageType = detectPackageFormat(rootDir, format);
  const spec = PACKAGE_SPECS[packageType];
  const issues = [];

  const contentTypesPath = path.join(rootDir, '[Content_Types].xml');
  if (!fs.existsSync(contentTypesPath)) {
    issues.push('Missing [Content_Types].xml');
  } else {
    const document = parseXmlFile(contentTypesPath);
    const root = document.documentElement;
    if (declaredNamespace(root) !== CONTENT_TYPES_NS) {
      issues.push('[Content_Types].xml does not use the OOXML content-types root namespace');
    }
    const overrides = findElementsByLocalName(root, 'Override');
    const foundOverride = overrides.some(
      (node) =>
        node.getAttribute('PartName') === `/${spec.mainPart}` &&
        node.getAttribute('ContentType') === spec.contentType,
    );
    if (!foundOverride) {
      issues.push(
        `[Content_Types].xml is missing the main override for ${spec.mainPart}`,
      );
    }
  }

  const rootRelationships = path.join(rootDir, '_rels', '.rels');
  if (!fs.existsSync(rootRelationships)) {
    issues.push('Missing _rels/.rels');
  }

  const mainPartPath = path.join(rootDir, spec.mainPart);
  if (!fs.existsSync(mainPartPath)) {
    issues.push(`Missing main part: ${spec.mainPart}`);
  } else {
    const document = parseXmlFile(mainPartPath);
    const root = document.documentElement;
    if (!['document', 'presentation', 'workbook'].includes(localName(root.tagName))) {
      issues.push(`Unexpected main part root tag: ${root.tagName}`);
    }
    if (declaredNamespace(root) !== spec.mainNs) {
      issues.push(
        `Unexpected namespace for ${spec.mainPart}: ${declaredNamespace(root) || '(none)'}`,
      );
    }
  }

  const relationshipFiles = listFilesRecursively(rootDir)
    .filter((filePath) => filePath.endsWith('.rels'))
    .sort();

  for (const relsPath of relationshipFiles) {
    const relPart = path.relative(rootDir, relsPath).split(path.sep).join('/');
    let sourcePart;
    try {
      sourcePart = sourcePartForRelationships(relPart);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    const document = parseXmlFile(relsPath);
    const root = document.documentElement;
    if (localName(root.tagName) !== 'Relationships' || declaredNamespace(root) !== REL_NS) {
      issues.push(`${relPart} does not use the OOXML Relationships root`);
      continue;
    }

    const seenIds = new Set();
    const relationships = findElementsByLocalName(root, 'Relationship');
    for (const relationship of relationships) {
      const relId = String(relationship.getAttribute('Id') || '').trim();
      if (!relId) {
        issues.push(`${relPart} has a relationship without Id`);
        continue;
      }
      if (seenIds.has(relId)) {
        issues.push(`${relPart} has duplicate relationship Id ${relId}`);
      }
      seenIds.add(relId);

      if (
        String(relationship.getAttribute('TargetMode') || '')
          .trim()
          .toLowerCase() === 'external'
      ) {
        continue;
      }

      const target = resolveRelationshipTarget(
        sourcePart,
        relationship.getAttribute('Target') || '',
      );
      if (!target) {
        issues.push(`${relPart} has an invalid target for ${relId}`);
        continue;
      }
      if (!fs.existsSync(path.join(rootDir, target))) {
        issues.push(`${relPart} points to missing part ${target}`);
      }
    }
  }

  return issues;
}

function emit(payload, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (Array.isArray(payload.issues) && payload.issues.length > 0) {
    process.stdout.write('Validation failed:\n');
    for (const issue of payload.issues) {
      process.stdout.write(`- ${issue}\n`);
    }
    return;
  }

  process.stdout.write('Validation succeeded.\n');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (error) {
    emit(
      {
        success: false,
        issues: [error instanceof Error ? error.message : String(error)],
      },
      true,
    );
    return 1;
  }

  if (!fs.existsSync(options.rootDir) || !fs.statSync(options.rootDir).isDirectory()) {
    const payload = {
      success: false,
      issues: [`Directory does not exist: ${options.rootDir}`],
    };
    emit(payload, options.asJson);
    return 1;
  }

  let packageType;
  try {
    packageType = detectPackageFormat(options.rootDir, options.format);
  } catch (error) {
    emit(
      {
        success: false,
        issues: [error instanceof Error ? error.message : String(error)],
      },
      options.asJson,
    );
    return 1;
  }

  const issues = validatePackage(options.rootDir, packageType);
  const payload = {
    success: issues.length === 0,
    format: packageType,
    issues,
  };
  emit(payload, options.asJson);
  return issues.length === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  CONTENT_TYPES_NS,
  PACKAGE_SPECS,
  REL_NS,
  detectPackageFormat,
  resolveRelationshipTarget,
  sourcePartForRelationships,
  validatePackage,
};
