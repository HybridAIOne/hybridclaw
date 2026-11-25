import fs from 'node:fs';
import path from 'node:path';
import { hostWorkspaceStateRoot } from '../../src/infra/host-workspace.js';

export function configureHarborSandboxPolicy(systemWrites) {
  if (systemWrites !== true) return;
  if (!fs.existsSync('/.dockerenv')) {
    throw new Error('Harbor system writes require Docker');
  }
  const dir = path.join(
    hostWorkspaceStateRoot({ agentId: 'main' }),
    '.hybridclaw',
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, 'policy.yaml'),
    'approval:\n  workspace_fence: false\n',
    { flag: 'wx', mode: 0o600 },
  );
}
