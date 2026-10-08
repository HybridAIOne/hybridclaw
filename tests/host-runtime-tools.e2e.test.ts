import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ChatMessage } from '../container/src/types.js';
import {
  getAvailablePort,
  waitForHealth,
} from './helpers/docker-test-setup.js';
import {
  type ModelRequestBody,
  startScriptedModelServer,
} from './helpers/scripted-model-server.js';
import { cleanupTrackedTempDirs } from './test-utils.js';

/**
 * Host-sandbox agents in the layouts the npm-install journey does not cover:
 * the gateway image runs bundle/cli.js with the shared skill libraries on its
 * process NODE_PATH, and a checkout runs dist/cli.js and gets those libraries
 * through the gateway's `skill setup` command. The gateway, host agent, tools
 * and skill scripts are real; only the model is scripted (`RUN: <command>`
 * becomes one bash call, `READ: <path>` one read call, and the tool output is
 * the answer). Needs `npm run build` and `npm run setup`; the setup test runs
 * a real `npm ci` of container/tools into the gateway's data dir. CI runs it
 * in the `CLI binary e2e` step, where node-pty is still unbuilt.
 */

const RUN = process.env.HYBRIDCLAW_RUN_CLI_E2E === '1';
const repoRoot = path.resolve(import.meta.dirname, '..');
const toolLibraries = path.join(repoRoot, 'container', 'tools', 'node_modules');
const agentRuntimeLibraries = path.join(repoRoot, 'container', 'node_modules');
const STARTUP_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 120_000;
const SETUP_TIMEOUT_MS = 300_000;
const WEB_API_TOKEN = 'host-runtime-e2e-token';
const MODEL_ID = 'scripted';
const NODE = process.execPath;
const PDF_TEXT = 'Grüße aus Köln: 42 € — Łódź';

function messageText(message: ChatMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => ('text' in part && part.text ? part.text : ''))
    .join('\n');
}

let callCount = 0;

function toolCall(
  name: string,
  args: Record<string, string>,
  tools: ModelRequestBody['tools'],
): Record<string, unknown> {
  callCount += 1;
  const exposed = tools.some((tool) => tool.function.name === name);
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: `call_${callCount}`,
        type: 'function',
        function: exposed
          ? { name, arguments: JSON.stringify(args) }
          : {
              name: 'tool_catalog',
              arguments: JSON.stringify({
                action: 'call',
                name,
                arguments: args,
              }),
            },
      },
    ],
  };
}

function scriptedAgent(body: ModelRequestBody): Record<string, unknown> {
  const last = body.messages.at(-1);
  if (!body.tools?.length || !last) return { role: 'assistant', content: 'ok' };
  const text = messageText(last);
  // A PDF read with rendered pages delivers them in a user message after the
  // tool result; answer with the tool result either way.
  if (last.role === 'tool' || text.startsWith('Read result ')) {
    const result = body.messages.findLast((message) => message.role === 'tool');
    return { role: 'assistant', content: messageText(result) };
  }
  const command = /RUN: ([\s\S]+)$/.exec(text)?.[1];
  if (command) return toolCall('bash', { command }, body.tools);
  const readPath = /READ: (\S+)/.exec(text)?.[1];
  if (readPath) return toolCall('read', { path: readPath }, body.tools);
  return { role: 'assistant', content: 'ok' };
}

interface Gateway {
  url: string;
  dataDir: string;
  stop: () => Promise<void>;
}

async function startGateway(params: {
  home: string;
  entry: string;
  preferredPort: number;
  modelPort: number;
  env: NodeJS.ProcessEnv;
}): Promise<Gateway> {
  const dataDir = path.join(params.home, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await getAvailablePort(params.preferredPort);
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      ops: {
        healthPort: port,
        healthHost: '127.0.0.1',
        webApiToken: WEB_API_TOKEN,
      },
      local: {
        backends: {
          vllm: {
            enabled: true,
            baseUrl: `http://127.0.0.1:${params.modelPort}/v1`,
          },
        },
      },
      agents: { defaults: { model: `vllm/${MODEL_ID}` } },
      container: { sandboxMode: 'host' },
    }),
  );
  const proc: ChildProcess = spawn(
    NODE,
    [params.entry, 'gateway', 'start', '--foreground', '--sandbox=host'],
    {
      cwd: params.home,
      env: {
        ...params.env,
        HOME: params.home,
        HYBRIDCLAW_DATA_DIR: dataDir,
        HYBRIDCLAW_ACCEPT_TRUST: 'true',
        HYBRIDAI_API_KEY: 'hai-host-runtime-e2e-placeholder',
        HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
      },
      stdio: 'pipe',
    },
  );
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  proc.stdout?.resume();
  const exited = new Promise<void>((resolve) => proc.once('exit', resolve));
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(`${url}/health`, STARTUP_TIMEOUT_MS);
  } catch (err) {
    proc.kill('SIGKILL');
    throw new Error(`gateway did not start: ${String(err)}\n${stderr}`);
  }
  return {
    url,
    dataDir,
    stop: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill('SIGTERM');
      const timer = setTimeout(() => proc.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

async function post<T>(gateway: Gateway, route: string, body: unknown) {
  const res = await fetch(`${gateway.url}${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WEB_API_TOKEN}`,
      'Content-Type': 'application/json',
      Connection: 'close',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
  });
  const payload = (await res.json()) as T;
  expect(res.status, JSON.stringify(payload)).toBe(200);
  return payload;
}

async function chat(
  gateway: Gateway,
  sessionId: string,
  content: string,
): Promise<string> {
  const body = await post<{ status?: string; result?: string }>(
    gateway,
    '/api/chat',
    { sessionId, agentId: 'main', content },
  );
  expect(body.status, JSON.stringify(body)).toBe('success');
  return String(body.result ?? '');
}

/** The checkout CLI against a gateway's data dir, as an operator runs it. */
function cli(home: string, ...args: string[]) {
  const env = { ...process.env, HOME: home, HYBRIDCLAW_DATA_DIR: path.join(home, 'data') };
  delete env.NODE_PATH;
  const run = spawnSync(NODE, [path.join(repoRoot, 'dist', 'cli.js'), ...args], {
    cwd: home,
    env,
    encoding: 'utf8',
    timeout: SETUP_TIMEOUT_MS,
  });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

/** A `/skill …` command from a local web session. */
function skillCommand(gateway: Gateway, ...args: string[]) {
  return post<{ kind: string; text: string }>(gateway, '/api/command', {
    sessionId: 'host-runtime-e2e-web',
    guildId: null,
    channelId: 'web',
    args: ['skill', ...args],
  });
}

async function skillState(gateway: Gateway, skill: string): Promise<string> {
  const { text } = await skillCommand(gateway, 'list');
  return new RegExp(`^\\s*${skill} \\[([^\\]]+)\\]`, 'm').exec(text)?.[1] ?? '';
}

describe.runIf(RUN)('host-sandbox runtime libraries outside the npm tarball', () => {
  const tempDirs: string[] = [];
  let tempRoot = '';
  let modelServer: http.Server | undefined;
  let modelRequests: ModelRequestBody[] = [];
  let modelPort = 0;

  beforeAll(async () => {
    for (const required of [
      path.join(repoRoot, 'dist', 'cli.js'),
      agentRuntimeLibraries,
      toolLibraries,
    ]) {
      expect(fs.existsSync(required), `${required}: run build and setup`).toBe(
        true,
      );
    }
    tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-host-runtime-e2e-'),
    );
    tempDirs.push(tempRoot);
    const model = await startScriptedModelServer(scriptedAgent, {
      model: MODEL_ID,
    });
    modelServer = model.server;
    modelRequests = model.requests;
    modelPort = model.port;
  });

  afterAll(async () => {
    modelServer?.close();
    cleanupTrackedTempDirs(tempDirs);
  });

  describe('gateway image layout: bundle/cli.js with the libraries on NODE_PATH', () => {
    let gateway: Gateway | undefined;
    let workspace = '';

    beforeAll(async () => {
      execFileSync(NODE, ['scripts/bundle-gateway.mjs'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
      const home = path.join(tempRoot, 'image');
      fs.mkdirSync(home);
      gateway = await startGateway({
        home,
        entry: path.join(repoRoot, 'bundle', 'cli.js'),
        preferredPort: 19360,
        modelPort,
        env: { ...process.env, NODE_PATH: toolLibraries },
      });
    }, STARTUP_TIMEOUT_MS + 60_000);

    afterAll(async () => {
      await gateway?.stop();
    });

    test(
      'a host agent inherits the image NODE_PATH and runs the pdf and xlsx scripts',
      async () => {
        if (!gateway) throw new Error('gateway did not start');
        const result = await chat(
          gateway,
          'host-runtime-image',
          [
            'RUN: pwd && echo "$NODE_PATH"',
            `${NODE} skills/pdf/scripts/create_pdf.mjs report.pdf --text "${PDF_TEXT}"`,
            `${NODE} skills/pdf/scripts/render_pdf_pages.mjs report.pdf pages`,
            `${NODE} skills/xlsx/scripts/create_xlsx.cjs out.xlsx --headers "Name,Amount" --rows "Alice,12.5" --json`,
          ].join(' && '),
        );
        const [cwd, nodePath] = result.split('\n');
        workspace = cwd.trim();
        expect(nodePath.split(path.delimiter)).toEqual([
          agentRuntimeLibraries,
          path.join(gateway.dataDir, 'runtime-tools', 'node_modules'),
          toolLibraries,
        ]);
        expect(fs.readdirSync(path.join(workspace, 'pages'))).toEqual([
          'page_1.png',
        ]);
        expect(
          fs.statSync(path.join(workspace, 'out.xlsx')).size,
        ).toBeGreaterThan(0);
      },
      TURN_TIMEOUT_MS,
    );

    test(
      "the host agent's read tool extracts the PDF text",
      async () => {
        if (!gateway) throw new Error('gateway did not start');
        expect(
          await chat(gateway, 'host-runtime-read', 'READ: report.pdf'),
        ).toContain(PDF_TEXT);
      },
      TURN_TIMEOUT_MS,
    );

    test(
      'the bundled gateway previews a referenced PDF',
      async () => {
        if (!gateway) throw new Error('gateway did not start');
        const before = modelRequests.length;
        await chat(
          gateway,
          'host-runtime-preview',
          `Summarize ${path.join(workspace, 'report.pdf')}`,
        );
        const preview = modelRequests
          .slice(before)
          .flatMap((request) =>
            request.messages
              .filter((message) => message.role === 'user')
              .map(messageText),
          )
          .find((text) => text.includes('[PDFPreview]'));
        expect(preview).toContain(PDF_TEXT);
      },
      TURN_TIMEOUT_MS,
    );

    test('/skill setup installs nothing when NODE_PATH already provides the libraries', async () => {
      if (!gateway) throw new Error('gateway did not start');
      const result = await skillCommand(gateway, 'setup', 'xlsx');
      expect(result.kind, result.text).toBe('info');
      expect(result.text).toContain('already resolve');
      expect(fs.existsSync(path.join(gateway.dataDir, 'runtime-tools'))).toBe(
        false,
      );
      expect(await skillState(gateway, 'xlsx')).toBe('enabled');
    });
  });

  describe('checkout layout: dist/cli.js with /skill setup through the gateway', () => {
    let gateway: Gateway | undefined;
    const startCheckoutGateway = async () => {
      const env = { ...process.env };
      delete env.NODE_PATH;
      const home = path.join(tempRoot, 'checkout');
      fs.mkdirSync(home, { recursive: true });
      gateway = await startGateway({
        home,
        entry: path.join(repoRoot, 'dist', 'cli.js'),
        preferredPort: 19361,
        modelPort,
        env,
      });
    };

    // Longer than the health wait, so a gateway that never starts reports its
    // stderr instead of a bare hook timeout.
    beforeAll(startCheckoutGateway, STARTUP_TIMEOUT_MS + 30_000);

    afterAll(async () => {
      await gateway?.stop();
    });

    test(
      '/skill setup installs the locked libraries that a new host agent then loads',
      async () => {
        if (!gateway) throw new Error('gateway did not start');
        expect(await skillState(gateway, 'xlsx')).toContain('node_module:xlsx');

        const pending = skillCommand(gateway, 'setup', 'xlsx');
        const lock = path.join(gateway.dataDir, 'runtime-tools', 'setup.lock');
        await expect.poll(() => fs.existsSync(lock), { timeout: 10_000 }).toBe(
          true,
        );
        // An operator's CLI run on the same data dir while the gateway's
        // `npm ci` is still in flight.
        const competing = cli(path.dirname(gateway.dataDir), 'skill', 'setup', 'docx');
        expect(competing.status).not.toBe(0);
        expect(competing.output).toContain(
          'Another skill library setup is running',
        );

        const setup = await pending;
        expect(setup.kind, setup.text).toBe('info');
        expect(fs.existsSync(lock)).toBe(false);
        expect(setup.text).toContain('Set up xlsx');
        for (const skill of ['xlsx', 'docx', 'pptx']) {
          expect(await skillState(gateway, skill), skill).toBe('enabled');
        }

        const result = await chat(
          gateway,
          'host-runtime-setup',
          [
            `RUN: ${NODE} skills/xlsx/scripts/create_xlsx.cjs out.xlsx --headers "Name" --rows "Alice" --json`,
            `${NODE} -e 'const d=require("docx");d.Packer.toBuffer(new d.Document({sections:[{children:[new d.Paragraph("hi")]}]})).then(b=>console.log("docx bytes", b.length))'`,
            `${NODE} -p 'require.resolve("pptxgenjs")'`,
          ].join(' && '),
        );
        expect(result).toContain('"output_path": "out.xlsx"');
        expect(result).toMatch(/docx bytes \d+/);
        expect(result).toContain(
          path.join(gateway.dataDir, 'runtime-tools', 'node_modules'),
        );
      },
      SETUP_TIMEOUT_MS,
    );

    test(
      'after an upgrade to another lockfile, the stale libraries stay hidden until setup runs again',
      async () => {
        if (!gateway) throw new Error('gateway did not start');
        fs.appendFileSync(
          path.join(gateway.dataDir, 'runtime-tools', 'package-lock.json'),
          '\n',
        );
        // An upgrade restarts the gateway, so no warm agent keeps the old env.
        await gateway.stop();
        await startCheckoutGateway();
        if (!gateway) throw new Error('gateway did not restart');

        expect(await skillState(gateway, 'xlsx')).toContain('node_module:xlsx');
        const nodePath = await chat(
          gateway,
          'host-runtime-stale',
          'RUN: echo "$NODE_PATH"',
        );
        expect(nodePath.trim().split(path.delimiter)).toEqual([
          agentRuntimeLibraries,
        ]);
      },
      STARTUP_TIMEOUT_MS + TURN_TIMEOUT_MS,
    );
  });

  describe('container sandbox: the CLI setup leaves the data dir alone', () => {
    test('`skill setup xlsx` installs nothing and `skill list` shows the image libraries', () => {
      const home = path.join(tempRoot, 'container');
      fs.mkdirSync(path.join(home, 'data'), { recursive: true });
      fs.writeFileSync(
        path.join(home, 'data', 'config.json'),
        JSON.stringify({ container: { sandboxMode: 'container' } }),
      );

      const setup = cli(home, 'skill', 'setup', 'xlsx');
      expect(setup.status, setup.output).toBe(0);
      expect(setup.output).toContain('container sandbox');
      expect(fs.existsSync(path.join(home, 'data', 'runtime-tools'))).toBe(
        false,
      );
      const list = cli(home, 'skill', 'list');
      expect(list.status, list.output).toBe(0);
      expect(list.output).not.toContain('node_module:');
    });
  });
});
