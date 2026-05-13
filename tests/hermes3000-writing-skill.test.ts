import {
  execFile as execFileWithCallback,
  spawnSync,
} from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'hermes3000-writing',
  'scripts',
  'hermes3000.cjs',
);
const skillPath = path.join(
  process.cwd(),
  'skills',
  'hermes3000-writing',
  'SKILL.md',
);
const execFile = promisify(execFileWithCallback);

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

async function withMockGateway(
  run: (gatewayUrl: string, captured: unknown[]) => Promise<void>,
  gatewayResponse: Record<string, unknown> = {
    ok: true,
    status: 200,
    captured: {
      token: 'HERMES3000_JWT',
    },
  },
) {
  const captured: unknown[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      captured.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(gatewayResponse));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Expected TCP server address.');
  }
  try {
    await run(`http://127.0.0.1:${address.port}`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Hermes3000 skill declares the stored JWT credential', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, {
    name: 'hermes3000-writing',
  });

  expect(manifest.credentials).toEqual([
    expect.objectContaining({
      id: 'hermes3000-jwt',
      kind: 'bearer',
      required: false,
      secretRef: {
        source: 'store',
        id: 'HERMES3000_JWT',
      },
      scope: 'hermes3000.ai',
    }),
  ]);
});

test('Hermes3000 skill keeps terminal commands agent-side for cloud users', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');

  expect(skill).toContain('Cloud and chat/TUI users may not have a terminal');
  expect(skill).toContain('Then the agent, not the user, captures the JWT');
  expect(skill).toContain('Do not show it to chat/TUI users');
  expect(skill).toContain('/secret set HERMES3000_EMAIL');
  expect(skill).toContain('/secret set HERMES3000_PASSWORD');
});

test('Hermes3000 helper emits login capture request without raw credentials', () => {
  const result = runHelper(['--format', 'json', 'http-request', 'auth.login']);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    command: 'http-request',
    adapter: 'hermes3000',
    operation: 'auth.login',
    httpRequest: {
      url: 'https://hermes3000.ai/api/auth/login',
      method: 'POST',
      skillName: 'hermes3000-writing',
      json: {
        email: '<secret:HERMES3000_EMAIL>',
        password: '<secret:HERMES3000_PASSWORD>',
      },
      replaceSecretPlaceholders: true,
      captureResponseFields: [
        { jsonPath: 'token', secretName: 'HERMES3000_JWT' },
      ],
    },
  });
  expect(result.stdout).not.toContain('Bearer ');
});

test('Hermes3000 helper run mode proxies login through gateway without raw credentials', async () => {
  await withMockGateway(async (gatewayUrl, captured) => {
    const result = await execFile(
      'node',
      [
        helperPath,
        '--format',
        'json',
        '--gateway-url',
        gatewayUrl,
        '--gateway-token',
        'gateway-token',
        'run',
        'auth.login',
      ],
      { encoding: 'utf-8' },
    );

    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      status: 200,
      captured: {
        token: 'HERMES3000_JWT',
      },
    });
    expect(result.stdout).not.toContain('Bearer ');
    expect(captured).toEqual([
      expect.objectContaining({
        url: 'https://hermes3000.ai/api/auth/login',
        method: 'POST',
        json: {
          email: '<secret:HERMES3000_EMAIL>',
          password: '<secret:HERMES3000_PASSWORD>',
        },
        replaceSecretPlaceholders: true,
        captureResponseFields: [
          { jsonPath: 'token', secretName: 'HERMES3000_JWT' },
        ],
      }),
    ]);
  });
});

test('Hermes3000 helper run mode refuses uncaptured login tokens', async () => {
  await withMockGateway(
    async (gatewayUrl) => {
      try {
        await execFile(
          'node',
          [
            helperPath,
            '--format',
            'json',
            '--gateway-url',
            gatewayUrl,
            'run',
            'auth.login',
          ],
          { encoding: 'utf-8' },
        );
        throw new Error(
          'Expected helper to fail when auth token is uncaptured.',
        );
      } catch (error) {
        expect(error).toMatchObject({
          stdout: '',
          stderr: expect.stringContaining(
            'Gateway did not capture token into HERMES3000_JWT.',
          ),
        });
        expect(String(error)).not.toContain('raw-token-that-must-not-print');
      }
    },
    {
      ok: true,
      status: 200,
      json: {
        token: 'raw-token-that-must-not-print',
      },
    },
  );
});

test('Hermes3000 helper emits authenticated create-book request', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'books.create',
    '--title',
    'Draft',
    '--book-type',
    'whitepaper',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    url: 'https://hermes3000.ai/api/books',
    method: 'POST',
    bearerSecretName: 'HERMES3000_JWT',
    json: {
      title: 'Draft',
      bookType: 'whitepaper',
    },
  });
});

test('Hermes3000 helper saves chapter structures as parsed JSON', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'structure.put',
    '--book-id',
    '42',
    '--structure-type',
    'chapters',
    '--content-json',
    '[{"id":"550e8400-e29b-41d4-a716-446655440000","title":"Chapter 1","summary":"Opening."}]',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    url: 'https://hermes3000.ai/api/books/42/structure',
    method: 'PUT',
    bearerSecretName: 'HERMES3000_JWT',
    json: {
      structureType: 'chapters',
      content: [
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          title: 'Chapter 1',
          summary: 'Opening.',
        },
      ],
    },
  });
});
