/**
 * Durable visual snapshots contain selected PDF pages or one normalized image, addressed by their bytes.
 * This is replay storage, not a file-access grant: callers authorize source reads;
 * loading accepts no paths and rejects symlinks, oversized or changed snapshots.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
// Agent decision, 2026-09-29: four pages per preview/read bounds visual context.
export const PDF_READ_MAX_PAGES = 4;

// Agent decision, 2026-09-29: bound each replay payload to 20 MiB; larger
// selections remain text-only and can be retried one page at a time.
export const VISUAL_SNAPSHOT_MAX_BYTES = 20 * 1024 * 1024;
const DIRECTORY = '.visual-snapshots';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function validateVisualAttachments(value) {
  if (!Array.isArray(value) || value.length > PDF_READ_MAX_PAGES)
    throw new Error('Invalid visual attachments');
  return value.map((item) => {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.id) ||
      !Array.isArray(item.pages) ||
      item.pages.length > PDF_READ_MAX_PAGES ||
      item.pages.some(
        (page, i) =>
          !Number.isSafeInteger(page) ||
          page < 1 ||
          (i > 0 && page <= item.pages[i - 1]),
      )
    )
      throw new Error('Invalid visual attachment reference');
    return { id: item.id, pages: [...item.pages] };
  });
}

async function snapshotDirectory(workspaceRoot, create) {
  const root = await fs.realpath(workspaceRoot);
  const directory = path.join(root, DIRECTORY);
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.realpath(directory)) !== directory)
    throw new Error('Visual snapshot directory must not be a symlink');
  return directory;
}

export async function saveVisualSnapshot(workspaceRoot, snapshot, pages) {
  const bytes = Buffer.from(JSON.stringify({ ...snapshot, pages }));
  if (bytes.length > VISUAL_SNAPSHOT_MAX_BYTES)
    throw new Error(
      'Visual payload exceeds 20 MiB; reduce the image or page selection',
    );
  const attachment = validateVisualAttachments([
    { id: digest(bytes), pages },
  ])[0];
  const directory = await snapshotDirectory(workspaceRoot, true);
  const staging = await fs.mkdtemp(path.join(directory, '.pending-'));
  try {
    const staged = path.join(staging, 'snapshot');
    await fs.writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(staged, path.join(directory, `${attachment.id}.json`));
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return attachment;
}

export async function loadVisualSnapshot(workspaceRoot, attachment) {
  const [ref] = validateVisualAttachments([attachment]);
  const directory = await snapshotDirectory(workspaceRoot, false);
  const filename = path.join(directory, `${ref.id}.json`);
  if ((await fs.realpath(filename)) !== filename)
    throw new Error('Visual snapshot must not be a symlink');
  const file = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > VISUAL_SNAPSHOT_MAX_BYTES)
      throw new Error('Invalid Visual snapshot size');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.length > VISUAL_SNAPSHOT_MAX_BYTES || digest(bytes) !== ref.id)
      throw new Error('Visual snapshot integrity check failed');
    const snapshot = JSON.parse(bytes.toString());
    if (
      JSON.stringify(snapshot.pages) !== JSON.stringify(ref.pages) ||
      typeof snapshot.pdf !== 'string' ||
      !Array.isArray(snapshot.images) ||
      (ref.pages.length === 0
        ? snapshot.pdf !== '' || snapshot.images.length !== 1
        : snapshot.images.length !== 0 &&
          snapshot.images.length !== ref.pages.length) ||
      snapshot.images.some((image) => typeof image !== 'string')
    )
      throw new Error('Invalid Visual snapshot content');
    return snapshot;
  } finally {
    await file.close();
  }
}
