import {
  type ChildProcess,
  execFileSync,
  execSync,
  spawn,
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

/**
 * Exercises the real npm-install-to-first-request user journey:
 * npm pack → npm install -g → hybridclaw gateway start → /health → /docs,
 * then host-sandbox turns that run the bundled office skill scripts.
 *
 * Uses a temporary npm prefix and a dummy API key. Turns run against a
 * scripted OpenAI-compatible model on the test host: a `RUN: <command>`
 * prompt becomes one bash call whose output is the answer.
 */

const NPM_E2E = process.env.HYBRIDCLAW_RUN_NPM_E2E === '1';
const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
// CI maintenance (2026-09-22): allow shutdown plus removal of both installed
// dependency trees on slower runners; startup/request timeouts stay separate.
const CLEANUP_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 120_000;
const MODEL_ID = 'scripted';
// Absolute: a host agent's bash does not necessarily inherit this PATH.
const NODE = process.execPath;

let tempDir: string;
let gatewayProcess: ChildProcess | null = null;
let modelServer: http.Server | undefined;
let modelRequests: ModelRequestBody[] = [];
/** The host agent's workspace, as its first bash call reports it. */
let workspaceDir = '';
let HOST_PORT: number;
let GATEWAY_URL: string;

function npmPrefix(): string {
  return path.join(tempDir, 'npm-global');
}

function dataDir(): string {
  return path.join(tempDir, 'hybridclaw-data');
}

function installedPackageDir(): string {
  return path.join(
    npmPrefix(),
    'lib',
    'node_modules',
    '@hybridaione',
    'hybridclaw',
  );
}

const WEB_API_TOKEN = 'npm-e2e-web-token';

function installedCliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: tempDir,
    HYBRIDCLAW_DATA_DIR: dataDir(),
    HYBRIDCLAW_ACCEPT_TRUST: 'true',
    HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
  };
}

function installedCliPath(): string {
  return path.join(installedPackageDir(), 'dist', 'cli.js');
}

function cli(args: string[]): string {
  return execFileSync(NODE, [installedCliPath(), ...args], {
    encoding: 'utf-8',
    timeout: 300_000,
    env: installedCliEnv(),
  });
}

function messageText(message: ChatMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => ('text' in part && part.text ? part.text : ''))
    .join('\n');
}

function scriptedAgent(body: ModelRequestBody): Record<string, unknown> {
  const last = body.messages.at(-1);
  if (!body.tools?.length || !last) return { role: 'assistant', content: 'ok' };
  if (last.role === 'tool') {
    return { role: 'assistant', content: messageText(last) };
  }
  const command = /RUN: ([\s\S]+)$/.exec(messageText(last))?.[1];
  if (!command) return { role: 'assistant', content: 'ok' };
  const args = { command };
  const exposed = body.tools.some((tool) => tool.function.name === 'bash');
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: `call_${modelRequests.length}`,
        type: 'function',
        function: exposed
          ? { name: 'bash', arguments: JSON.stringify(args) }
          : {
              name: 'tool_catalog',
              arguments: JSON.stringify({
                action: 'call',
                name: 'bash',
                arguments: args,
              }),
            },
      },
    ],
  };
}

async function chat(sessionId: string, content: string): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/api/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WEB_API_TOKEN}`,
      'Content-Type': 'application/json',
      // Turns follow slow CLI steps; a pooled socket would outlive the
      // gateway's 5s keep-alive and fail as "other side closed".
      Connection: 'close',
    },
    body: JSON.stringify({ sessionId, agentId: 'main', content }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  const body = (await res.json()) as { status?: string; result?: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  expect(body.status, JSON.stringify(body)).toBe('success');
  return String(body.result ?? '');
}

/** The `skill list` state of each office skill, e.g. `enabled`. */
function officeSkillStates(): Record<string, string> {
  const states: Record<string, string> = {};
  for (const match of cli(['skill', 'list']).matchAll(
    /^ {2}(pdf|xlsx|docx|pptx|office) \[([^\]]+)\]/gm,
  )) {
    states[match[1]] = match[2];
  }
  return states;
}

function verifyPnpmInstallBlocksExoticSubdeps(tarball: string): void {
  const pnpmHome = path.join(tempDir, 'pnpm-home');
  const pnpmGlobalDir = path.join(tempDir, 'pnpm-global');
  fs.mkdirSync(pnpmHome, { recursive: true });
  fs.mkdirSync(pnpmGlobalDir, { recursive: true });

  execSync(
    `npx --yes pnpm@10.23.0 add -g "${tarball}" --config.block-exotic-subdeps=true --global-dir "${pnpmGlobalDir}" --dir "${tempDir}"`,
    {
      encoding: 'utf-8',
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: tempDir,
        PATH: `${pnpmHome}${path.delimiter}${process.env.PATH ?? ''}`,
        PNPM_HOME: pnpmHome,
      },
    },
  );
}

describe.skipIf(!NPM_E2E)('npm install user journey', () => {
  beforeAll(async () => {
    HOST_PORT = await getAvailablePort(
      Number(process.env.HYBRIDCLAW_E2E_PORT) || 9198,
    );
    GATEWAY_URL = `http://127.0.0.1:${HOST_PORT}`;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-npm-e2e-'));
    fs.mkdirSync(npmPrefix(), { recursive: true });
    fs.mkdirSync(dataDir(), { recursive: true });

    const packOutput = execSync(`npm pack --pack-destination "${tempDir}"`, {
      encoding: 'utf-8',
      timeout: 120_000,
    }).trim();
    const tarballName = packOutput.split('\n').pop()?.trim();
    if (!tarballName) {
      throw new Error(
        `npm pack produced no output. Full output: ${packOutput}`,
      );
    }
    const tarball = path.join(tempDir, tarballName);

    verifyPnpmInstallBlocksExoticSubdeps(tarball);

    execSync(`npm install -g "${tarball}" --prefix "${npmPrefix()}"`, {
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...process.env, HOME: tempDir },
    });

    const model = await startScriptedModelServer(scriptedAgent, {
      model: MODEL_ID,
    });
    modelServer = model.server;
    modelRequests = model.requests;

    fs.writeFileSync(
      path.join(dataDir(), 'config.json'),
      JSON.stringify({
        ops: {
          healthPort: HOST_PORT,
          healthHost: '127.0.0.1',
          webApiToken: WEB_API_TOKEN,
        },
        local: {
          backends: {
            vllm: {
              enabled: true,
              baseUrl: `http://127.0.0.1:${model.port}/v1`,
            },
          },
        },
        agents: { defaults: { model: `vllm/${MODEL_ID}` } },
        // The CLI reads skill availability for this mode, like the gateway.
        container: { sandboxMode: 'host' },
      }),
    );

    // The install-on-demand distill plugin, by id from the installed package.
    execSync(`node "${installedCliPath()}" plugin install distill`, {
      encoding: 'utf-8',
      timeout: 60_000,
      env: installedCliEnv(),
    });

    gatewayProcess = spawn(
      'node',
      [
        installedCliPath(),
        'gateway',
        'start',
        '--foreground',
        '--sandbox=host',
      ],
      {
        env: {
          ...process.env,
          HOME: tempDir,
          HYBRIDCLAW_DATA_DIR: dataDir(),
          HYBRIDCLAW_ACCEPT_TRUST: 'true',
          HYBRIDAI_API_KEY: 'hai-npm-e2e-placeholder',
          HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
        },
        stdio: 'pipe',
      },
    );

    let stderr = '';
    gatewayProcess.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // Drain stdout too: an unread pipe blocks the gateway once its ~64KB
    // buffer fills, deadlocking the suite on chatty startups.
    gatewayProcess.stdout?.resume();
    gatewayProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error('--- npm-installed gateway stderr ---\n', stderr);
      }
    });

    await waitForHealth(`${GATEWAY_URL}/health`, STARTUP_TIMEOUT_MS);
  }, STARTUP_TIMEOUT_MS + 150_000);

  afterAll(async () => {
    if (gatewayProcess) {
      const proc = gatewayProcess;
      gatewayProcess = null;
      proc.kill('SIGTERM');

      const exited = await Promise.race([
        new Promise<boolean>((resolve) => proc.on('exit', () => resolve(true))),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 5_000),
        ),
      ]);

      if (!exited) {
        console.warn(
          '[cleanup] Gateway did not exit after SIGTERM, sending SIGKILL',
        );
        proc.kill('SIGKILL');
        // Wait for the kill to land before directory removal races a process that
        // is still writing under tempDir (HOME, npm prefix, data dir).
        await Promise.race([
          new Promise<void>((resolve) => proc.on('exit', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
    }
    modelServer?.close();
    if (tempDir) {
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[cleanup] Failed to remove temp dir:', err);
      }
    }
  }, CLEANUP_TIMEOUT_MS);

  // ── CLI binary works ────────────────────────────────────────────────

  test('hybridclaw --version runs from installed package', () => {
    const result = execSync(`node "${installedCliPath()}" --version`, {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('gateway status does not report the packaged build as stale', () => {
    const output = execSync(`node "${installedCliPath()}" gateway status`, {
      encoding: 'utf-8',
      timeout: REQUEST_TIMEOUT_MS * 4,
      env: {
        ...process.env,
        HOME: tempDir,
        HYBRIDCLAW_DATA_DIR: dataDir(),
      },
    });
    expect(output).toMatch(/Gateway build: .*\| stale: no/);
    expect(output).not.toContain('Stale build files');
  });

  // ── Gateway serves content from npm-installed package ───────────────

  test('/health returns ok with semver version', async () => {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe('ok');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('/docs renders Getting Started content', async () => {
    const res = await fetch(`${GATEWAY_URL}/docs`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Getting Started');
    expect(html).toContain('Installation');
  });

  test('/ redirects to chat', async () => {
    const res = await fetch(GATEWAY_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/chat');
  });

  test('/about serves the landing page with unique title', async () => {
    const res = await fetch(`${GATEWAY_URL}/about`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      '<title>HybridClaw \u2014 Enterprise AI Digital Coworker</title>',
    );
  });

  test('/chat serves the console SPA (chat is top-level, not under /admin)', async () => {
    const res = await fetch(`${GATEWAY_URL}/chat`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>HybridClaw Chat</title>');
  });

  test('the distill plugin installs by id and runs from the installed package', () => {
    const packageRoot = path.dirname(path.dirname(installedCliPath()));
    expect(fs.existsSync(path.join(dataDir(), 'plugins', 'distill'))).toBe(
      false,
    );
    const config = JSON.parse(
      fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf-8'),
    ) as { plugins?: { list?: Array<{ id: string; enabled: boolean }> } };
    expect(config.plugins?.list).toContainEqual(
      expect.objectContaining({ id: 'distill', enabled: true }),
    );
    expect(
      fs.existsSync(path.join(packageRoot, 'plugins', 'distill', 'src')),
    ).toBe(true);
    expect(fs.existsSync(path.join(packageRoot, 'dist', 'distill'))).toBe(
      false,
    );

    const help = execSync(`node "${installedCliPath()}" help`, {
      encoding: 'utf-8',
      timeout: 30_000,
      env: installedCliEnv(),
    });
    expect(help).toMatch(/Plugin commands:\n\s+coworker\s/);
    const usage = execSync(`node "${installedCliPath()}" coworker --help`, {
      encoding: 'utf-8',
      timeout: 30_000,
      env: installedCliEnv(),
    });
    expect(usage.startsWith('Usage: hybridclaw coworker')).toBe(true);
  });

  test('the gateway serves the distill admin API from the installed plugin', async () => {
    const res = await fetch(`${GATEWAY_URL}/api/admin/distill`, {
      headers: { Authorization: `Bearer ${WEB_API_TOKEN}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subjects: unknown[] };
    expect(body.subjects).toEqual([]);
  });

  test('/admin serves the console (host mode, no container auth)', async () => {
    const res = await fetch(`${GATEWAY_URL}/admin`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>HybridClaw Admin</title>');
  });

  // ── Skill libraries: owned by the agent runtime, not the gateway ────

  test('the gateway package does not carry skill-only libraries', () => {
    for (const name of ['pdfjs-dist', 'xlsx-populate', 'docx', 'csv-parse']) {
      expect(
        fs.existsSync(path.join(installedPackageDir(), 'node_modules', name)),
        name,
      ).toBe(false);
    }
    expect(
      fs.existsSync(
        path.join(installedPackageDir(), 'container', 'node_modules', 'pdfjs-dist'),
      ),
    ).toBe(true);
  });

  test(
    'a host agent runs the pdf skill scripts with the runtime pdfjs-dist',
    async () => {
      const result = await chat(
        'npm-e2e-pdf',
        `RUN: pwd && ${NODE} skills/pdf/scripts/create_pdf.mjs report.pdf --text "Grüße aus Köln: 42 € — Łódź" && ${NODE} skills/pdf/scripts/extract_pdf_text.mjs report.pdf && ${NODE} skills/pdf/scripts/render_pdf_pages.mjs report.pdf pages`,
      );
      workspaceDir = result.split('\n')[0].trim();
      expect(result).toContain('Grüße aus Köln: 42 € — Łódź');
      expect(fs.readdirSync(path.join(workspaceDir, 'pages'))).toEqual([
        'page_1.png',
      ]);
    },
    TURN_TIMEOUT_MS,
  );

  test(
    'the gateway previews a referenced PDF with the runtime pdfjs-dist',
    async () => {
      const pdfPath = path.join(workspaceDir, 'report.pdf');
      expect(fs.existsSync(pdfPath)).toBe(true);
      const before = modelRequests.length;
      await chat('npm-e2e-preview', `Summarize ${pdfPath}`);
      const sent = modelRequests
        .slice(before)
        .flatMap((request) => request.messages.map(messageText));
      expect(
        sent.some(
          (text) =>
            text.includes('[PDFPreview]') &&
            text.includes('Grüße aus Köln: 42 € — Łódź'),
        ),
      ).toBe(true);
    },
    TURN_TIMEOUT_MS,
  );

  test(
    'office skills become available after skill setup and run in a host agent',
    async () => {
      expect(officeSkillStates()).toMatchObject({
        pdf: 'enabled',
        office: 'enabled',
        xlsx: expect.stringContaining('node_module:xlsx-populate'),
        docx: 'node_module:docx',
        pptx: 'node_module:pptxgenjs',
      });

      expect(cli(['skill', 'setup', 'xlsx'])).toContain('Set up xlsx');
      expect(officeSkillStates()).toEqual({
        docx: 'enabled',
        office: 'enabled',
        pdf: 'enabled',
        pptx: 'enabled',
        xlsx: 'enabled',
      });

      fs.writeFileSync(
        path.join(workspaceDir, 'in.csv'),
        'Name;Amount\nAlice;12,5\nBob;7\n',
      );
      const result = await chat(
        'npm-e2e-office',
        [
          `RUN: ${NODE} skills/xlsx/scripts/create_xlsx.cjs out.xlsx --headers "Name,Amount" --rows "Alice,12.5;Bob,7" --json`,
          `${NODE} skills/xlsx/scripts/import_delimited.cjs in.csv imported.xlsx --json`,
          `${NODE} -e 'const d=require("docx");d.Packer.toBuffer(new d.Document({sections:[{children:[new d.Paragraph("hi")]}]})).then(b=>require("fs").writeFileSync("out.docx",b))'`,
          `${NODE} -e 'const P=require("pptxgenjs");const p=new P();p.addSlide().addText("hi",{x:1,y:1});p.writeFile({fileName:"out.pptx"})'`,
        ].join(' && '),
      );
      expect(result).toContain('"output_path": "out.xlsx"');
      expect(result).toContain('"delimiter": ";"');
      for (const file of ['out.xlsx', 'imported.xlsx', 'out.docx', 'out.pptx']) {
        expect(
          fs.statSync(path.join(workspaceDir, file)).size,
          file,
        ).toBeGreaterThan(0);
      }
    },
    TURN_TIMEOUT_MS + 300_000,
  );
});
