// Fresh isolated workers compare routing with the same captured baseline prompt.
// Cards use production rendering and IPC; answers require manual evidence review.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { generateIpcAuthSecret } from '../../container/shared/ipc-input-auth.js';
import * as cfg from '../../src/config/config.ts';
import { withAutoHybridAIConnectorsMcpServer } from '../../src/mcp/hybridai-connectors.ts';
import { resolveMcpServersForRuntime } from '../../src/mcp/mcp-oauth.ts';
import { resolveModelRuntimeCredentials } from '../../src/providers/factory.ts';
import { readStoredRuntimeSecret } from '../../src/security/runtime-secrets.ts';
import { loadMiniSkillInstructions } from '../../src/skills/mini-skills.ts';
import { buildEligibleSkillCatalog } from '../../src/skills/skill-catalog.ts';
import { buildSkillsSection } from '../../src/skills/skills-prompt.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const variant = process.argv[2];
const count = Number(process.argv[3] || 2);
const skillName = process.env.BENCH_SKILL || 'bahn';
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName))
  throw new Error('BENCH_SKILL must be a bundled skill directory name.');
if (
  !['baseline', 'normal', 'mini'].includes(variant) ||
  !Number.isSafeInteger(count) ||
  count < 1 ||
  count > 10
) {
  throw new Error(
    'Usage: node --import tsx eval-harness/mini-skills/benchmark.mjs baseline|normal|mini [runs: 1–10]',
  );
}
if (!process.env.BENCH_AUDIT)
  throw new Error('BENCH_AUDIT must name a baseline wire.jsonl.');
const original = fs
  .readFileSync(process.env.BENCH_AUDIT, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line).event)
  .find((event) => event?.type === 'agent.start');
if (
  typeof original?.systemPrompt !== 'string' ||
  typeof original.dynamicContext !== 'string'
) {
  throw new Error('An agent.start with full prompt/context is required.');
}
const config = cfg.getConfigSnapshot();
const model = process.env.BENCH_MODEL || original.model;
const agentId = process.env.BENCH_AGENT_ID || config.agents.defaultAgentId;
const browserProvider = process.env.BENCH_BROWSER || cfg.BROWSER_PROVIDER;
if (!['local', 'mac-cua'].includes(browserProvider))
  throw new Error('Unsupported BENCH_BROWSER.');
const runtime = await resolveModelRuntimeCredentials({
  model,
  agentId,
  chatbotId: cfg.HYBRIDAI_CHATBOT_ID,
  enableRag: false,
});
const servers = await resolveMcpServersForRuntime(
  withAutoHybridAIConnectorsMcpServer(cfg.MCP_SERVERS),
);
const browserBin =
  process.env.AGENT_BROWSER_BIN ||
  path.join(root, 'node_modules/.bin/agent-browser');
if (browserProvider === 'local' && !fs.existsSync(browserBin))
  throw new Error(
    'Local browser binary missing; set AGENT_BROWSER_BIN to its path.',
  );
const skillPath = path.join(root, 'skills', skillName, 'SKILL.md');
const skillSource = fs.readFileSync(skillPath, 'utf8');
const metadata = YAML.parse(skillSource.split(/^---\s*$/m)[1]);
const skill = {
  name: metadata.name,
  description: metadata.description,
  category: metadata.metadata?.hybridclaw?.category,
  mini: variant === 'mini',
  always: false,
  disableModelInvocation: false,
  filePath: skillPath,
  location: `skills/${metadata.name}/SKILL.md`,
};
if (metadata.name !== skillName || metadata.mini !== true)
  throw new Error(
    'Select a mini: true skill whose name matches its directory.',
  );
if (!loadMiniSkillInstructions({ ...skill, mini: true }))
  throw new Error('The selected mini-skill body is empty or oversized.');
const system =
  original.systemPrompt +
  (variant === 'baseline' ? '' : `\n\n${buildSkillsSection([skill], 'lines')}`);
const skillCatalog =
  variant === 'baseline' ? [] : buildEligibleSkillCatalog([skill]);
const prompt =
  process.env.BENCH_PROMPT ||
  'Suche mal zugverbindungen München - Köln für morgen vormittag';
for (let run = 1; run <= count; run++) {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), `hc-${skillName}-${variant}-`),
  );
  const ipc = path.join(workspace, 'ipc');
  fs.mkdirSync(ipc);
  if (variant !== 'baseline') {
    fs.mkdirSync(path.dirname(path.join(workspace, skill.location)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(workspace, skill.location), skillSource);
  }
  const sessionId = `bench_${skillName}_${variant}_${randomUUID()}`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'container/src/index.ts'],
    {
      cwd: root,
      env: {
        ...process.env,
        AGENT_BROWSER_BIN: browserBin,
        HYBRIDCLAW_DATA_DIR: workspace,
        HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
        HYBRIDCLAW_AGENT_WORKSPACE_ROOT: workspace,
        HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT: '/workspace',
        HYBRIDCLAW_AGENT_ALLOWED_ROOTS: JSON.stringify([workspace]),
        HYBRIDCLAW_AGENT_IPC_DIR: ipc,
        CONTAINER_IDLE_TIMEOUT: '60000',
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    },
  );
  let failure;
  child.on('error', (error) => {
    failure = error;
  });
  child.stdin.on('error', (error) => {
    failure = error;
  });
  const start = performance.now();
  child.stdin.write(
    `${JSON.stringify({
      sessionId,
      agentId,
      ...runtime,
      channelId: 'web',
      browserProvider,
      gatewayBaseUrl: process.env.GATEWAY_URL || 'http://127.0.0.1:9090',
      gatewayApiToken: readStoredRuntimeSecret('GATEWAY_API_TOKEN'),
      ralphMaxIterations: 0,
      persistBashState: false,
      streamTextDeltas: true,
      mcpServers: servers,
      mcpToolMode: config.tools.mcpToolMode,
      blockedTools: ['device_data', 'react'],
      skillCatalog,
      ipcAuthSecret: generateIpcAuthSecret(),
      messages: [
        { role: 'system', content: system },
        { role: 'system', content: original.dynamicContext },
        { role: 'user', content: prompt },
      ],
    })}\n`,
  );
  try {
    const deadline = Date.now() + 240_000;
    let output;
    while (Date.now() < deadline) {
      if (failure) {
        output = { status: 'error', error: failure.message };
        break;
      }
      const resultPath = path.join(ipc, 'output.json');
      if (fs.existsSync(resultPath)) {
        output = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        break;
      }
      if (child.exitCode !== null) {
        output = {
          status: 'error',
          error: 'Worker exited before writing its result.',
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!output)
      output = {
        status: 'timeout',
        error: 'Worker timed out; no completed answer.',
      };
    const report = {
      variant,
      run,
      skill: skillName,
      provider: runtime.provider,
      providerMethod: runtime.providerMethod,
      startedAt: new Date(
        Date.now() - (performance.now() - start),
      ).toISOString(),
      checkoutCommit: spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).stdout.trim(),
      cardSha256: createHash('sha256').update(skillSource).digest('hex'),
      promptSha256: createHash('sha256')
        .update(original.systemPrompt)
        .update(original.dynamicContext)
        .digest('hex'),
      prompt,
      model,
      browserProvider,
      status: output.status,
      totalMs: Math.round(performance.now() - start),
      tools: output.toolExecutions?.map((tool) => ({
        name: tool.name,
        ms: tool.durationMs,
        error: tool.isError,
      })),
      modelCalls: output.tokenUsage?.modelCalls,
      promptTokens: output.tokenUsage?.apiPromptTokens,
      completionTokens: output.tokenUsage?.apiCompletionTokens,
      answer: output.result,
      error: output.error,
    };
    // Private evidence remains outside the repository; never persist worker input/secrets.
    fs.writeFileSync(
      path.join(workspace, 'output.json'),
      JSON.stringify(output, null, 2),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        ...report,
        evidencePath: path.join(workspace, 'output.json'),
      }),
    );
  } finally {
    child.kill('SIGTERM');
    if (browserProvider === 'local')
      spawnSync(browserBin, ['--session', sessionId, 'close'], {
        stdio: 'ignore',
        timeout: 10_000,
      });
  }
}
