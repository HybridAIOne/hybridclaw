import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
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
