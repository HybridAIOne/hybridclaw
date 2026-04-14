import path from 'node:path';

export interface RuntimeRootInput {
  currentFile: string;
  packaged: boolean;
  resourcesPath: string;
}

export function resolveRuntimeRoot(params: RuntimeRootInput): string {
  if (params.packaged) {
    return path.join(params.resourcesPath, 'hybridclaw-runtime');
  }
  return path.resolve(path.dirname(params.currentFile), '..', '..');
}

export function resolveGatewayEntry(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'dist', 'cli.js');
}
