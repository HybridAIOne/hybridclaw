import { spawn } from 'node:child_process';
import { expect, vi } from 'vitest';

/** A zombie has stopped executing even if the host init has not reaped it yet. */
export async function expectProcessStopped(pid: number): Promise<void> {
  await vi.waitFor(async () => {
    const status = await new Promise<string>((resolve, reject) => {
      const ps = spawn('ps', ['-p', String(pid), '-o', 'stat=']);
      let stdout = '';
      ps.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      ps.once('error', reject);
      ps.once('close', () => resolve(stdout.trim()));
    });
    expect(status === '' || status.startsWith('Z')).toBe(true);
  });
}
