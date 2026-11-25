/**
 * One Harbor task turn through the installed gateway and a host-mode worker,
 * inside the task sandbox. `hybridclaw_harbor.py` uploads this file and the run
 * config; Harbor grades the working directory after this process exits.
 *
 * Every model call goes to the endpoint in the run config, with thinking off:
 * a training capture proxy records them all as agent turns. It sets no
 * deadline of its own; Harbor's agent timeout ends the run.
 */
import fs from 'node:fs';

const root = '/opt/hybridclaw-install/node_modules/@hybridaione/hybridclaw';
const ENDPOINT = 'harbor';
const [configPath, flag] = process.argv.slice(2);
const check = flag === '--check';
const run = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const model = `${ENDPOINT}/${run.model}`;
const dataDir = process.env.HYBRIDCLAW_DATA_DIR;
if (!['/opt/hybridclaw-check', '/opt/hybridclaw-state'].includes(dataDir))
  throw new Error('The adapter requires its isolated runtime directory');
process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
process.env.HYBRIDCLAW_AGENT_DEDICATED_CGROUP = '1';

const trace = (type, value) => {
  if (!check)
    fs.appendFileSync(
      `${run.traceDir}/progress.jsonl`,
      `${JSON.stringify({ timestamp: new Date().toISOString(), type, value })}\n`,
    );
};
if (!check) {
  // Harbor keeps this folder after a timeout kills the process and the sandbox.
  fs.mkdirSync(`${run.traceDir}/live-audit`, { recursive: true });
  fs.mkdirSync(`${dataDir}/data`, { recursive: true });
  fs.symlinkSync(`${run.traceDir}/live-audit`, `${dataDir}/data/audit`, 'dir');
}
fs.mkdirSync(dataDir, { recursive: true });
// Provider registration reads configuration during module initialization.
fs.writeFileSync(
  `${dataDir}/config.json`,
  JSON.stringify({
    local: {
      endpoints: [
        {
          name: ENDPOINT,
          type: 'vllm',
          enabled: true,
          baseUrl: run.baseUrl,
          apiKey: run.apiKey,
          modelBehavior: { thinkingFormat: 'qwen' },
        },
      ],
      ...(run.contextWindow ? { defaultContextWindow: run.contextWindow } : {}),
    },
    hybridai: { defaultModel: model },
    // The title call would go to the same endpoint and use up model-call budget.
    auxiliaryModels: { session_title: { provider: 'disabled' } },
    container: { sandboxMode: 'host', warmPool: { enabled: false } },
  }),
);
const {
  getRuntimeConfig,
  initDatabase,
  initAgentRegistry,
  resolveModelProvider,
  handleGatewayMessage,
  flushAuditTrail,
  startGatewayHttpServer,
  GATEWAY_API_TOKEN,
  GATEWAY_CLIENT_BASE_URL,
  SHELL_RUNTIME_ENV_PATH,
  configureHarborSandboxPolicy,
} = await import(`${root}/dist/harbor-adapter-api.js`);
const installed = JSON.parse(fs.readFileSync(`${root}/package.json`, 'utf8'));
if (installed.version !== run.version)
  throw new Error(`Unexpected HybridClaw version: ${installed.version}`);
if (resolveModelProvider(model) !== 'vllm')
  throw new Error('The adapter model resolved to the wrong provider');
configureHarborSandboxPolicy(run.sandboxSystemWrites);
initDatabase({ quiet: true });
initAgentRegistry(getRuntimeConfig().agents);
startGatewayHttpServer().setReady();
// The worker's shell calls fetch their environment from this gateway route.
const shellEnv = await fetch(
  `${GATEWAY_CLIENT_BASE_URL}${SHELL_RUNTIME_ENV_PATH}`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${GATEWAY_API_TOKEN}` },
  },
);
if (!shellEnv.ok)
  throw new Error(`Gateway shell prerequisite failed: ${shellEnv.status}`);
if (check) process.exit(0);

let result;
try {
  result = await handleGatewayMessage({
    sessionId: 'agent:main:cli:dm:harbor-adapter',
    executionSessionId: 'harbor-adapter-trial',
    executorModeOverride: 'host',
    autoApproveTools: true,
    workspacePathOverride: process.cwd(),
    workspaceDisplayRootOverride: process.cwd(),
    guildId: null,
    channelId: 'cli',
    userId: 'harbor',
    username: 'harbor',
    content: `Carry out the task using the available tools in this isolated Harbor sandbox. Harbor verifies the sandbox state after your turn.\n\n${run.instruction}`,
    agentId: 'main',
    model,
    reasoningEffort: 'none',
    maxWallClockMs: null,
    inactivityTimeoutMs: null,
    promptMode: 'full',
    source: 'eval.harbor-adapter',
    onTextDelta: (delta) => trace('text', delta),
    onToolProgress: (event) => trace('tool', event),
    onApprovalProgress: (event) => trace('approval', event),
  });
} catch (error) {
  result = { status: 'error', error: error.message };
}
trace('result', result);
// process.exit() drops audit events that are still queued.
await flushAuditTrail();
fs.writeFileSync(
  '/tmp/hybridclaw-result.json',
  JSON.stringify(result, null, 2),
);
process.exit(result.status === 'error' ? 1 : 0);
