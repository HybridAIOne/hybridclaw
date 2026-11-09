/**
 * Managed suite Python paths follow the environment created by setup.
 * Unlike executable discovery, this never falls back to host Python.
 */
import path from 'node:path';

export function managedPythonExecutable(installDir: string): string {
  return process.platform === 'win32'
    ? path.join(installDir, '.venv', 'Scripts', 'python.exe')
    : path.join(installDir, '.venv', 'bin', 'python');
}
