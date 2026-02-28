#!/usr/bin/env node

import { ensureHybridAICredentials } from './onboarding.js';
import { MissingRequiredEnvVarError } from './config.js';

async function ensureRuntimeContainer(commandName: string, required = true): Promise<void> {
  const { ensureContainerImageReady } = await import('./container-setup.js');
  await ensureContainerImageReady({ commandName, required, cwd: process.cwd() });
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'gateway':
      await ensureHybridAICredentials({ commandName: 'hybridclaw gateway' });
      await ensureRuntimeContainer('hybridclaw gateway');
      await import('./gateway.js');
      break;
    case 'tui':
      await ensureHybridAICredentials({ commandName: 'hybridclaw tui' });
      await ensureRuntimeContainer('hybridclaw tui');
      await import('./tui.js');
      break;
    case 'onboarding':
      await ensureHybridAICredentials({ force: true, commandName: 'hybridclaw onboarding' });
      await ensureRuntimeContainer('hybridclaw onboarding', false);
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

const envVarHint: Record<string, string> = {
  HYBRIDAI_API_KEY:
    'Set HYBRIDAI_API_KEY in .env or your shell, then run the command again. You can also run `hybridclaw onboarding` to set it interactively.',
};

function printMissingEnvVarError(message: string, envVar?: string): void {
  const hint = envVar ? envVarHint[envVar] : 'Set this variable and rerun the command.';
  console.error(`hybridclaw error: ${message}`);
  console.error(`Hint: ${hint}`);
  console.error('Make sure you run `hybridclaw` from the directory that contains your .env file.');
}

main().catch((err) => {
  const missingEnvVarMatch = err instanceof Error
    ? err.message.match(/^Missing required env var:\s*([A-Za-z0-9_]+)/)
    : null;
  if (missingEnvVarMatch) {
    printMissingEnvVarError(err.message, missingEnvVarMatch[1]);
  } else if (err instanceof MissingRequiredEnvVarError) {
    printMissingEnvVarError(err.message, err.envVar);
  } else {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`hybridclaw error: ${message}`);
  }
  process.exit(1);
});
