import { listKnownToolNames } from '../agent/tool-summary.js';
import {
  getRuntimeConfig,
  getRuntimeDisabledToolNames,
  setRuntimeToolEnabled,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { normalizeArgs } from './common.js';
import { isHelpRequest, printToolUsage } from './help.js';

export async function handleToolCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printToolUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'list') {
    const disabled = getRuntimeDisabledToolNames(getRuntimeConfig());
    for (const toolName of listKnownToolNames()) {
      console.log(
        `${toolName} [${disabled.has(toolName) ? 'disabled' : 'enabled'}]`,
      );
    }
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const toolName = normalized[1];
    if (!toolName || normalized.length !== 2) {
      printToolUsage();
      throw new Error(
        `Expected exactly one tool name for \`hybridclaw tool ${sub}\`.`,
      );
    }

    const known = new Set(listKnownToolNames());
    if (!known.has(toolName)) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const enabled = sub === 'enable';
    updateRuntimeConfig((draft) => {
      setRuntimeToolEnabled(draft, toolName, enabled);
    });
    console.log(`${enabled ? 'Enabled' : 'Disabled'} ${toolName}.`);
    return;
  }

  printToolUsage();
  throw new Error(`Unknown tool command: ${sub}`);
}
