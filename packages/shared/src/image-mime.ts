/**
 * Raster signatures identify the MIME type of bytes already authorized for reading.
 * Unlike filename or transport hints, recognized bytes determine their own type.
 * This does not decode images, validate complete files, or authorize pixel delivery.
 */
export function sniffImageMimeType(bytes: Uint8Array): string | null {
  const header = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, 12),
  );
  if (header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    return 'image/png';
  if (header.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')))
    return 'image/jpeg';
  if (/^GIF8[79]a$/.test(header.subarray(0, 6).toString())) return 'image/gif';
  if (
    header.subarray(0, 4).toString() === 'RIFF' &&
    header.subarray(8, 12).toString() === 'WEBP'
  )
    return 'image/webp';
  return null;
}
