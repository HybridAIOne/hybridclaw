import fs from 'node:fs';
import path from 'node:path';

export interface RuntimeRootInput {
  currentFile: string;
  packaged: boolean;
  resourcesPath: string;
}

export interface GatewayNodeExecutableInput {
  env: NodeJS.ProcessEnv;
  packaged: boolean;
  processExecPath: string;
  runtimeRoot: string;
}

export function resolveRuntimeRoot(params: RuntimeRootInput): string {
  if (params.packaged) {
    return path.join(params.resourcesPath, 'hybridclaw-runtime');
  }
  const root = path.resolve(path.dirname(params.currentFile), '..', '..');
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    throw new Error(
      `HybridClaw runtime root resolved to ${root} but no package.json was found. ` +
      `Run the desktop app from the repository root via \`npm run desktop\`.`,
    );
  }
  return root;
}

export function resolveGatewayEntry(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'dist', 'cli.js');
}

export function resolveGatewayNodeExecutable(
  params: GatewayNodeExecutableInput,
): string {
  if (params.packaged) {
    return path.join(params.runtimeRoot, 'bin', 'node');
  }

  const injectedNodePath = params.env.HYBRIDCLAW_DESKTOP_NODE_EXECUTABLE?.trim();
  if (injectedNodePath) {
    return path.resolve(injectedNodePath);
  }

  const npmNodeExecPath = params.env.npm_node_execpath?.trim();
  if (npmNodeExecPath) {
    return path.resolve(npmNodeExecPath);
  }

  return params.processExecPath;
}
