import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads the agent tool libraries out of the runtime tools manifests
 * (container/tools) so the Dockerfile parity test and the image e2e suites
 * assert against the one set both images install.
 */

export const RUNTIME_TOOLS_DIR = 'container/tools';
export const RUNTIME_TOOLS_TARGET = '/opt/hybridclaw-tools';

export interface RuntimeToolInventory {
  /** Direct pip pins from requirements.in: package name -> version */
  pip: Map<string, string>;
  /** Direct npm dependencies from package.json: name -> spec */
  npm: Map<string, string>;
}

/** Python import name where it differs from the pip distribution name. */
const PYTHON_IMPORT_NAMES: Record<string, string> = {
  pillow: 'PIL',
};

export function pythonImportName(pipPackage: string): string {
  return PYTHON_IMPORT_NAMES[pipPackage] ?? pipPackage;
}

export function readRuntimeToolInventory(
  repoRoot: string = path.resolve(import.meta.dirname, '..', '..'),
): RuntimeToolInventory {
  const dir = path.join(repoRoot, RUNTIME_TOOLS_DIR);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'),
  ) as { dependencies?: Record<string, string> };
  const npm = new Map(Object.entries(manifest.dependencies ?? {}));

  const pip = new Map<string, string>();
  const requirements = fs.readFileSync(
    path.join(dir, 'requirements.in'),
    'utf-8',
  );
  for (const rawLine of requirements.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [name, version] = line.split('==');
    if (!name || !version) throw new Error(`unpinned pip package: ${line}`);
    pip.set(name, version);
  }
  return { pip, npm };
}
