import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import Database from 'better-sqlite3';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import {
  resolveArchiveEntryDestination,
  safeExtractZip,
} from '../agents/claw-security.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';

function normalizeArgs(args: string[]): string[] {
  return args.map((arg) => arg.trim()).filter(Boolean);
}

const BACKUP_MANIFEST_FILE = 'hybridclaw-backup.json';
const BACKUP_PAYLOAD_ROOT = 'hybridclaw';
const BACKUP_FORMAT_VERSION = 1;
const BACKUP_MARKER_FILES = [
  `${BACKUP_PAYLOAD_ROOT}/config.json`,
  `${BACKUP_PAYLOAD_ROOT}/credentials.json`,
];

const EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  'cache',
  'container-image-state',
  'evals',
  'migration-backups',
]);
const EXCLUDED_BASENAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'gateway.pid',
  'cron.pid',
]);
const EXCLUDED_SUFFIXES = ['-shm', '-wal', '-journal'];
const SQLITE_SUFFIXES = ['.db', '.sqlite', '.sqlite3'];

interface BackupManifest {
  formatVersion: number;
  createdAt: string;
  hostname: string;
  platform: string;
  sourceRoot: string;
  entries: number;
  sqliteSnapshots: string[];
}

interface CollectedFile {
  absolutePath: string;
  relativePath: string;
  isSqlite: boolean;
}

function isSqliteFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SQLITE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function shouldExcludeBasename(name: string): boolean {
  if (EXCLUDED_BASENAMES.has(name)) return true;
  if (name.startsWith('.tmp-')) return true;
  if (EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  return false;
}

function collectBackupFiles(rootDir: string): CollectedFile[] {
  const files: CollectedFile[] = [];
  const stack: string[] = [''];

  while (stack.length > 0) {
    const relativeDir = stack.pop();
    if (relativeDir == null) continue;
    const absoluteDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (shouldExcludeBasename(entry.name)) continue;
      const relativePath = relativeDir
        ? path.posix.join(relativeDir, entry.name)
        : entry.name;
      const absolutePath = path.join(absoluteDir, entry.name);
      const stats = fs.lstatSync(absolutePath);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
        stack.push(relativePath);
        continue;
      }
      if (!stats.isFile()) continue;
      files.push({
        absolutePath,
        relativePath,
        isSqlite: isSqliteFile(entry.name),
      });
    }
  }

  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  return files;
}

function timestampSuffix(now: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

async function snapshotSqliteDatabase(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destinationPath);
  } finally {
    db.close();
  }
}

function writeZipArchive(
  outputPath: string,
  manifest: BackupManifest,
  files: CollectedFile[],
  sqliteSnapshots: Map<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const zipFile = new yazl.ZipFile();
    const output = fs.createWriteStream(outputPath);
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      output.destroy();
      fs.rmSync(outputPath, { force: true });
      reject(error);
    };

    output.on('error', fail);
    output.on('close', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipFile.outputStream.on('error', fail).pipe(output);

    zipFile.addBuffer(
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf-8'),
      BACKUP_MANIFEST_FILE,
    );

    for (const file of files) {
      const archivePath = path.posix.join(
        BACKUP_PAYLOAD_ROOT,
        file.relativePath,
      );
      const snapshot = sqliteSnapshots.get(file.relativePath);
      if (snapshot) {
        zipFile.addFile(snapshot, archivePath);
      } else {
        zipFile.addFile(file.absolutePath, archivePath);
      }
    }

    zipFile.end();
  });
}

export interface CreateBackupOptions {
  sourceDir?: string;
  outputPath?: string;
  now?: Date;
}

export interface CreateBackupResult {
  archivePath: string;
  manifest: BackupManifest;
  entryCount: number;
  sqliteSnapshots: string[];
}

export async function createBackupArchive(
  options: CreateBackupOptions = {},
): Promise<CreateBackupResult> {
  const sourceDir = path.resolve(options.sourceDir ?? DEFAULT_RUNTIME_HOME_DIR);
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`HybridClaw runtime home not found: ${sourceDir}`);
  }
  const sourceStats = fs.statSync(sourceDir);
  if (!sourceStats.isDirectory()) {
    throw new Error(`HybridClaw runtime home is not a directory: ${sourceDir}`);
  }

  const now = options.now ?? new Date();
  const defaultName = `hybridclaw-backup-${timestampSuffix(now)}.zip`;
  const archivePath = path.resolve(
    options.outputPath ?? path.join(process.cwd(), defaultName),
  );

  const files = collectBackupFiles(sourceDir);
  if (files.length === 0) {
    throw new Error(
      `HybridClaw runtime home at ${sourceDir} contained no files to back up.`,
    );
  }

  const snapshotDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-backup-'),
  );
  const sqliteSnapshots = new Map<string, string>();
  try {
    for (const file of files) {
      if (!file.isSqlite) continue;
      const snapshotName = `${file.relativePath.replace(/[\\/]/g, '_')}-${randomUUID().slice(0, 8)}.db`;
      const snapshotPath = path.join(snapshotDir, snapshotName);
      await snapshotSqliteDatabase(file.absolutePath, snapshotPath);
      sqliteSnapshots.set(file.relativePath, snapshotPath);
    }

    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: now.toISOString(),
      hostname: os.hostname(),
      platform: process.platform,
      sourceRoot: sourceDir,
      entries: files.length,
      sqliteSnapshots: [...sqliteSnapshots.keys()].sort((left, right) =>
        left.localeCompare(right),
      ),
    };

    await writeZipArchive(archivePath, manifest, files, sqliteSnapshots);

    return {
      archivePath,
      manifest,
      entryCount: files.length,
      sqliteSnapshots: manifest.sqliteSnapshots,
    };
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

function openBackupZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, autoClose: false },
      (error, zipFile) => {
        if (error) return reject(error);
        if (!zipFile) {
          return reject(
            new Error(`Failed to open backup archive at ${archivePath}.`),
          );
        }
        resolve(zipFile);
      },
    );
  });
}

function readBackupManifestText(zipFile: yauzl.ZipFile): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let found = false;

    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    zipFile.on('error', fail);
    zipFile.on('end', () => {
      if (!found) {
        fail(
          new Error(
            `Archive is missing ${BACKUP_MANIFEST_FILE}; not a HybridClaw backup.`,
          ),
        );
      }
    });
    zipFile.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName !== BACKUP_MANIFEST_FILE) {
        zipFile.readEntry();
        return;
      }
      found = true;
      zipFile.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error ?? new Error('Failed to read backup manifest.'));
          return;
        }
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        stream.on('error', fail);
        stream.on('end', () => {
          try {
            zipFile.close();
          } catch {
            // best effort
          }
          finish(Buffer.concat(chunks).toString('utf-8'));
        });
      });
    });

    zipFile.readEntry();
  });
}

function parseBackupManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Backup manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Backup manifest is not a JSON object.');
  }
  const manifest = parsed as Partial<BackupManifest>;
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Unsupported backup format version: ${manifest.formatVersion}. Expected ${BACKUP_FORMAT_VERSION}.`,
    );
  }
  return manifest as BackupManifest;
}

export interface RestoreBackupOptions {
  archivePath: string;
  targetDir?: string;
  force?: boolean;
  confirm?: (details: {
    targetDir: string;
    existingEntries: number;
    manifest: BackupManifest;
  }) => Promise<boolean> | boolean;
}

export interface RestoreBackupResult {
  archivePath: string;
  targetDir: string;
  manifest: BackupManifest;
  replaced: boolean;
}

export async function restoreBackupArchive(
  options: RestoreBackupOptions,
): Promise<RestoreBackupResult> {
  const archivePath = path.resolve(options.archivePath);
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Backup archive not found: ${archivePath}`);
  }
  const targetDir = path.resolve(options.targetDir ?? DEFAULT_RUNTIME_HOME_DIR);

  const manifestZip = await openBackupZip(archivePath);
  const manifestText = await readBackupManifestText(manifestZip);
  const manifest = parseBackupManifest(manifestText);

  const targetExists = fs.existsSync(targetDir);
  const existingEntries = targetExists
    ? fs.readdirSync(targetDir).filter((name) => !name.startsWith('.tmp-'))
        .length
    : 0;

  const willOverwrite = targetExists && existingEntries > 0;
  if (willOverwrite && !options.force) {
    const confirmed = options.confirm
      ? await options.confirm({
          targetDir,
          existingEntries,
          manifest,
        })
      : false;
    if (!confirmed) {
      throw new Error(
        `HybridClaw runtime home at ${targetDir} already contains ${existingEntries} entr${existingEntries === 1 ? 'y' : 'ies'}. Re-run with --force or confirm the prompt to replace it.`,
      );
    }
  }

  const parentDir = path.dirname(targetDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const stagingDir = fs.mkdtempSync(
    path.join(parentDir, `${path.basename(targetDir)}.restore-`),
  );

  try {
    const extractionDir = path.join(stagingDir, 'extract');
    await safeExtractZip(archivePath, extractionDir);

    const extractedPayloadDir = path.join(extractionDir, BACKUP_PAYLOAD_ROOT);
    if (!fs.existsSync(extractedPayloadDir)) {
      throw new Error(
        `Backup archive is missing the ${BACKUP_PAYLOAD_ROOT}/ payload directory.`,
      );
    }
    for (const marker of BACKUP_MARKER_FILES) {
      const markerPath = resolveArchiveEntryDestination(extractionDir, marker);
      if (!fs.existsSync(markerPath)) {
        throw new Error(
          `Backup archive is missing required marker file ${marker}.`,
        );
      }
    }

    let backupOfExisting = '';
    if (targetExists) {
      backupOfExisting = `${targetDir}.pre-restore-${randomUUID().slice(0, 8)}`;
      fs.renameSync(targetDir, backupOfExisting);
    }
    try {
      fs.renameSync(extractedPayloadDir, targetDir);
    } catch (error) {
      if (backupOfExisting && fs.existsSync(backupOfExisting)) {
        fs.renameSync(backupOfExisting, targetDir);
      }
      throw error;
    }
    if (backupOfExisting) {
      fs.rmSync(backupOfExisting, { recursive: true, force: true });
    }

    return {
      archivePath,
      targetDir,
      manifest,
      replaced: willOverwrite,
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function parseRestoreArgs(args: string[]): {
  archivePath: string;
  force: boolean;
} {
  let archivePath = '';
  let force = false;
  for (const arg of args) {
    if (arg === '--force' || arg === '-f') {
      force = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown backup restore flag: ${arg}`);
    }
    if (archivePath) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    archivePath = arg;
  }
  if (!archivePath) {
    throw new Error(
      'Usage: `hybridclaw backup restore <archive.zip> [--force]`',
    );
  }
  return { archivePath, force };
}

function parseCreateArgs(args: string[]): { outputPath: string | null } {
  let outputPath: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] || '';
    if (arg === '--output' || arg === '-o') {
      const next = args[i + 1];
      if (!next) {
        throw new Error(
          'Missing value for `--output`. Use `hybridclaw backup --output <path>`.',
        );
      }
      outputPath = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--output=')) {
      outputPath = arg.slice('--output='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown backup flag: ${arg}`);
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }
  return { outputPath };
}

async function confirmRestoreInteractive(details: {
  targetDir: string;
  existingEntries: number;
  manifest: BackupManifest;
}): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log(`Target: ${details.targetDir}`);
    console.log(
      `Existing entries: ${details.existingEntries} (will be replaced).`,
    );
    console.log(
      `Archive created: ${details.manifest.createdAt} on ${details.manifest.hostname}`,
    );
    const answer = (
      await rl.question('Overwrite existing HybridClaw installation? [y/N] ')
    )
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function handleBackupCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  const help = await import('./help.js');
  if (help.isHelpRequest(normalized)) {
    help.printBackupUsage();
    return;
  }

  const sub = (normalized[0] || '').toLowerCase();
  if (sub === 'restore') {
    const { archivePath, force } = parseRestoreArgs(normalized.slice(1));
    const result = await restoreBackupArchive({
      archivePath,
      force,
      confirm: force ? undefined : confirmRestoreInteractive,
    });
    console.log(`Restored HybridClaw runtime home from ${result.archivePath}.`);
    console.log(`Target: ${result.targetDir}`);
    console.log(
      `Archive created: ${result.manifest.createdAt} on ${result.manifest.hostname} (${result.manifest.platform}).`,
    );
    if (result.replaced) {
      console.log('Previous runtime home was replaced.');
    }
    return;
  }

  const { outputPath } = parseCreateArgs(normalized);
  const result = await createBackupArchive({
    outputPath: outputPath ?? undefined,
  });
  console.log(`Created backup archive at ${result.archivePath}.`);
  console.log(
    `Entries: ${result.entryCount} (${result.sqliteSnapshots.length} SQLite snapshot${result.sqliteSnapshots.length === 1 ? '' : 's'}).`,
  );
  console.log(`Source: ${result.manifest.sourceRoot}`);
}
