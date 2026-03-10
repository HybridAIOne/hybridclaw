#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const JSZip = require('jszip');

const XML_EXTENSIONS = new Set(['.xml', '.rels']);

function isPathWithinRoot(candidate, root) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function resolveMemberDestination(outputDir, memberName) {
  const normalizedMemberName = String(memberName || '').replace(/\\/g, '/');
  if (!normalizedMemberName || normalizedMemberName.includes('\0')) {
    throw new Error(`Unsafe archive member name: ${memberName}`);
  }
  if (
    normalizedMemberName.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalizedMemberName)
  ) {
    throw new Error(`Archive member uses an absolute path: ${memberName}`);
  }

  const destination = path.resolve(outputDir, normalizedMemberName);
  if (!isPathWithinRoot(destination, outputDir)) {
    throw new Error(
      `Archive member would extract outside the output directory: ${memberName}`,
    );
  }
  return destination;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 2) {
    throw new Error(
      'Usage: node skills/office/unpack.cjs <input_path> <output_dir> [--force] [--no-merge-runs] [--json]',
    );
  }

  const options = {
    inputPath: path.resolve(args[0]),
    outputDir: path.resolve(args[1]),
    force: false,
    mergeRuns: true,
    asJson: false,
  };

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--no-merge-runs') {
      options.mergeRuns = false;
      continue;
    }
    if (arg === '--json') {
      options.asJson = true;
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
    process.stdout.write(`Unpacked archive to ${payload.output_dir}\n`);
    return;
  }
  process.stdout.write('Unpack failed:\n');
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

  if (
    !fs.existsSync(options.inputPath) ||
    !fs.statSync(options.inputPath).isFile()
  ) {
    const payload = {
      success: false,
      issues: [`File does not exist: ${options.inputPath}`],
    };
    emit(payload, options.asJson);
    return 1;
  }

  if (fs.existsSync(options.outputDir)) {
    if (!options.force) {
      emit(
        {
          success: false,
          issues: [
            `Output directory already exists: ${options.outputDir} (pass --force to replace it)`,
          ],
        },
        options.asJson,
      );
      return 1;
    }
    fs.rmSync(options.outputDir, { recursive: true, force: true });
  }

  fs.mkdirSync(options.outputDir, { recursive: true });

  const archive = await JSZip.loadAsync(fs.readFileSync(options.inputPath));
  const { mergeAdjacentRuns } = require('./helpers/merge_runs.cjs');
  const { parseXml, serializeXml } = require('./xml.cjs');
  let filesWritten = 0;
  let mergedRuns = 0;

  for (const [memberName, member] of Object.entries(archive.files)) {
    if (member.dir) continue;
    const destination = resolveMemberDestination(options.outputDir, memberName);
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    const payload = await member.async('nodebuffer');
    const suffix = path.extname(memberName).toLowerCase();
    if (XML_EXTENSIONS.has(suffix) || memberName.endsWith('.rels')) {
      const document = parseXml(payload);
      if (options.mergeRuns) {
        mergedRuns += mergeAdjacentRuns(document);
      }
      fs.writeFileSync(destination, serializeXml(document, { pretty: true }));
    } else {
      fs.writeFileSync(destination, payload);
    }
    filesWritten += 1;
  }

  emit(
    {
      success: true,
      output_dir: options.outputDir,
      files_written: filesWritten,
      merged_runs: mergedRuns,
    },
    options.asJson,
  );
  return 0;
}

if (require.main === module) {
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
}

module.exports = {
  resolveMemberDestination,
};
