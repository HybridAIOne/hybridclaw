import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

const skillRoot = path.join(process.cwd(), 'skills');

const skills = [
  {
    name: 'hetzner-cloud',
    helper: 'hetzner_cloud.cjs',
    expectedHelp: ['list-servers', 'create-server', 'restore-snapshot'],
  },
  {
    name: 'hetzner-dns',
    helper: 'hetzner_dns.cjs',
    expectedHelp: ['list-zones', 'create-rrset', 'delete-record'],
  },
  {
    name: 'hetzner-storage-box',
    helper: 'hetzner_storage_box.cjs',
    expectedHelp: ['list-storage-boxes', 'share-public-link', 'delete-path'],
  },
];

function helperPath(skillName: string, helper: string) {
  return path.join(skillRoot, skillName, helper);
}

function runHelper(skillName: string, helper: string, args: string[]) {
  return spawnSync('node', [helperPath(skillName, helper), ...args], {
    encoding: 'utf-8',
  });
}

test('Hetzner skill manifests declare infrastructure metadata and secret refs', () => {
  for (const skill of skills) {
    const raw = fs.readFileSync(
      path.join(skillRoot, skill.name, 'SKILL.md'),
      'utf-8',
    );

    expect(raw).toContain(`name: ${skill.name}`);
    expect(raw).toContain('category: infrastructure');
    expect(raw).toContain('HETZNER_API_TOKEN');
    expect(raw).toContain('stakes_tiers:');
    expect(raw).toContain('confirm-each');
    expect(raw).toContain('UsageTotals');
  }

  const storage = fs.readFileSync(
    path.join(skillRoot, 'hetzner-storage-box', 'SKILL.md'),
    'utf-8',
  );
  expect(storage).toContain('HETZNER_STORAGE_BOX_BASIC_AUTH');
  expect(storage).toContain('WebDAV file operations');
});

test('Hetzner helpers expose expected commands', () => {
  for (const skill of skills) {
    const result = runHelper(skill.name, skill.helper, ['--help']);

    expect(result.status).toBe(0);
    for (const expected of skill.expectedHelp) {
      expect(result.stdout).toContain(expected);
    }
  }
});

test('Hetzner Cloud helper emits gateway-backed reads and guarded writes', () => {
  const read = runHelper('hetzner-cloud', 'hetzner_cloud.cjs', [
    '--format',
    'json',
    'http-request',
    'list-servers',
    '--label-selector',
    'project=acme',
  ]);
  const writeWithoutGrant = runHelper('hetzner-cloud', 'hetzner_cloud.cjs', [
    '--format',
    'json',
    'http-request',
    'delete-server',
    '--server-id',
    '123456',
  ]);
  const writeWithGrant = runHelper('hetzner-cloud', 'hetzner_cloud.cjs', [
    '--format',
    'json',
    'http-request',
    'create-server',
    '--name',
    'acme-demo',
    '--server-type',
    'cax11',
    '--image',
    'ubuntu-24.04',
    '--location',
    'fsn1',
    '--label',
    'project=acme',
    '--operator-grant',
  ]);
  const restoreSnapshot = runHelper('hetzner-cloud', 'hetzner_cloud.cjs', [
    '--format',
    'json',
    'http-request',
    'restore-snapshot',
    '--server-id',
    '123456',
    '--snapshot-id',
    '987654',
    '--operator-grant',
  ]);
  const attachNetwork = runHelper('hetzner-cloud', 'hetzner_cloud.cjs', [
    '--format',
    'json',
    'http-request',
    'attach-network',
    '--server-id',
    '123456',
    '--network-id',
    '555',
    '--ip',
    '10.0.0.12',
    '--operator-grant',
  ]);

  expect(read.status).toBe(0);
  expect(JSON.parse(read.stdout).httpRequest).toMatchObject({
    method: 'GET',
    bearerSecretName: 'HETZNER_API_TOKEN',
    skillName: 'hetzner-cloud',
  });
  expect(JSON.parse(read.stdout).httpRequest.url).toContain(
    'https://api.hetzner.cloud/v1/servers?',
  );
  expect(writeWithoutGrant.status).not.toBe(0);
  expect(writeWithoutGrant.stderr).toContain('--operator-grant');
  expect(writeWithGrant.status).toBe(0);
  expect(JSON.parse(writeWithGrant.stdout).httpRequest).toMatchObject({
    method: 'POST',
    url: 'https://api.hetzner.cloud/v1/servers',
    json: {
      name: 'acme-demo',
      server_type: 'cax11',
      image: 'ubuntu-24.04',
      location: 'fsn1',
      labels: { project: 'acme' },
    },
  });
  expect(restoreSnapshot.status).toBe(0);
  expect(JSON.parse(restoreSnapshot.stdout)).toMatchObject({
    operation: 'restore-snapshot',
    stakesTier: 'red',
    httpRequest: {
      method: 'POST',
      url: 'https://api.hetzner.cloud/v1/servers/123456/actions/rebuild',
      json: { image: 987654 },
    },
  });
  expect(attachNetwork.status).toBe(0);
  expect(JSON.parse(attachNetwork.stdout).httpRequest).toMatchObject({
    method: 'POST',
    url: 'https://api.hetzner.cloud/v1/servers/123456/actions/attach_to_network',
    json: { network: 555, ip: '10.0.0.12' },
  });
});

test('Hetzner DNS helper builds RRset requests and protects deletes', () => {
  const create = runHelper('hetzner-dns', 'hetzner_dns.cjs', [
    '--format',
    'json',
    'http-request',
    'create-rrset',
    '--zone',
    'example.com',
    '--name',
    'demo',
    '--type',
    'A',
    '--ttl',
    '300',
    '--record',
    '203.0.113.10',
    '--comment',
    'customer demo',
    '--operator-grant',
  ]);
  const deleteWithoutGrant = runHelper('hetzner-dns', 'hetzner_dns.cjs', [
    '--format',
    'json',
    'http-request',
    'delete-record',
    '--zone',
    'example.com',
    '--name',
    'demo',
    '--type',
    'A',
  ]);

  expect(create.status).toBe(0);
  const payload = JSON.parse(create.stdout);
  expect(payload.httpRequest).toMatchObject({
    method: 'POST',
    url: 'https://api.hetzner.cloud/v1/zones/example.com/rrsets',
    bearerSecretName: 'HETZNER_API_TOKEN',
    skillName: 'hetzner-dns',
  });
  expect(payload.httpRequest.json).toMatchObject({
    name: 'demo',
    type: 'A',
    ttl: 300,
    records: [{ value: '203.0.113.10', comment: 'customer demo' }],
  });
  expect(deleteWithoutGrant.status).not.toBe(0);
  expect(deleteWithoutGrant.stderr).toContain('--operator-grant');
});

test('Hetzner Storage Box helper separates API bearer and WebDAV secret auth', () => {
  const api = runHelper('hetzner-storage-box', 'hetzner_storage_box.cjs', [
    '--format',
    'json',
    'http-request',
    'list-storage-boxes',
  ]);
  const webdav = runHelper('hetzner-storage-box', 'hetzner_storage_box.cjs', [
    '--format',
    'json',
    'webdav-request',
    'list-files',
    '--host',
    'u00000.your-storagebox.de',
    '--path',
    '/archives',
  ]);
  const deleteWithoutGrant = runHelper(
    'hetzner-storage-box',
    'hetzner_storage_box.cjs',
    [
      '--format',
      'json',
      'webdav-request',
      'delete-path',
      '--host',
      'u00000.your-storagebox.de',
      '--path',
      '/archives/stale.zip',
    ],
  );
  const shareWithoutGrant = runHelper(
    'hetzner-storage-box',
    'hetzner_storage_box.cjs',
    [
      '--format',
      'json',
      'share-public-link',
      '--host',
      'u00000.your-storagebox.de',
      '--path',
      '/archives/q4.zip',
    ],
  );
  const shareWithGrant = runHelper(
    'hetzner-storage-box',
    'hetzner_storage_box.cjs',
    [
      '--format',
      'json',
      'share-public-link',
      '--host',
      'u00000.your-storagebox.de',
      '--path',
      '/archives/q4.zip',
      '--expires-at',
      '2026-06-30',
      '--operator-grant',
    ],
  );

  expect(api.status).toBe(0);
  expect(JSON.parse(api.stdout).httpRequest).toMatchObject({
    method: 'GET',
    url: 'https://api.hetzner.com/v1/storage_boxes',
    bearerSecretName: 'HETZNER_API_TOKEN',
  });
  expect(webdav.status).toBe(0);
  expect(JSON.parse(webdav.stdout).httpRequest).toMatchObject({
    method: 'PROPFIND',
    url: 'https://u00000.your-storagebox.de/archives',
    secretHeaders: [
      {
        name: 'Authorization',
        secretName: 'HETZNER_STORAGE_BOX_BASIC_AUTH',
        prefix: 'Basic',
      },
    ],
  });
  expect(deleteWithoutGrant.status).not.toBe(0);
  expect(deleteWithoutGrant.stderr).toContain('--operator-grant');
  expect(shareWithoutGrant.status).not.toBe(0);
  expect(shareWithoutGrant.stderr).toContain('--operator-grant');
  expect(shareWithGrant.status).toBe(0);
  expect(JSON.parse(shareWithGrant.stdout)).toMatchObject({
    operation: 'share-public-link',
    stakesTier: 'amber',
    requiresOperatorAction: true,
    publicUrl: 'https://u00000.your-storagebox.de/archives/q4.zip',
    expiresAt: '2026-06-30',
  });
});

test('Hetzner eval suites cover 30 UsageTotals scenarios', () => {
  let total = 0;

  for (const skill of skills) {
    const scenarios = JSON.parse(
      fs.readFileSync(
        path.join(skillRoot, skill.name, 'evals', 'scenarios.json'),
        'utf-8',
      ),
    ) as Array<{
      category?: string;
      costMeasurement?: { system?: string };
    }>;
    total += scenarios.length;
    expect(scenarios).toHaveLength(10);
    expect(
      scenarios.every(
        (scenario) => scenario.costMeasurement?.system === 'UsageTotals',
      ),
    ).toBe(true);

    const result = runHelper(skill.name, skill.helper, [
      '--format',
      'json',
      'eval-scenarios',
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      scenarioCount: 10,
      failed: 0,
      costMeasurement: { system: 'UsageTotals' },
    });
  }

  expect(total).toBe(30);
});
