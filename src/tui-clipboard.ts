import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeMimeType } from './media/mime-utils.js';

const CLIPBOARD_COMMAND_TIMEOUT_MS = 8_000;
const CLIPBOARD_COMMAND_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_WSL_UNC_PATH_RE = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.+)$/i;
const LINUX_TEXT_URI_MIME = 'text/uri-list';
const LINUX_TEXT_PLAIN_MIME_CANDIDATES = [
  'text/plain;charset=utf-8',
  'text/plain;charset=UTF-8',
  'text/plain',
  'UTF8_STRING',
  'STRING',
  'TEXT',
] as const;
const LINUX_IMAGE_MIME_CANDIDATES = [
  { mimeType: 'image/png', extension: 'png' },
  { mimeType: 'image/jpeg', extension: 'jpg' },
  { mimeType: 'image/gif', extension: 'gif' },
  { mimeType: 'image/webp', extension: 'webp' },
] as const;

const DARWIN_CLIPBOARD_SCRIPT = String.raw`
import AppKit
import Foundation

struct Payload: Codable {
  let filePaths: [String]
  let imageBase64: String?
  let mimeType: String?
  let filename: String?
}

func emit(_ payload: Payload) {
  let encoder = JSONEncoder()
  guard let data = try? encoder.encode(payload) else { exit(1) }
  FileHandle.standardOutput.write(data)
}

let pasteboard = NSPasteboard.general
var filePaths: [String] = []

if let urls = pasteboard.readObjects(
  forClasses: [NSURL.self],
  options: [.urlReadingFileURLsOnly: true]
) as? [URL] {
  filePaths = urls.map(\.path)
}

if filePaths.isEmpty,
   let legacyPaths = pasteboard.propertyList(
    forType: NSPasteboard.PasteboardType("NSFilenamesPboardType")
   ) as? [String] {
  filePaths = legacyPaths
}

if !filePaths.isEmpty {
  emit(Payload(filePaths: filePaths, imageBase64: nil, mimeType: nil, filename: nil))
  exit(0)
}

if let pngData = pasteboard.data(forType: .png) {
  emit(Payload(
    filePaths: [],
    imageBase64: pngData.base64EncodedString(),
    mimeType: "image/png",
    filename: "clipboard.png"
  ))
  exit(0)
}

if let tiffData = pasteboard.data(forType: .tiff),
   let bitmap = NSBitmapImageRep(data: tiffData),
   let pngData = bitmap.representation(using: .png, properties: [:]) {
  emit(Payload(
    filePaths: [],
    imageBase64: pngData.base64EncodedString(),
    mimeType: "image/png",
    filename: "clipboard.png"
  ))
  exit(0)
}

emit(Payload(filePaths: [], imageBase64: nil, mimeType: nil, filename: nil))
`;

const WINDOWS_CLIPBOARD_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$fileList = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($fileList -and $fileList.Count -gt 0) {
  $payload = [ordered]@{
    filePaths = @()
    imageBase64 = $null
    mimeType = $null
    filename = $null
  }
  foreach ($filePath in $fileList) {
    $payload.filePaths += [string]$filePath
  }
  $payload | ConvertTo-Json -Compress -Depth 4
  exit 0
}

if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $image = [System.Windows.Forms.Clipboard]::GetImage()
  if ($image -ne $null) {
    $stream = New-Object System.IO.MemoryStream
    $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    [ordered]@{
      filePaths = @()
      imageBase64 = [Convert]::ToBase64String($stream.ToArray())
      mimeType = 'image/png'
      filename = 'clipboard.png'
    } | ConvertTo-Json -Compress -Depth 4
    exit 0
  }
}

[ordered]@{
  filePaths = @()
  imageBase64 = $null
  mimeType = $null
  filename = $null
} | ConvertTo-Json -Compress -Depth 4
`;

interface ClipboardPayload {
  filePaths: string[];
  imageBase64: string | null;
  mimeType: string | null;
  filename: string | null;
}

export interface TuiClipboardUploadCandidate {
  filename: string;
  body: Buffer;
  mimeType: string | null;
}

let cachedWslDetection: boolean | null = null;

function execFileWithEncoding<TEncoding extends 'utf8' | 'buffer'>(
  command: string,
  args: string[],
  encoding: TEncoding,
): Promise<{
  stdout: TEncoding extends 'buffer' ? Buffer : string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding,
        maxBuffer: CLIPBOARD_COMMAND_MAX_BUFFER_BYTES,
        timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              String(stderr || '').trim() ||
                error.message ||
                'clipboard command failed',
            ),
          );
          return;
        }
        resolve({
          stdout:
            encoding === 'buffer'
              ? Buffer.isBuffer(stdout)
                ? stdout
                : Buffer.from(stdout || '', 'utf8')
              : String(stdout || ''),
          stderr: String(stderr || ''),
        } as {
          stdout: TEncoding extends 'buffer' ? Buffer : string;
          stderr: string;
        });
      },
    );
  });
}

function execFileUtf8(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileWithEncoding(command, args, 'utf8');
}

function execFileBuffer(
  command: string,
  args: string[],
): Promise<{ stdout: Buffer; stderr: string }> {
  return execFileWithEncoding(command, args, 'buffer');
}

export function isProbablyWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (cachedWslDetection !== null) return cachedWslDetection;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    cachedWslDetection = true;
    return true;
  }
  try {
    const version = fs.readFileSync('/proc/version', 'utf8');
    cachedWslDetection = /microsoft/i.test(version);
  } catch {
    cachedWslDetection = false;
  }
  return cachedWslDetection;
}

export function parseClipboardPayload(
  raw: string,
  options?: {
    mapFilePath?: (value: string) => string | null;
  },
): ClipboardPayload | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;

  let parsed: {
    filePaths?: unknown;
    imageBase64?: unknown;
    mimeType?: unknown;
    filename?: unknown;
  };
  try {
    parsed = JSON.parse(trimmed) as {
      filePaths?: unknown;
      imageBase64?: unknown;
      mimeType?: unknown;
      filename?: unknown;
    };
  } catch {
    return null;
  }

  const mapFilePath = options?.mapFilePath;
  const filePaths = Array.isArray(parsed.filePaths)
    ? parsed.filePaths
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => mapFilePath?.(value) ?? value)
        .filter(
          (value): value is string => typeof value === 'string' && !!value,
        )
    : [];
  const imageBase64 =
    typeof parsed.imageBase64 === 'string' && parsed.imageBase64.trim()
      ? parsed.imageBase64.trim()
      : null;
  const mimeType = normalizeMimeType(
    typeof parsed.mimeType === 'string' ? parsed.mimeType : null,
  );
  const filename =
    typeof parsed.filename === 'string' && parsed.filename.trim()
      ? parsed.filename.trim()
      : null;

  if (filePaths.length === 0 && !imageBase64) {
    return null;
  }

  return {
    filePaths: Array.from(new Set(filePaths)),
    imageBase64,
    mimeType,
    filename,
  };
}

async function readDarwinClipboardPayload(): Promise<ClipboardPayload | null> {
  const { stdout } = await execFileUtf8('/usr/bin/swift', [
    '-e',
    DARWIN_CLIPBOARD_SCRIPT,
  ]);
  return parseClipboardPayload(stdout);
}

export function convertWindowsPathToWsl(filePath: string): string | null {
  const normalized = String(filePath || '').trim();
  if (!normalized) return null;

  const uncMatch = normalized.match(WINDOWS_WSL_UNC_PATH_RE);
  if (uncMatch?.[1]) {
    return `/${uncMatch[1].replace(/\\/g, '/')}`;
  }

  const driveMatch = normalized.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!driveMatch) return null;

  const [, drive, rest] = driveMatch;
  const suffix = rest.replace(/\\/g, '/');
  return `/mnt/${drive.toLowerCase()}/${suffix}`;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseClipboardUriList(raw: string): string[] {
  const paths: string[] = [];
  for (const line of String(raw || '')
    .replace(/\r\n/g, '\n')
    .split('\n')) {
    const trimmed = stripWrappingQuotes(line);
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('file://')) {
      try {
        paths.push(fileURLToPath(trimmed));
      } catch {
        continue;
      }
      continue;
    }
    if (path.isAbsolute(trimmed) || WINDOWS_ABSOLUTE_PATH_RE.test(trimmed)) {
      paths.push(trimmed);
    }
  }
  return Array.from(new Set(paths));
}

async function readWindowsClipboardPayload(options?: {
  mapFilePath?: (value: string) => string | null;
}): Promise<ClipboardPayload | null> {
  for (const command of ['powershell.exe', 'pwsh', 'powershell']) {
    try {
      const { stdout } = await execFileUtf8(command, [
        '-NoProfile',
        '-NonInteractive',
        '-Sta',
        '-Command',
        WINDOWS_CLIPBOARD_SCRIPT,
      ]);
      return parseClipboardPayload(stdout, options);
    } catch {}
  }
  return null;
}

async function readFileClipboardCandidate(
  filePath: string,
): Promise<TuiClipboardUploadCandidate | null> {
  const resolved = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const body = await fs.promises.readFile(resolved);
  return {
    filename: path.basename(resolved) || 'upload',
    body,
    mimeType: null,
  };
}

async function maybeReadClipboardText(
  command: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFileUtf8(command, args);
    return stdout;
  } catch {
    return null;
  }
}

async function maybeReadClipboardBytes(
  command: string,
  args: string[],
): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileBuffer(command, args);
    return stdout.length > 0 ? stdout : null;
  } catch {
    return null;
  }
}

interface LinuxClipboardBackendReader {
  readText: (mimeType: string) => Promise<string | null>;
  readBytes: (mimeType: string) => Promise<Buffer | null>;
}

async function readLinuxBackendClipboardPayload(
  reader: LinuxClipboardBackendReader,
): Promise<ClipboardPayload | null> {
  const uriList = await reader.readText(LINUX_TEXT_URI_MIME);
  const filePaths = parseClipboardUriList(uriList || '');
  if (filePaths.length > 0) {
    return {
      filePaths,
      imageBase64: null,
      mimeType: null,
      filename: null,
    };
  }

  for (const mimeType of LINUX_TEXT_PLAIN_MIME_CANDIDATES) {
    const rawText = await reader.readText(mimeType);
    const plainPaths = parseClipboardUriList(rawText || '');
    if (plainPaths.length > 0) {
      return {
        filePaths: plainPaths,
        imageBase64: null,
        mimeType: null,
        filename: null,
      };
    }
  }

  for (const candidate of LINUX_IMAGE_MIME_CANDIDATES) {
    const body = await reader.readBytes(candidate.mimeType);
    if (!body) continue;
    return {
      filePaths: [],
      imageBase64: body.toString('base64'),
      mimeType: candidate.mimeType,
      filename: `clipboard.${candidate.extension}`,
    };
  }

  return null;
}

async function readWaylandClipboardPayload(): Promise<ClipboardPayload | null> {
  return readLinuxBackendClipboardPayload({
    readText: (mimeType) =>
      maybeReadClipboardText('wl-paste', ['--type', mimeType]),
    readBytes: (mimeType) =>
      maybeReadClipboardBytes('wl-paste', ['--type', mimeType]),
  });
}

async function readXclipClipboardPayload(): Promise<ClipboardPayload | null> {
  return readLinuxBackendClipboardPayload({
    readText: (mimeType) =>
      maybeReadClipboardText('xclip', [
        '-selection',
        'clipboard',
        '-t',
        mimeType,
        '-o',
      ]),
    readBytes: (mimeType) =>
      maybeReadClipboardBytes('xclip', [
        '-selection',
        'clipboard',
        '-t',
        mimeType,
        '-o',
      ]),
  });
}

async function readLinuxClipboardPayload(): Promise<ClipboardPayload | null> {
  const readers: Array<() => Promise<ClipboardPayload | null>> = process.env
    .WAYLAND_DISPLAY
    ? [readWaylandClipboardPayload, readXclipClipboardPayload]
    : process.env.DISPLAY
      ? [readXclipClipboardPayload, readWaylandClipboardPayload]
      : [readWaylandClipboardPayload, readXclipClipboardPayload];

  for (const readPayload of readers) {
    const payload = await readPayload();
    if (payload) return payload;
  }

  return null;
}

async function payloadToUploadCandidates(
  payload: ClipboardPayload | null,
): Promise<TuiClipboardUploadCandidate[]> {
  if (!payload) return [];

  if (payload.filePaths.length > 0) {
    const candidates = await Promise.all(
      payload.filePaths.map((filePath) => readFileClipboardCandidate(filePath)),
    );
    const readable = candidates.filter(
      (candidate): candidate is TuiClipboardUploadCandidate =>
        candidate !== null,
    );
    if (readable.length > 0) {
      return readable;
    }
  }

  if (!payload.imageBase64) return [];
  const body = Buffer.from(payload.imageBase64, 'base64');
  if (body.length === 0) return [];

  return [
    {
      filename: payload.filename || `clipboard-${new Date().toISOString()}.png`,
      body,
      mimeType: payload.mimeType || 'image/png',
    },
  ];
}

export async function loadTuiClipboardUploadCandidates(): Promise<
  TuiClipboardUploadCandidate[]
> {
  if (process.platform === 'darwin') {
    return payloadToUploadCandidates(await readDarwinClipboardPayload());
  }

  if (process.platform === 'win32') {
    return payloadToUploadCandidates(await readWindowsClipboardPayload());
  }

  if (process.platform === 'linux') {
    if (isProbablyWsl()) {
      const windowsPayload = await readWindowsClipboardPayload({
        mapFilePath: (filePath) =>
          convertWindowsPathToWsl(filePath) || filePath,
      });
      const windowsCandidates = await payloadToUploadCandidates(windowsPayload);
      if (windowsCandidates.length > 0) {
        return windowsCandidates;
      }
    }
    return payloadToUploadCandidates(await readLinuxClipboardPayload());
  }

  return [];
}
