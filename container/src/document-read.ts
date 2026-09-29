/**
 * Authorized read paths dispatch documents before text decoding.
 * Images become durable visual content; binary files never masquerade as text.
 * Path/approval decisions remain with read-path and tools, not this decoder.
 */
import fs from 'node:fs/promises';
import { saveVisualSnapshot } from '../shared/visual-snapshots.js';
import { readPdfFile } from './pdf-read.js';
import { WORKSPACE_ROOT } from './runtime-paths.js';
import type { ToolRunResult } from './types.js';

export async function readDocumentFile(
  filePath: string,
  args: Record<string, unknown>,
): Promise<ToolRunResult | null> {
  const handle = await fs.open(filePath, 'r');
  let header: Buffer;
  let size: number;
  try {
    size = (await handle.stat()).size;
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    header = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (
    /\.pdf$/i.test(String(args.path)) ||
    header.subarray(0, 5).toString() === '%PDF-'
  )
    return readPdfFile(filePath, args);
  // These signatures define the raster formats accepted by this read decoder.
  const raster =
    header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    header.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ||
    /^GIF8[79]a/.test(header.subarray(0, 6).toString()) ||
    (header.subarray(0, 4).toString() === 'RIFF' &&
      header.subarray(8, 12).toString() === 'WEBP');
  if (!raster) {
    if (
      header.includes(0) ||
      /\.(png|jpe?g|gif|webp)$/i.test(String(args.path))
    )
      throw new Error(
        'Unsupported or invalid binary file; read accepts text, PDF, PNG, JPEG, GIF and WebP.',
      );
    return null;
  }
  if (
    ['offset', 'limit', 'pages', 'query', 'render'].some(
      (key) => args[key] !== undefined,
    )
  )
    throw new Error(
      'Image reads accept path only; PDF pages/query and text offset/limit do not apply.',
    );
  // Agent decision, 2026-09-29: 10 MiB input and 1600px output bound image reads.
  if (size > 10 * 1024 * 1024)
    throw new Error('Image exceeds the 10 MiB read limit');
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  const bytes = await fs.readFile(filePath);
  if (bytes.length > 10 * 1024 * 1024)
    throw new Error('Image exceeds the 10 MiB read limit');
  const image = await loadImage(bytes);
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
  const canvas = createCanvas(
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale)),
  );
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  const ref = await saveVisualSnapshot(
    WORKSPACE_ROOT,
    {
      pdf: '',
      images: [(await canvas.encode('png')).toString('base64')],
    },
    [],
  );
  return {
    isError: false,
    visualAttachments: [ref],
    output: JSON.stringify({
      format: 'image',
      width: image.width,
      height: image.height,
      deliveredWidth: canvas.width,
      deliveredHeight: canvas.height,
      visualDelivery:
        'Image queued for direct model delivery; dispatch reports availability. No separate vision tool or temporary-file cleanup is needed.',
      ...(header.subarray(0, 3).toString() === 'GIF'
        ? { coverage: 'First frame only' }
        : {}),
    }),
  };
}
