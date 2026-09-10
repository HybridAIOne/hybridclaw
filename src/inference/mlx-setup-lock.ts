/**
 * One installer may update a Mac's model profile at a time.
 * This lock is separate from inference admission and never terminates another
 * process; a live or ambiguous owner requires the competing setup to stop.
 */
import fs from 'node:fs';
import path from 'node:path';

export function claimMlxSetup(home: string): () => void {
  const file = path.join(home, 'setup.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = fs.openSync(
        file,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      fs.writeFileSync(descriptor, String(process.pid));
      const owned = fs.fstatSync(descriptor);
      fs.closeSync(descriptor);
      return () => {
        try {
          if (fs.lstatSync(file).ino === owned.ino) fs.unlinkSync(file);
        } catch {
          /* Already removed. */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 32)
        throw new Error('Invalid local setup lock.');
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error('Invalid local setup lock.');
      let running = true;
      try {
        process.kill(pid, 0);
      } catch (probeError) {
        running = (probeError as NodeJS.ErrnoException).code !== 'ESRCH';
      }
      if (running)
        throw new Error(
          'Another local model setup is running. Wait for it to finish.',
        );
      if (fs.lstatSync(file).ino === stat.ino) fs.unlinkSync(file);
    }
  }
  throw new Error('Could not acquire local model setup lock.');
}
