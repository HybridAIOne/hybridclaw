#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const JSZip = require('jszip');

const {
  compactDocument,
  parseXmlFile,
  serializeXml,
} = require('./xml.cjs');
const { detectPackageFormat, validatePackage } = require('./validate.cjs');

const XML_EXTENSIONS = new Set(['.xml', '.rels']);

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

function sortedMembers(rootDir) {
  const members = listFilesRecursively(rootDir);

  const sortKey = (memberPath) => {
    const relativePath = path.relative(rootDir, memberPath).split(path.sep).join('/');
    if (relativePath === '[Content_Types].xml') {
      return [0, relativePath];
    }
    if (relativePath === '_rels/.rels') {
      return [1, relativePath];
    }
    return [2, relativePath];
  };

  return members.sort((left, right) => {
    const [leftOrder, leftPath] = sortKey(left);
    const [rightOrder, rightPath] = sortKey(right);
    return leftOrder - rightOrder || leftPath.localeCompare(rightPath);
  });
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 2) {
    throw new Error(
      'Usage: node skills/office/pack.cjs <input_dir> <output_path> [--format auto|docx|xlsx|pptx] [--skip-validate] [--json]',
    );
  }

  const options = {
    inputDir: path.resolve(args[0]),
    outputPath: path.resolve(args[1]),
    format: 'auto',
    skipValidate: false,
    asJson: false,
  };

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--skip-validate') {
      options.skipValidate = true;
      continue;
    }
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

function emit(payload, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (payload.success) {
    process.stdout.write(`Packed ${payload.format} file at ${payload.output_path}\n`);
    return;
  }
  process.stdout.write('Pack failed:\n');
  for (const issue of payload.issues || []) {
    process.stdout.write(`- ${issue}\n`);
  }
}

async function main() {
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

  if (!fs.existsSync(options.inputDir) || !fs.statSync(options.inputDir).isDirectory()) {
    emit(
      {
        success: false,
        issues: [`Directory does not exist: ${options.inputDir}`],
      },
      options.asJson,
    );
    return 1;
  }

  let packageType;
  try {
    packageType = detectPackageFormat(options.inputDir, options.format);
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

  const issues = options.skipValidate
    ? []
    : validatePackage(options.inputDir, packageType);
  if (issues.length > 0) {
    emit(
      {
        success: false,
        format: packageType,
        issues,
      },
      options.asJson,
    );
    return 1;
  }

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });

  const archive = new JSZip();
  for (const memberPath of sortedMembers(options.inputDir)) {
    const archivePath = path
      .relative(options.inputDir, memberPath)
      .split(path.sep)
      .join('/');
    const suffix = path.extname(memberPath).toLowerCase();
    if (XML_EXTENSIONS.has(suffix) || archivePath.endsWith('.rels')) {
      const document = parseXmlFile(memberPath);
      compactDocument(document);
      archive.file(archivePath, serializeXml(document));
      continue;
    }
    archive.file(archivePath, fs.readFileSync(memberPath));
  }

  const buffer = await archive.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
  fs.writeFileSync(options.outputPath, buffer);

  emit(
    {
      success: true,
      format: packageType,
      output_path: options.outputPath,
    },
    options.asJson,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    emit(
      {
        success: false,
        issues: [error instanceof Error ? error.message : String(error)],
      },
      true,
    );
    process.exitCode = 1;
  },
);
