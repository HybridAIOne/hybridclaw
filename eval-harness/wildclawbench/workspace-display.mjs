/**
 * The task path is the execution workspace, independent of agent state.
 * Reject a mismatched task root before worker startup; retain its write fence.
 */
import fs from 'node:fs';

if (process.env.HYBRIDCLAW_AGENT_SANDBOX_MODE === 'host') {
  const root = process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT;
  if (!root || fs.realpathSync(root) !== '/tmp_workspace') {
    throw new Error(
      'Benchmark worker workspace must resolve to /tmp_workspace',
    );
  }
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT = '/tmp_workspace';
}
