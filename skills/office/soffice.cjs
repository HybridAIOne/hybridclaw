#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

function findSoffice() {
  const candidates = ['soffice', 'libreoffice'];
  for (const candidate of candidates) {
    const result = spawnSync('sh', ['-lc', `command -v ${candidate}`], {
      encoding: 'utf8',
    });
    if (result.status === 0) {
      const resolved = (result.stdout || '').trim();
      if (resolved) return resolved;
    }
  }
  return null;
}

function buildProfileUri(profileDir) {
  return pathToFileURL(profileDir).href;
}

function buildBaseCommand(profileDir) {
  const soffice = findSoffice();
  if (!soffice) {
    throw new Error('LibreOffice `soffice` is not installed.');
  }
  return [
    soffice,
    '--headless',
    '--nologo',
    '--nodefault',
    '--nolockcheck',
    '--norestore',
    `-env:UserInstallation=${buildProfileUri(profileDir)}`,
  ];
}

function runCommand(argv) {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    env: { ...process.env, HOME: process.env.HOME || '/tmp' },
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function convertDocument(inputPath, outputDir, format) {
  fs.mkdirSync(outputDir, { recursive: true });
  const profileDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-soffice-profile-'),
  );
  try {
    const argv = buildBaseCommand(profileDir).concat([
      '--convert-to',
      format,
      '--outdir',
      outputDir,
      inputPath,
    ]);
    const result = runCommand(argv);
    const outputExtension = String(format).split(':', 1)[0];
    const outputPath = path.join(
      outputDir,
      `${path.parse(inputPath).name}.${outputExtension}`,
    );
    return {
      success: result.code === 0 && fs.existsSync(outputPath),
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      output_path: outputPath,
    };
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

function recalcWorkbook(inputPath, outputPath) {
  const targetPath = path.resolve(outputPath || inputPath);
  const workingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-recalc-work-'),
  );
  const convertedDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-recalc-out-'),
  );
  try {
    const workingInput = path.join(workingDir, path.basename(inputPath));
    fs.copyFileSync(inputPath, workingInput);
    const result = convertDocument(workingInput, convertedDir, 'xlsx');
    const convertedPath = String(result.output_path || '');
    if (result.success && convertedPath && fs.existsSync(convertedPath)) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(convertedPath, targetPath);
    }
    return {
      ...result,
      output_path: targetPath,
      recalculated: Boolean(result.success),
    };
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(convertedDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const filtered = args.filter((arg) => arg !== '--json');
  const command = filtered[0];

  if (!command) {
    throw new Error(
      'Usage: node skills/office/soffice.cjs <convert|recalc> ... [--json]',
    );
  }

  if (command === 'convert') {
    const inputPath = filtered[1];
    const outputDir = filtered[2];
    if (!inputPath || !outputDir) {
      throw new Error(
        'Usage: node skills/office/soffice.cjs convert <input_path> <output_dir> [--format pdf] [--json]',
      );
    }
    let format = 'pdf';
    for (let index = 3; index < filtered.length; index += 1) {
      if (filtered[index] === '--format' && filtered[index + 1]) {
        format = filtered[index + 1];
        index += 1;
      }
    }
    return {
      asJson,
      command,
      inputPath: path.resolve(inputPath),
      outputDir: path.resolve(outputDir),
      format,
    };
  }

  if (command === 'recalc') {
    const inputPath = filtered[1];
    if (!inputPath) {
      throw new Error(
        'Usage: node skills/office/soffice.cjs recalc <input_path> [--output workbook.xlsx] [--json]',
      );
    }
    let output = null;
    for (let index = 2; index < filtered.length; index += 1) {
      if (filtered[index] === '--output' && filtered[index + 1]) {
        output = filtered[index + 1];
        index += 1;
      }
    }
    return {
      asJson,
      command,
      inputPath: path.resolve(inputPath),
      outputPath: output ? path.resolve(output) : null,
    };
  }

  throw new Error(`Unsupported command: ${command}`);
}

function emit(payload, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (payload.success) {
    process.stdout.write(`${payload.output_path || 'Success'}\n`);
    return;
  }
  process.stdout.write(
    `${payload.stderr || payload.stdout || 'LibreOffice failed.'}\n`,
  );
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    const payload = {
      success: false,
      stderr: error instanceof Error ? error.message : String(error),
    };
    emit(payload, true);
    return 1;
  }

  if (!fs.existsSync(args.inputPath) || !fs.statSync(args.inputPath).isFile()) {
    const payload = {
      success: false,
      stderr: `File does not exist: ${args.inputPath}`,
    };
    emit(payload, args.asJson);
    return 1;
  }

  if (!findSoffice()) {
    const payload = {
      success: false,
      stderr: 'LibreOffice `soffice` is not installed.',
    };
    emit(payload, args.asJson);
    return 1;
  }

  const payload =
    args.command === 'convert'
      ? convertDocument(args.inputPath, args.outputDir, args.format)
      : recalcWorkbook(args.inputPath, args.outputPath);
  emit(payload, args.asJson);
  return payload.success ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    emit(
      {
        success: false,
        stderr: error instanceof Error ? error.message : String(error),
      },
      true,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  findSoffice,
};
