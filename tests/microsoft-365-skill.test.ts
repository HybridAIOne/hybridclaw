import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'microsoft-365',
  'm365.cjs',
);
const skillPath = path.join(
  process.cwd(),
  'skills',
  'microsoft-365',
  'SKILL.md',
);

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

test('Microsoft 365 skill manifest declares read-only Graph OAuth setup', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');

  expect(skill).toContain('name: microsoft-365');
  expect(skill).toContain('category: productivity');
  expect(skill).toContain('MICROSOFT_365_ACCESS_TOKEN');
  expect(skill).toContain('hybridclaw auth login microsoft365');
  expect(skill).toContain('graph.microsoft.com');
  expect(skill).toContain('read-only');
  expect(skill).toContain('writes: unsupported');
  expect(skill).toContain('UsageTotals');
});

test('Microsoft 365 helper --help exits cleanly', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Microsoft 365 skill helper');
  expect(result.stdout).toContain('mail recent');
  expect(result.stdout).toContain('calendar events');
  expect(result.stdout).toContain('teams messages');
});

test('Microsoft 365 helper builds profile and mail requests with bearer secret ref', () => {
  const profile = runHelper(['--format', 'json', 'http-request', 'me']);
  const mail = runHelper([
    '--format',
    'json',
    'http-request',
    'mail',
    'recent',
    '--top',
    '5',
  ]);

  expect(profile.status).toBe(0);
  expect(mail.status).toBe(0);
  expect(JSON.parse(profile.stdout).httpRequest).toMatchObject({
    method: 'GET',
    url: expect.stringContaining('https://graph.microsoft.com/v1.0/me?'),
    bearerSecretName: 'MICROSOFT_365_ACCESS_TOKEN',
    skillName: 'microsoft-365',
  });
  expect(JSON.parse(mail.stdout).httpRequest).toMatchObject({
    method: 'GET',
    url: expect.stringContaining('/me/messages?'),
    bearerSecretName: 'MICROSOFT_365_ACCESS_TOKEN',
  });
  expect(JSON.parse(mail.stdout).httpRequest.url).toContain('%24top=5');
});

test('Microsoft 365 helper builds calendar, drive, and Teams requests', () => {
  const calendar = runHelper([
    '--format',
    'json',
    'http-request',
    'calendar',
    'events',
    '--start',
    '2026-06-26T00:00:00Z',
    '--end',
    '2026-06-27T00:00:00Z',
    '--timezone',
    'Europe/Berlin',
  ]);
  const drive = runHelper([
    '--format',
    'json',
    'http-request',
    'drive',
    'search',
    '--query',
    'quarterly plan',
  ]);
  const teams = runHelper([
    '--format',
    'json',
    'http-request',
    'teams',
    'messages',
    '--team-id',
    'team id',
    '--channel-id',
    'channel id',
    '--top',
    '3',
  ]);

  expect(calendar.status).toBe(0);
  expect(drive.status).toBe(0);
  expect(teams.status).toBe(0);
  expect(JSON.parse(calendar.stdout).httpRequest).toMatchObject({
    headers: expect.objectContaining({
      Prefer: 'outlook.timezone="Europe/Berlin"',
    }),
  });
  expect(JSON.parse(calendar.stdout).httpRequest.url).toContain(
    '/me/calendarView?',
  );
  expect(JSON.parse(drive.stdout).httpRequest.url).toContain(
    "/me/drive/root/search(q='quarterly%20plan')?",
  );
  expect(JSON.parse(teams.stdout).httpRequest.url).toContain(
    '/teams/team%20id/channels/channel%20id/messages?',
  );
  expect(JSON.parse(teams.stdout).httpRequest.url).toContain('%24top=3');
});

test('Microsoft 365 helper rejects unknown write-like commands', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'mail',
    'send',
  ]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Unknown Microsoft 365 http-request command');
});
