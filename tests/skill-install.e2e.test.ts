import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ChatMessage } from '../container/src/types.js';
import {
  cleanupStaleContainers,
  dockerBridgeGateway,
  dockerE2eGate,
  getAvailablePort,
  removeContainer,
  startContainer,
  waitForHealth,
} from './helpers/docker-test-setup.js';
import {
  type ModelRequestBody,
  startScriptedModelServer,
} from './helpers/scripted-model-server.js';
import { writeZipArchive } from './helpers/zip-archive.js';

/**
 * Every way a skill gets into the gateway image, checked end to end: after
 * install the skill is listed, an agent with a `skills` allowlist reads it in
 * a real turn, it survives a restart (which re-runs the agent config sync),
 * and it can be removed for good. Turns run against a scripted
 * OpenAI-compatible model on the test host; GitHub is served from fixtures by
 * a fetch preload, so nothing leaves the machine.
 */

const { image: IMAGE, enabled: DOCKER_E2E } = dockerE2eGate(
  'HYBRIDCLAW_E2E_IMAGE',
);

// Prefix must not share a stem with the other gateway suites: their stale
// container cleanup matches by name prefix and suites run concurrently.
const SUITE_PREFIX = 'skills';
const CONTAINER_NAME = `hc-e2e-${SUITE_PREFIX}-${process.pid}`;
const WEB_API_TOKEN = 'e2e-test-token';
const STARTUP_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = 60_000;
const FIXTURES = '/e2e';
const MODEL_ID = 'scripted';
const WEB_SESSION = 'e2e-skill-install-web';
const INSTALL_ZIP_PROMPT = 'Install the attached skill ZIP.';
const GITHUB_REPO = 'e2e-owner/e2e-skills';

// `main` has no allowlist; the others only see the skills listed here.
const WRITER_AGENT = 'writer';
const EDITOR_AGENT = 'editor';
const SOLO_AGENT = 'solo';
const CLAW_AGENT = 'e2e-claw-agent';

interface InstallPath {
  label: string;
  skill: string;
  agentId: string;
  install: () => Promise<void>;
  remove: () => Promise<void>;
  /** Install is broken on main; the linked issue tracks the fix. */
  knownIssue?: string;
}

let gatewayUrl: string;
let modelServer: http.Server | undefined;
let modelRequests: ModelRequestBody[] = [];
let workDir: string;
/** Paths whose install step passed; later steps skip the others. */
const installed = new Set<string>();

interface SkillFixtureOptions {
  /** Extra frontmatter lines, e.g. dependency install specs. */
  frontmatter?: string[];
  /**
   * Leave out the unquoted `: ` in the description. One path keeps this
   * control so a frontmatter parsing regression shows as that path passing
   * while the others fail, not as every path failing alike.
   */
  plainDescription?: boolean;
}

function skillFiles(
  name: string,
  { frontmatter = [], plainDescription = false }: SkillFixtureOptions = {},
): Record<string, string> {
  return {
    'SKILL.md': [
      '---',
      `name: ${name}`,
      plainDescription
        ? 'description: Write in the house voice for customer-facing text.'
        : // Unquoted `: ` in the value, as skills written for other runtimes
          // commonly have it.
          'description: Write in the house voice. Use for customer-facing text: landing pages, release notes.',
      ...frontmatter,
      '---',
      '',
      `Follow the ${name} steps.`,
      '',
    ].join('\n'),
    // skill-creator output ships its evals next to SKILL.md.
    'evals/evals.json': `${JSON.stringify({ skill_name: name, evals: [] })}\n`,
  };
}

function writeSkillDir(
  dir: string,
  name: string,
  options?: SkillFixtureOptions,
): void {
  for (const [file, content] of Object.entries(skillFiles(name, options))) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
}

/** A ZIP packed the usual way, `zip -r name.zip name/`. */
async function skillZip(name: string): Promise<Buffer> {
  const zipPath = path.join(workDir, `${name}.zip`);
  await writeZipArchive(
    zipPath,
    Object.entries(skillFiles(name)).map(([file, content]) => ({
      name: `${name}/${file}`,
      content,
    })),
  );
  return fs.readFileSync(zipPath);
}

// ── Scripted model ────────────────────────────────────────────────────────

let toolCallCount = 0;

function messageText(message: ChatMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => ('text' in part && part.text ? part.text : ''))
    .join('\n');
}

function toolCall(name: string, args: Record<string, unknown>) {
  toolCallCount += 1;
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: `call_${toolCallCount}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

/** Calls `name` directly when exposed, else through the tool catalog. */
function exposedToolCall(
  body: ModelRequestBody,
  name: string,
  args: Record<string, unknown>,
) {
  return body.tools.some((tool) => tool.function.name === name)
    ? toolCall(name, args)
    : toolCall('tool_catalog', { action: 'call', name, arguments: args });
}

function nextCallFromToolResult(
  content: string,
): { name: string; arguments: Record<string, unknown> } | null {
  try {
    const { next } = JSON.parse(content) as {
      next?: { name?: unknown; arguments?: Record<string, unknown> };
    };
    return typeof next?.name === 'string'
      ? { name: next.name, arguments: next.arguments ?? {} }
      : null;
  } catch {
    return null;
  }
}

/**
 * Does what a model would for the two prompts this suite sends: "Use skill
 * <name>." discovers the skill with skills_list and follows its next call to
 * read SKILL.md; the ZIP prompt runs the guarded import that the bundled
 * skill-creator skill prescribes. The final answer echoes the last tool
 * result, so the test sees what the agent saw.
 */
function scriptedAgent(body: ModelRequestBody): Record<string, unknown> {
  const last = body.messages.at(-1);
  if (!body.tools?.length || !last) return { role: 'assistant', content: 'ok' };
  if (last.role === 'tool') {
    const result = messageText(last);
    const next = nextCallFromToolResult(result);
    return next
      ? toolCall(next.name, next.arguments)
      : { role: 'assistant', content: result };
  }
  const prompt = messageText(last);
  const zipPath = /(\/\S+\.zip)\b/.exec(prompt)?.[1];
  if (prompt.includes(INSTALL_ZIP_PROMPT) && zipPath) {
    return exposedToolCall(body, 'bash', {
      command: `hybridclaw skill import ${zipPath}`,
    });
  }
  const skill = /Use skill (\S+?)\./.exec(prompt)?.[1];
  return skill
    ? exposedToolCall(body, 'skills_list', { name: skill })
    : { role: 'assistant', content: 'ok' };
}

// ── Gateway access ────────────────────────────────────────────────────────

async function api(
  pathname: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> },
  timeoutMs = 15_000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = Buffer.isBuffer(init.body);
  const res = await fetch(`${gatewayUrl}${pathname}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${WEB_API_TOKEN}`,
      ...(raw ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
    body:
      init.body === undefined
        ? undefined
        : raw
          ? new Uint8Array(init.body as Buffer)
          : JSON.stringify(init.body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** A slash command as the web chat sends it. */
async function slashCommand(
  args: string[],
  sessionId = WEB_SESSION,
): Promise<string> {
  const { status, body } = await api('/api/command', {
    method: 'POST',
    body: { sessionId, channelId: 'web', args },
  });
  expect(status, JSON.stringify(body)).toBe(200);
  expect(body.kind, JSON.stringify(body)).not.toBe('error');
  return String(body.text);
}

async function chat(params: {
  agentId: string;
  content: string;
  media?: unknown[];
}): Promise<string> {
  const { status, body } = await api(
    '/api/chat',
    {
      method: 'POST',
      body: {
        sessionId: `${WEB_SESSION}-${params.agentId}`,
        agentId: params.agentId,
        content: params.content,
        ...(params.media ? { media: params.media } : {}),
      },
    },
    TURN_TIMEOUT_MS,
  );
  expect(status, JSON.stringify(body)).toBe(200);
  expect(body.status, JSON.stringify(body)).toBe('success');
  return String(body.result ?? '');
}

/** Runs a turn in which the agent looks the skill up and reads it. */
function useSkill(agentId: string, skill: string): Promise<string> {
  return chat({ agentId, content: `Use skill ${skill}.` });
}

/** The CLI inside the image, as an operator runs it. */
function cli(args: string[]): { ok: boolean; output: string } {
  try {
    return {
      ok: true,
      output: execFileSync(
        'docker',
        ['exec', CONTAINER_NAME, 'hybridclaw', ...args],
        { encoding: 'utf-8', timeout: 60_000, stdio: 'pipe' },
      ),
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function expectCliOk(args: string[]): string {
  const result = cli(args);
  expect(result.ok, result.output).toBe(true);
  return result.output;
}

async function adminSkill(
  name: string,
): Promise<Record<string, unknown> | undefined> {
  const { body } = await api('/api/admin/skills', {});
  return (body.skills as Array<Record<string, unknown>>).find(
    (skill) => skill.name === name,
  );
}

async function restartGateway(): Promise<void> {
  execFileSync('docker', ['restart', CONTAINER_NAME], {
    stdio: 'pipe',
    timeout: 60_000,
  });
  await waitForHealth(`${gatewayUrl}/health`, STARTUP_TIMEOUT_MS);
}

async function expectInstalled(skill: string, agentId: string): Promise<void> {
  expect(expectCliOk(['skill', 'list'])).toContain(`${skill} [enabled]`);
  expect(await adminSkill(skill)).toMatchObject({
    available: true,
    enabled: true,
  });
  // The reply echoes the SKILL.md the agent read after discovering it.
  expect(await useSkill(agentId, skill)).toContain(`name: ${skill}`);
}

/** Tool results the model received after the latest user message. */
function latestTurnToolResults(): string[] {
  const messages = modelRequests.at(-1)?.messages ?? [];
  const turnStart = messages.map((message) => message.role).lastIndexOf('user');
  return messages
    .slice(turnStart + 1)
    .filter((message) => message.role === 'tool')
    .map(messageText);
}

function skillFoundByLookup(toolResult: string): string | undefined {
  try {
    const { skill } = JSON.parse(toolResult) as { skill?: { name?: string } };
    return skill?.name;
  } catch {
    return undefined;
  }
}

async function expectRemoved(skill: string, agentId: string): Promise<void> {
  expect(expectCliOk(['skill', 'list'])).not.toContain(`${skill} [`);
  expect(await adminSkill(skill)).toBeUndefined();
  await useSkill(agentId, skill);
  // The agent looked the skill up in this turn, and the lookup missed.
  const results = latestTurnToolResults();
  expect(results.length).toBeGreaterThan(0);
  expect(results.map(skillFoundByLookup)).not.toContain(skill);
}

function uninstallSkill(name: string): Promise<string> {
  return slashCommand(['skill', 'uninstall', name]);
}

// ── Install paths ─────────────────────────────────────────────────────────

const INSTALL_PATHS: InstallPath[] = [
  {
    label: '/skill import official/<name>',
    skill: 'competitor-monitoring',
    agentId: WRITER_AGENT,
    knownIssue: 'https://github.com/HybridAIOne/hybridclaw/issues/1681',
    install: async () => {
      await slashCommand(['skill', 'import', 'official/competitor-monitoring']);
    },
    remove: async () => {
      await uninstallSkill('competitor-monitoring');
    },
  },
  {
    label: '/skill import <owner>/<repo>/<path> from GitHub',
    skill: 'e2e-github',
    agentId: WRITER_AGENT,
    install: async () => {
      await slashCommand([
        'skill',
        'import',
        `${GITHUB_REPO}/skills/e2e-github`,
      ]);
    },
    remove: async () => {
      await uninstallSkill('e2e-github');
    },
  },
  {
    // What a host runs to provision a fresh instance: no prior chat session.
    label: 'POST /api/command skill import, headless',
    skill: 'e2e-headless',
    agentId: WRITER_AGENT,
    install: async () => {
      await slashCommand(
        ['skill', 'import', `${FIXTURES}/skills/e2e-headless`],
        'e2e-provisioning',
      );
    },
    remove: async () => {
      await uninstallSkill('e2e-headless');
    },
  },
  {
    label: 'admin Skills ZIP upload, with and without force',
    skill: 'e2e-upload',
    agentId: WRITER_AGENT,
    install: async () => {
      const zip = await skillZip('e2e-upload');
      const upload = (query: string) =>
        api(`/api/admin/skills/upload${query}`, {
          method: 'POST',
          body: zip,
          headers: { 'Content-Type': 'application/zip' },
        });
      const first = await upload('');
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const again = await upload('');
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      const forced = await upload('?force=true');
      expect(forced.status, JSON.stringify(forced.body)).toBe(201);
    },
    remove: async () => {
      await uninstallSkill('e2e-upload');
    },
  },
  {
    label: 'skill ZIP attached in chat, installed by the agent',
    skill: 'e2e-chat-zip',
    agentId: WRITER_AGENT,
    install: async () => {
      const { status, body } = await api('/api/media/upload', {
        method: 'POST',
        body: await skillZip('e2e-chat-zip'),
        headers: {
          'Content-Type': 'application/zip',
          'X-Hybridclaw-Filename': 'e2e-chat-zip.zip',
        },
      });
      expect(status, JSON.stringify(body)).toBe(200);
      const reply = await chat({
        agentId: WRITER_AGENT,
        content: INSTALL_ZIP_PROMPT,
        media: [body.media],
      });
      expect(reply).toContain('Imported e2e-chat-zip');
    },
    remove: async () => {
      await uninstallSkill('e2e-chat-zip');
    },
  },
  {
    label: '.claw package install',
    skill: 'e2e-claw',
    agentId: CLAW_AGENT,
    install: async () => {
      expectCliOk(['agent', 'install', `${FIXTURES}/agent.claw`, '--yes']);
    },
    remove: async () => {
      expectCliOk(['agent', 'uninstall', CLAW_AGENT, '--yes']);
    },
  },
];

const WORKING_PATHS = INSTALL_PATHS.filter((entry) => !entry.knownIssue);

/** The .claw agent is removed with its skill; `main` has no allowlist. */
function expectPathRemoved({ skill, agentId }: InstallPath): Promise<void> {
  return expectRemoved(skill, agentId === CLAW_AGENT ? 'main' : agentId);
}

async function writeFixtures(modelPort: number): Promise<void> {
  const fixtures = path.join(workDir, 'e2e');
  writeSkillDir(
    path.join(fixtures, 'github', GITHUB_REPO, 'skills', 'e2e-github'),
    'e2e-github',
  );
  writeSkillDir(path.join(fixtures, 'skills', 'e2e-headless'), 'e2e-headless', {
    plainDescription: true,
  });
  for (const name of ['e2e-after-claw', 'e2e-solo', 'e2e-admin-allowlist']) {
    writeSkillDir(path.join(fixtures, 'skills', name), name);
  }
  writeSkillDir(path.join(fixtures, 'skills', 'e2e-deps'), 'e2e-deps', {
    frontmatter: [
      'metadata:',
      '  hybridclaw:',
      '    install:',
      '      - id: tool',
      '        kind: brew',
      '        formula: e2e-tool',
      '        bins: ["e2e-tool"]',
      '      - id: runtime',
      '        kind: node',
      '        package: e2e-runtime',
      '        bins: ["node"]',
    ],
  });
  fs.copyFileSync(
    path.join(import.meta.dirname, 'fixtures', 'fake-github-fetch.mjs'),
    path.join(fixtures, 'fake-github-fetch.mjs'),
  );
  await writeZipArchive(path.join(fixtures, 'agent.claw'), [
    {
      name: 'manifest.json',
      content: JSON.stringify({
        formatVersion: 1,
        name: 'E2E Claw Agent',
        id: CLAW_AGENT,
        agent: { skills: ['e2e-claw', 'e2e-after-claw'] },
        skills: { bundled: ['e2e-claw'] },
      }),
    },
    { name: 'workspace/SOUL.md', content: '# Soul\n' },
    ...Object.entries(skillFiles('e2e-claw')).map(([file, content]) => ({
      name: `skills/e2e-claw/${file}`,
      content,
    })),
  ]);
  const writerSkills = INSTALL_PATHS.filter(
    (entry) => entry.agentId === WRITER_AGENT,
  ).map((entry) => entry.skill);
  fs.writeFileSync(
    path.join(workDir, 'config.json'),
    JSON.stringify({
      local: {
        backends: {
          vllm: {
            enabled: true,
            baseUrl: `http://host.docker.internal:${modelPort}/v1`,
          },
        },
      },
      agents: {
        defaults: { model: `vllm/${MODEL_ID}` },
        list: [
          { id: 'main' },
          // A bundled skill keeps the writer from running out of allowlisted
          // skills while the paths are removed one by one; running out is
          // covered on its own below.
          { id: WRITER_AGENT, skills: [...writerSkills, 'current-time'] },
          { id: EDITOR_AGENT, skills: [] },
          { id: SOLO_AGENT, skills: ['e2e-solo'] },
        ],
      },
    }),
  );
}

/**
 * The container reaches the model as `host.docker.internal` (host-gateway).
 * On a native Linux daemon that is the default bridge's gateway, so listen
 * there rather than on every interface. Docker Desktop forwards the name to
 * the host's loopback instead, and the bridge address is not bindable there.
 */
async function startModelServerForContainers() {
  try {
    return await startScriptedModelServer(scriptedAgent, {
      host: dockerBridgeGateway(),
      model: MODEL_ID,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRNOTAVAIL') throw error;
    return startScriptedModelServer(scriptedAgent, { model: MODEL_ID });
  }
}

describe.skipIf(!DOCKER_E2E)(
  'gateway image skill install paths',
  { timeout: TURN_TIMEOUT_MS * 2 },
  () => {
    beforeAll(async () => {
      cleanupStaleContainers(SUITE_PREFIX);
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-skill-e2e-'));
      const model = await startModelServerForContainers();
      modelServer = model.server;
      modelRequests = model.requests;
      await writeFixtures(model.port);

      const hostPort = await getAvailablePort();
      gatewayUrl = `http://127.0.0.1:${hostPort}`;
      startContainer({
        image: IMAGE,
        name: CONTAINER_NAME,
        port: { host: hostPort, container: 9090 },
        hosts: { 'host.docker.internal': 'host-gateway' },
        env: {
          HYBRIDCLAW_ACCEPT_TRUST: 'true',
          HEALTH_HOST: '0.0.0.0',
          HYBRIDAI_API_KEY: 'hai-ci-placeholder-not-a-real-key',
          WEB_API_TOKEN,
          NODE_OPTIONS: `--import=${FIXTURES}/fake-github-fetch.mjs`,
          HYBRIDCLAW_E2E_FAKE_GITHUB_ROOT: `${FIXTURES}/github`,
        },
        copy: {
          [path.join(workDir, 'e2e')]: FIXTURES,
          [path.join(workDir, 'config.json')]: '/workspace/.data/config.json',
        },
      });
      try {
        await waitForHealth(`${gatewayUrl}/health`, STARTUP_TIMEOUT_MS);
      } catch (err) {
        console.error(
          '--- gateway container logs ---\n',
          execFileSync('docker', ['logs', CONTAINER_NAME], {
            encoding: 'utf-8',
          }),
        );
        throw err;
      }
    }, STARTUP_TIMEOUT_MS + 30_000);

    afterAll(async () => {
      removeContainer(CONTAINER_NAME);
      const server = modelServer;
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    });

    describe('install', () => {
      for (const entry of INSTALL_PATHS) {
        // A known-broken path stops here; its later checks would only
        // restate the install failure.
        (entry.knownIssue ? test.fails : test)(entry.label, async () => {
          await entry.install();
          installed.add(entry.label);
        });
      }
    });

    // A path whose install failed skips its later steps, so one broken
    // path reads as one failure instead of one per step.
    describe('listed and used by an allowlisted agent', () => {
      test.for(WORKING_PATHS)('$label', (entry, { skip }) => {
        skip(!installed.has(entry.label), 'install failed');
        return expectInstalled(entry.skill, entry.agentId);
      });
    });

    describe('after a gateway restart and agent config sync', () => {
      beforeAll(restartGateway, STARTUP_TIMEOUT_MS + 30_000);
      test.for(WORKING_PATHS)('$label', (entry, { skip }) => {
        skip(!installed.has(entry.label), 'install failed');
        return expectInstalled(entry.skill, entry.agentId);
      });
    });

    // https://github.com/HybridAIOne/hybridclaw/issues/1662: a .claw install
    // adds the agent's synced workspace skills dir to global extraDirs.
    describe('a skill synced into a .claw agent workspace', () => {
      test('is used by the .claw agent, then uninstalled', async () => {
        await slashCommand([
          'skill',
          'import',
          `${FIXTURES}/skills/e2e-after-claw`,
        ]);
        await expectInstalled('e2e-after-claw', CLAW_AGENT);
        await uninstallSkill('e2e-after-claw');
      });

      test.fails('stays removed', () =>
        expectRemoved('e2e-after-claw', CLAW_AGENT));
    });

    describe('removal', () => {
      test.for(WORKING_PATHS)('$label', async (entry, { skip }) => {
        skip(!installed.has(entry.label), 'install failed');
        await entry.remove();
        await expectPathRemoved(entry);
      });
    });

    describe('stays removed after a gateway restart', () => {
      beforeAll(restartGateway, STARTUP_TIMEOUT_MS + 30_000);
      test.for(WORKING_PATHS)('$label', (entry, { skip }) => {
        skip(!installed.has(entry.label), 'install failed');
        return expectPathRemoved(entry);
      });
    });

    // https://github.com/HybridAIOne/hybridclaw/issues/1682
    describe("an allowlisted agent's only skill", () => {
      test('is used, then uninstalled', async () => {
        await slashCommand(['skill', 'import', `${FIXTURES}/skills/e2e-solo`]);
        await expectInstalled('e2e-solo', SOLO_AGENT);
        await uninstallSkill('e2e-solo');
        await expectRemoved('e2e-solo', SOLO_AGENT);
      });

      test('stays removed', () => expectRemoved('e2e-solo', SOLO_AGENT));
    });

    // https://github.com/HybridAIOne/hybridclaw/issues/1661: admin agent
    // edits write the registry only; config.json wins on the next sync.
    describe('a skill added to an allowlist in the admin console', () => {
      test('is used by the agent', async () => {
        await slashCommand([
          'skill',
          'import',
          `${FIXTURES}/skills/e2e-admin-allowlist`,
        ]);
        const { status, body } = await api(
          `/api/admin/agents/${EDITOR_AGENT}`,
          {
            method: 'PUT',
            body: { skills: ['e2e-admin-allowlist'] },
          },
        );
        expect(status, JSON.stringify(body)).toBe(200);
        await expectInstalled('e2e-admin-allowlist', EDITOR_AGENT);
      });

      describe('after a gateway restart', () => {
        beforeAll(restartGateway, STARTUP_TIMEOUT_MS + 30_000);
        test.fails('is still used by the agent', () =>
          expectInstalled('e2e-admin-allowlist', EDITOR_AGENT));
      });
    });

    describe('hybridclaw skill install <skill> <dependency>', () => {
      beforeAll(() => {
        expectCliOk(['skill', 'import', `${FIXTURES}/skills/e2e-deps`]);
      });

      test('lists the declared installers', () => {
        expect(expectCliOk(['skill', 'list'])).toMatch(
          /e2e-deps \[enabled\]\n\s+↳ installs: tool \(brew\)\n\s+↳ installs: runtime \(node\)/,
        );
      });

      test('reports a satisfied dependency as installed', () => {
        expect(
          expectCliOk(['skill', 'install', 'e2e-deps', 'runtime']),
        ).toContain('Already installed e2e-deps dependency runtime');
      });

      test('names the missing installer on a platform without it', () => {
        const result = cli(['skill', 'install', 'e2e-deps', 'tool']);
        expect(result.ok).toBe(false);
        expect(result.output).toContain('No available installer');
        expect(result.output).toContain('(brew)');
        expect(result.output).not.toContain('ENOENT');
      });
    });
  },
);
