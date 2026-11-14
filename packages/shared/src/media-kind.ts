/**
 * Media kind: whether an attachment is an image or audio, from its MIME type
 * first and its filename extension when the type is missing.
 *
 * The gateway's media prompt context and the agent's native vision and audio
 * parts classify the same item the same way. This decides the kind only; what
 * a provider accepts natively is decided by the agent's provider code.
 */

export const IMAGE_FILE_EXTENSION_RE =
  /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|tiff?)$/i;

export const AUDIO_FILE_EXTENSION_RE =
  /\.(aac|aif|aiff|alac|flac|m4a|mp3|mp4|mpeg|mpga|oga|ogg|opus|wav|webm|wma)$/i;

interface MediaKindInput {
  mimeType?: string | null;
  filename?: string | null;
}

export function normalizeMimeType(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().split(';')[0]?.trim();
  return normalized || null;
}

export function isImageMediaItem(item: MediaKindInput): boolean {
  if (normalizeMimeType(item.mimeType)?.startsWith('image/')) return true;
  return IMAGE_FILE_EXTENSION_RE.test(item.filename || '');
}

export function isAudioMediaItem(item: MediaKindInput): boolean {
  if (normalizeMimeType(item.mimeType)?.startsWith('audio/')) return true;
  return AUDIO_FILE_EXTENSION_RE.test(item.filename || '');
}
