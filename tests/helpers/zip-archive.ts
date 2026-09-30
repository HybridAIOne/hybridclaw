import fs from 'node:fs';
import * as yazl from 'yazl';

/** Writes a ZIP with exactly these entries, e.g. a hand-built `.claw`. */
export async function writeZipArchive(
  archivePath: string,
  entries: Array<{ name: string; content: string | Buffer; mode?: number }>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zipFile = new yazl.ZipFile();
    const output = fs.createWriteStream(archivePath);
    output.on('close', resolve);
    output.on('error', reject);
    zipFile.outputStream.on('error', reject).pipe(output);
    for (const entry of entries) {
      zipFile.addBuffer(
        Buffer.isBuffer(entry.content)
          ? entry.content
          : Buffer.from(entry.content, 'utf-8'),
        entry.name,
        entry.mode ? { mode: entry.mode } : undefined,
      );
    }
    zipFile.end();
  });
}
