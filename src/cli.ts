#!/usr/bin/env node

import { ensureHybridAICredentials } from './onboarding.js';

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'gateway':
      await ensureHybridAICredentials({ commandName: 'hybridclaw gateway' });
      await import('./gateway.js');
      break;
    case 'tui':
      await ensureHybridAICredentials({ commandName: 'hybridclaw tui' });
      await import('./tui.js');
      break;
    case 'onboarding':
      await ensureHybridAICredentials({ force: true, commandName: 'hybridclaw onboarding' });
      break;
    default:
      console.log(`Usage: hybridclaw <command>

Commands:
  gateway    Start core runtime (web/API/scheduler/heartbeat/optional Discord)
  tui        Start terminal adapter (requires running gateway)
  onboarding Run HybridAI account/API key onboarding`);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`hybridclaw error: ${message}`);
  process.exit(1);
});
