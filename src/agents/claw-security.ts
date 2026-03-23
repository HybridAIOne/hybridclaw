import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';

export const CLAW_ARCHIVE_MAX_ENTRIES = 10_000;
export const CLAW_ARCHIVE_MAX_COMPRESSED_BYTES = 100 * 1024 * 1024;
export const CLAW_ARCHIVE_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
export const CLAW_ARCHIVE_MAX_TEXT_ENTRY_BYTES = 1024 * 1024;

export interface ScannedClawArchiveEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  isDirectory: boolean;
  mode: number | null;
}

export interface ScanClawArchiveResult {
  entries: ScannedClawArchiveEntry[];
  entryNames: string[];
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  textEntries: Record<string, string>;
}

export interface SafeExtractZipResult {
  entryCount: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
}

function openZipFile(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      {
        lazyEntries: true,
        autoClose: false,
      },
      (error, zipFile) => {
        if (error) {
          reject(error);
          return;
        }
        if (!zipFile) {
          reject(new Error(`Failed to open ZIP archive at ${archivePath}.`));
          return;
        }
        resolve(zipFile);
      },
    );
  });
}

function openZipEntryReadStream(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      if (!stream) {
        reject(
          new Error(
            `Failed to read ZIP entry "${entry.fileName || '<unknown>'}".`,
          ),
        );
        return;
      }
      resolve(stream);
    });
  });
}

function getZipEntryMode(entry: yauzl.Entry): number | null {
  const mode = entry.externalFileAttributes >>> 16;
  return mode > 0 ? mode : null;
}

function isZipEntrySymlink(entry: yauzl.Entry): boolean {
  const mode = getZipEntryMode(entry);
  return mode != null && (mode & 0o170000) === 0o120000;
}

function closeZipFile(zipFile: yauzl.ZipFile): void {
  try {
    zipFile.close();
  } catch {
    // best effort
  }
}

function isEncryptedEntry(entry: yauzl.Entry): boolean {
  return (entry.generalPurposeBitFlag & 0x1) !== 0;
}

function validateArchiveEntryName(entryName: string): string {
  const normalized = String(entryName || '').replace(/\\/g, '/');
  if (!normalized) {
    throw new Error('ZIP archive contains an empty entry path.');
  }
  if (normalized.includes('\0')) {
    throw new Error(`ZIP entry "${normalized}" contains a null byte.`);
  }
  if (normalized.startsWith('/')) {
    throw new Error(`ZIP entry "${normalized}" uses an absolute path.`);
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`ZIP entry "${normalized}" uses an absolute drive path.`);
  }

  const trimmed = normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
  if (!trimmed) {
    throw new Error('ZIP archive contains an invalid root directory entry.');
  }

  for (const segment of trimmed.split('/')) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(
        `ZIP entry "${normalized}" escapes the output directory.`,
      );
    }
  }
  return normalized;
}

export function resolveArchiveEntryDestination(
  outputDir: string,
  entryName: string,
): string {
  const normalized = validateArchiveEntryName(entryName);
  const trimmed = normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
  const destination = path.resolve(
    outputDir,
    ...trimmed.split('/').filter(Boolean),
  );
  const resolvedRoot = path.resolve(outputDir);
  if (
    destination !== resolvedRoot &&
    !destination.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`ZIP entry "${normalized}" resolves outside ${outputDir}.`);
  }
  return destination;
}

async function readZipEntryText(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  maxBytes: number,
): Promise<string> {
  const stream = await openZipEntryReadStream(zipFile, entry);
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  return await new Promise<string>((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        stream.destroy(
          new Error(
            `ZIP entry "${entry.fileName}" exceeded the ${maxBytes} byte text read limit.`,
          ),
        );
        return;
      }
      chunks.push(buffer);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
  });
}

export async function scanClawArchive(
  archivePath: string,
  options: {
    textEntries?: string[];
    maxTextEntryBytes?: number;
  } = {},
): Promise<ScanClawArchiveResult> {
  const zipFile = await openZipFile(archivePath);
  const wantedTextEntries = new Set(
    (options.textEntries ?? []).map((entry) => validateArchiveEntryName(entry)),
  );

  return await new Promise<ScanClawArchiveResult>((resolve, reject) => {
    const entries: ScannedClawArchiveEntry[] = [];
    const textEntries: Record<string, string> = {};
    let totalCompressedBytes = 0;
    let totalUncompressedBytes = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      closeZipFile(zipFile);
      resolve({
        entries,
        entryNames: entries.map((entry) => entry.name),
        totalCompressedBytes,
        totalUncompressedBytes,
        textEntries,
      });
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      closeZipFile(zipFile);
      reject(error);
    };

    zipFile.on('error', fail);
    zipFile.on('end', finish);
    zipFile.on('entry', (entry) => {
      try {
        const name = validateArchiveEntryName(entry.fileName);
        if (isEncryptedEntry(entry)) {
          throw new Error(`ZIP entry "${name}" is encrypted and unsupported.`);
        }
        if (isZipEntrySymlink(entry)) {
          throw new Error(
            `ZIP entry "${name}" is a symlink and is not allowed.`,
          );
        }

        totalCompressedBytes += entry.compressedSize;
        totalUncompressedBytes += entry.uncompressedSize;
        if (entries.length + 1 > CLAW_ARCHIVE_MAX_ENTRIES) {
          throw new Error(
            `ZIP archive exceeds the ${CLAW_ARCHIVE_MAX_ENTRIES} entry limit.`,
          );
        }
        if (totalCompressedBytes > CLAW_ARCHIVE_MAX_COMPRESSED_BYTES) {
          throw new Error(
            `ZIP archive exceeds the ${CLAW_ARCHIVE_MAX_COMPRESSED_BYTES} byte compressed limit.`,
          );
        }
        if (totalUncompressedBytes > CLAW_ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
          throw new Error(
            `ZIP archive exceeds the ${CLAW_ARCHIVE_MAX_UNCOMPRESSED_BYTES} byte uncompressed limit.`,
          );
        }

        entries.push({
          name,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          isDirectory: name.endsWith('/'),
          mode: getZipEntryMode(entry),
        });

        if (!wantedTextEntries.has(name)) {
          zipFile.readEntry();
          return;
        }

        void readZipEntryText(
          zipFile,
          entry,
          options.maxTextEntryBytes ?? CLAW_ARCHIVE_MAX_TEXT_ENTRY_BYTES,
        )
          .then((text) => {
            textEntries[name] = text;
            zipFile.readEntry();
          })
          .catch(fail);
      } catch (error) {
        fail(error);
      }
    });

    zipFile.readEntry();
  });
}

async function extractZipEntry(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  outputDir: string,
): Promise<void> {
  const destination = resolveArchiveEntryDestination(outputDir, entry.fileName);
  if (entry.fileName.endsWith('/')) {
    fs.mkdirSync(destination, { recursive: true });
    return;
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.tmp-${randomUUID()}`;
  const readStream = await openZipEntryReadStream(zipFile, entry);
  let bytesRead = 0;

  readStream.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += buffer.length;
    if (bytesRead > entry.uncompressedSize) {
      readStream.destroy(
        new Error(
          `ZIP entry "${entry.fileName}" expanded beyond its declared size.`,
        ),
      );
    }
  });

  try {
    await pipeline(readStream, fs.createWriteStream(tempPath, { mode: 0o644 }));
    if (bytesRead !== entry.uncompressedSize) {
      throw new Error(
        `ZIP entry "${entry.fileName}" size mismatch (${bytesRead} != ${entry.uncompressedSize}).`,
      );
    }
    fs.chmodSync(tempPath, 0o644);
    fs.renameSync(tempPath, destination);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

export async function safeExtractZip(
  archivePath: string,
  outputDir: string,
): Promise<SafeExtractZipResult> {
  const scan = await scanClawArchive(archivePath);
  fs.mkdirSync(outputDir, { recursive: true });

  const zipFile = await openZipFile(archivePath);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      zipFile.on('error', fail);
      zipFile.on('end', finish);
      zipFile.on('entry', (entry) => {
        try {
          validateArchiveEntryName(entry.fileName);
          if (isEncryptedEntry(entry)) {
            throw new Error(
              `ZIP entry "${entry.fileName}" is encrypted and unsupported.`,
            );
          }
          if (isZipEntrySymlink(entry)) {
            throw new Error(
              `ZIP entry "${entry.fileName}" is a symlink and is not allowed.`,
            );
          }
          void extractZipEntry(zipFile, entry, outputDir)
            .then(() => {
              zipFile.readEntry();
            })
            .catch(fail);
        } catch (error) {
          fail(error);
        }
      });

      zipFile.readEntry();
    });
  } catch (error) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    closeZipFile(zipFile);
    throw error;
  }

  closeZipFile(zipFile);
  return {
    entryCount: scan.entries.length,
    totalCompressedBytes: scan.totalCompressedBytes,
    totalUncompressedBytes: scan.totalUncompressedBytes,
  };
}
