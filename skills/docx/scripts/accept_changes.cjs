#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  acceptAllChanges,
} = require('../../office/helpers/simplify_redlines.cjs');
const { parseXmlFile, writeXmlFile } = require('../../office/xml.cjs');

function candidateParts(docxDir) {
  const wordDir = path.join(docxDir, 'word');
  const candidates = [
    path.join(wordDir, 'document.xml'),
    ...fs
      .readdirSync(wordDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^header\d+\.xml$/.test(entry.name))
      .map((entry) => path.join(wordDir, entry.name))
      .sort(),
    ...fs
      .readdirSync(wordDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^footer\d+\.xml$/.test(entry.name))
      .map((entry) => path.join(wordDir, entry.name))
      .sort(),
    path.join(wordDir, 'footnotes.xml'),
    path.join(wordDir, 'endnotes.xml'),
  ];
  return candidates.filter((candidate) => fs.existsSync(candidate));
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 1) {
    throw new Error(
      'Usage: node skills/docx/scripts/accept_changes.cjs <docx_dir> [--json]',
    );
  }
  return {
    docxDir: path.resolve(args[0]),
    asJson: args.includes('--json'),
  };
}

function emit(payload, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (payload.success) {
    process.stdout.write(
      `Accepted tracked changes in ${payload.part_count} part(s).\n`,
    );
    return;
  }
  process.stdout.write(`${payload.error || 'Accept-changes failed.'}\n`);
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
  if (!fs.existsSync(documentPath)) {
    emit(
      {
        success: false,
        error: `Missing word/document.xml in ${options.docxDir}`,
      },
      options.asJson,
    );
    return 1;
  }

  const summaries = [];
  let totalAccepted = 0;
  let totalRemoved = 0;

  for (const part of candidateParts(options.docxDir)) {
    const document = parseXmlFile(part);
    const summary = acceptAllChanges(document);
    writeXmlFile(part, document, { pretty: true });
    totalAccepted += summary.accepted_wrappers;
    totalRemoved += summary.removed_nodes;
    summaries.push({
      part: path.relative(options.docxDir, part).split(path.sep).join('/'),
      ...summary,
    });
  }

  emit(
    {
      success: true,
      part_count: summaries.length,
      accepted_wrappers: totalAccepted,
      removed_nodes: totalRemoved,
      parts: summaries,
    },
    options.asJson,
  );
  return 0;
}

process.exitCode = main();
