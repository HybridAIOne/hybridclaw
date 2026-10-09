/**
 * Eval harness entry point — `npm run eval -- <args>` from a source checkout.
 *
 * The harness is an unshipped workspace (AGENTS.md §3.4): it imports core
 * modules by relative path but is never compiled into `dist/` or the npm
 * package, so installed releases have no `eval` command. It drives a running
 * gateway through its OpenAI-compatible endpoint; the gateway-side eval
 * profile parsing (`src/evals/eval-profile.ts`) stays in core.
 */
import { renderGatewayCommand } from '../../src/gateway/gateway-types.js';

// Entry points that bypass the gateway-driven suite dispatcher: the harness
// evolution loop, and the native runners that detached runs re-enter in a
// fresh process (see `buildInternalEvalCommand`).
const DIRECT_COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  'harness-evolve': async (args) => {
    const { runHarnessEvolveCommand } = await import(
      './harness-evolve-command.js'
    );
    await runHarnessEvolveCommand(args);
  },
  '__eval-terminal-bench-native': async (args) => {
    await initRuntimeState();
    const { runTerminalBenchNativeCli } = await import(
      './terminal-bench-native.js'
    );
    await runTerminalBenchNativeCli(args);
  },
  '__eval-locomo-native': async (args) => {
    const { runLocomoNativeCli } = await import('./locomo-native.js');
    await runLocomoNativeCli(args);
  },
  '__eval-trace-judge-native': async (args) => {
    const { runTraceJudgeNativeCli } = await import('./trace-judge-native.js');
    await runTraceJudgeNativeCli(args);
  },
  '__eval-agent-risk-native': async (args) => {
    const { runAgentRiskNativeCli } = await import('./agent-risk-native.js');
    await runAgentRiskNativeCli(args);
  },
};

// Loaded lazily: loading the runtime config may migrate config.json and log
// that on stdout, which would corrupt `harness-evolve contract` JSON.
async function initRuntimeState(): Promise<void> {
  const { getRuntimeConfig } = await import(
    '../../src/config/runtime-config.js'
  );
  const { initDatabase, isDatabaseInitialized } = await import(
    '../../src/memory/db.js'
  );
  const { initAgentRegistry } = await import(
    '../../src/agents/agent-registry.js'
  );
  if (!isDatabaseInitialized()) {
    initDatabase({ quiet: true });
  }
  initAgentRegistry(getRuntimeConfig().agents);
}

async function runEvalCommand(args: string[]): Promise<void> {
  await initRuntimeState();
  const config = await import('../../src/config/config.js');
  const { resolveAgentForRequest } = await import(
    '../../src/agents/agent-registry.js'
  );
  const { memoryService } = await import('../../src/memory/memory-service.js');
  const { handleEvalCommand } = await import('./eval-command.js');

  const session = memoryService.getOrCreateSession('cli:eval', null, 'cli');
  const runtime = resolveAgentForRequest({ session });
  const result = await handleEvalCommand({
    args,
    dataDir: config.DATA_DIR,
    gatewayBaseUrl: config.GATEWAY_CLIENT_BASE_URL,
    webApiToken: config.WEB_API_TOKEN,
    gatewayApiToken: config.GATEWAY_API_TOKEN,
    effectiveAgentId: runtime.agentId,
    effectiveModel: runtime.model,
  });

  const rendered = renderGatewayCommand(result).trim();
  if (rendered) console.log(rendered);
  if (result.kind === 'error') process.exitCode = 1;
}

async function main(argv: string[]): Promise<void> {
  const [command = '', ...rest] = argv;
  if (Object.hasOwn(DIRECT_COMMANDS, command)) {
    await DIRECT_COMMANDS[command](rest);
    return;
  }
  await runEvalCommand(argv);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(
    `eval error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
