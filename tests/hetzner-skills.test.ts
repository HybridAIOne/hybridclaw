import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
    if (skill.name === 'hetzner-dns') {
      expect(raw).toContain('HETZNER_DNS_API_TOKEN');
    } else {
      expect(raw).toContain('HETZNER_API_TOKEN');
    }
    expect(raw).toContain('stakes_tiers:');
    expect(raw).toContain('confirm-each');
    expect(raw).toContain('UsageTotals');
    expect(raw).toContain('references/operator-setup.md');

    const operatorSetup = fs.readFileSync(
      path.join(skillRoot, skill.name, 'references', 'operator-setup.md'),
      'utf-8',
    );
    expect(operatorSetup).toContain('Recommended Autonomy');
    expect(operatorSetup).toContain('confirm-each');
  }

  const storage = fs.readFileSync(
    path.join(skillRoot, 'hetzner-storage-box', 'SKILL.md'),
    'utf-8',
  );
  expect(storage).toContain('HETZNER_STORAGE_BOX_BASIC_AUTH');
  expect(storage).toContain('HETZNER_DNS_API_TOKEN');
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

test('Hetzner helpers run when copied as standalone skill packages', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hetzner-skills-'));
  try {
    for (const skill of skills) {
      const packagedSkillDir = path.join(tempRoot, skill.name);
      fs.cpSync(path.join(skillRoot, skill.name), packagedSkillDir, {
        recursive: true,
      });

      const result = spawnSync(
        'node',
        [
          path.join(packagedSkillDir, skill.helper),
          '--format',
          'json',
          'plan',
          'list resources',
        ],
        { encoding: 'utf-8' },
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: 'plan',
        costMeasurement: { system: 'UsageTotals' },
      });
    }
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
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
  const projectRead = runHelper('hetzner-cloud', 'hetzner_cloud.cjs', [
    '--format',
    'json',
    'http-request',
    'list-servers',
    '--project',
    'datalion',
  ]);
  const projectPriceRead = runHelper('hetzner-cloud', 'hetzner_cloud.cjs', [
    '--format',
    'json',
    'http-request',
    'list-prices',
    '--project',
    'datalion',
  ]);
  const projectServerTypesRead = runHelper(
    'hetzner-cloud',
    'hetzner_cloud.cjs',
    [
      '--format',
      'json',
      'http-request',
      'list-server-types',
      '--project',
      'datalion',
    ],
  );
  const namedServerTypesRead = runHelper('hetzner-cloud', 'hetzner_cloud.cjs', [
    '--format',
    'json',
    'http-request',
    'list-server-types',
    '--name',
    'cpx32',
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
    '--project',
    'acme',
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
  const downgradeWithoutGrant = runHelper(
    'hetzner-cloud',
    'hetzner_cloud.cjs',
    [
      '--format',
      'json',
      'http-request',
      'downgrade-server',
      '--server-id',
      '123456',
      '--server-type',
      'cpx32',
    ],
  );
  const downgradeWithGrant = runHelper('hetzner-cloud', 'hetzner_cloud.cjs', [
    '--format',
    'json',
    'http-request',
    'downgrade-server',
    '--server-id',
    '123456',
    '--server-type',
    'cpx32',
    '--operator-grant',
  ]);
  const upgradeWithGrant = runHelper('hetzner-cloud', 'hetzner_cloud.cjs', [
    '--format',
    'json',
    'http-request',
    'upgrade-server',
    '--server-id',
    '123456',
    '--server-type-id',
    '47',
    '--upgrade-disk',
    '--operator-grant',
  ]);
  const namedDowngradeWithGrant = runHelper(
    'hetzner-cloud',
    'hetzner_cloud.cjs',
    [
      '--format',
      'json',
      'http-request',
      'downgrade-server',
      '--server-id',
      '123456',
      '--server-type',
      'cpx32',
      '--operator-grant',
    ],
  );
  const dashPrefixedDescription = runHelper(
    'hetzner-cloud',
    'hetzner_cloud.cjs',
    [
      '--format',
      'json',
      'http-request',
      'create-snapshot',
      '--server-id',
      '123456',
      '--description',
      '--pre-deploy',
      '--operator-grant',
    ],
  );
  const unknownOperation = runHelper('hetzner-cloud', 'hetzner_cloud.cjs', [
    '--format',
    'json',
    'http-request',
    'destroy-everything',
  ]);
  const unknownArg = runHelper('hetzner-cloud', 'hetzner_cloud.cjs', [
    '--format',
    'json',
    'http-request',
    'list-servers',
    '--typo-flag',
  ]);

  expect(read.status).toBe(0);
  expect(JSON.parse(read.stdout).httpRequest).toMatchObject({
    method: 'GET',
    bearerSecretName: 'HETZNER_API_TOKEN',
    skillName: 'hetzner-cloud',
  });
  expect(JSON.parse(read.stdout).liveExecution).toMatchObject({
    approvalPolicy: expect.stringContaining('upgrade, downgrade, buy'),
    callPolicy: expect.stringContaining('CJS helper as the API wrapper'),
    dryRunSafe: expect.stringContaining('do not call http_request'),
    requestShape: expect.stringContaining('Do not handcraft'),
    secretRefPolicy: expect.stringContaining('bearerSecretName'),
    unauthorizedPolicy: expect.stringContaining('stop after the first failure'),
  });
  expect(JSON.parse(read.stdout).liveExecution.callPolicy).toContain(
    'http_request',
  );
  expect(JSON.parse(read.stdout).liveExecution.callPolicy).not.toContain(
    'confirms',
  );
  expect(JSON.parse(read.stdout).httpRequest.url).toContain(
    'https://api.hetzner.cloud/v1/servers?',
  );
  expect(projectRead.status).toBe(0);
  expect(JSON.parse(projectRead.stdout).httpRequest.url).toContain(
    'label_selector=project%3Ddatalion',
  );
  expect(projectPriceRead.status).toBe(0);
  expect(JSON.parse(projectPriceRead.stdout).httpRequest.url).toBe(
    'https://api.hetzner.cloud/v1/pricing',
  );
  expect(projectServerTypesRead.status).toBe(0);
  expect(JSON.parse(projectServerTypesRead.stdout).httpRequest.url).toBe(
    'https://api.hetzner.cloud/v1/server_types',
  );
  expect(namedServerTypesRead.status).toBe(0);
  expect(JSON.parse(namedServerTypesRead.stdout).httpRequest.url).toBe(
    'https://api.hetzner.cloud/v1/server_types?name=cpx32',
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
  expect(downgradeWithoutGrant.status).not.toBe(0);
  expect(downgradeWithoutGrant.stderr).toContain('--operator-grant');
  expect(downgradeWithGrant.status).toBe(0);
  expect(JSON.parse(downgradeWithGrant.stdout)).toMatchObject({
    operation: 'downgrade-server',
    stakesTier: 'amber',
    httpRequest: {
      method: 'POST',
      url: 'https://api.hetzner.cloud/v1/servers/123456/actions/change_type',
      json: { server_type: 'cpx32', upgrade_disk: false },
    },
  });
  expect(upgradeWithGrant.status).toBe(0);
  expect(JSON.parse(upgradeWithGrant.stdout).httpRequest).toMatchObject({
    method: 'POST',
    url: 'https://api.hetzner.cloud/v1/servers/123456/actions/change_type',
    json: { server_type: 47, upgrade_disk: true },
  });
  expect(namedDowngradeWithGrant.status).toBe(0);
  expect(JSON.parse(namedDowngradeWithGrant.stdout).httpRequest.json).toEqual({
    server_type: 'cpx32',
    upgrade_disk: false,
  });
  expect(dashPrefixedDescription.status).toBe(0);
  expect(
    JSON.parse(dashPrefixedDescription.stdout).httpRequest.json,
  ).toMatchObject({
    description: '--pre-deploy',
  });
  expect(unknownOperation.status).not.toBe(0);
  expect(unknownOperation.stderr).toContain('Unknown Hetzner Cloud operation');
  expect(unknownOperation.stderr).not.toContain('--operator-grant');
  expect(unknownArg.status).not.toBe(0);
  expect(unknownArg.stderr).toContain('Unexpected arguments: --typo-flag');
});

test('Hetzner DNS helper builds RRset requests and protects deletes', () => {
  const create = runHelper('hetzner-dns', 'hetzner_dns.cjs', [
    '--format',
    'json',
    'http-request',
    'create-rrset',
    '--zone-id',
    'zone123',
    '--name',
    'demo',
    '--type',
    'A',
    '--ttl',
    '300',
    '--record',
    '203.0.113.10',
    '--operator-grant',
  ]);
  const deleteWithoutGrant = runHelper('hetzner-dns', 'hetzner_dns.cjs', [
    '--format',
    'json',
    'http-request',
    'delete-record',
    '--record-id',
    'record123',
  ]);
  const dashPrefixedTxt = runHelper('hetzner-dns', 'hetzner_dns.cjs', [
    '--format',
    'json',
    'http-request',
    'create-rrset',
    '--zone-id',
    'zone123',
    '--name',
    'txt',
    '--type',
    'TXT',
    '--record',
    '--spf-fragment',
    '--operator-grant',
  ]);

  expect(create.status).toBe(0);
  const payload = JSON.parse(create.stdout);
  expect(payload.httpRequest).toMatchObject({
    method: 'POST',
    url: 'https://dns.hetzner.com/api/v1/records',
    secretHeaders: [
      {
        name: 'Auth-API-Token',
        secretName: 'HETZNER_DNS_API_TOKEN',
        prefix: 'none',
      },
    ],
    skillName: 'hetzner-dns',
  });
  expect(payload.liveExecution).toMatchObject({
    requiresConfiguredSecrets: ['HETZNER_DNS_API_TOKEN'],
    callPolicy: expect.stringContaining('CJS helper as the API wrapper'),
    requestShape: expect.stringContaining('Do not handcraft'),
    secretRefPolicy: expect.stringContaining('secretHeaders'),
    unauthorizedPolicy: expect.stringContaining('stop after the first failure'),
  });
  expect(payload.liveExecution.callPolicy).toContain('http_request');
  expect(payload.liveExecution.callPolicy).not.toContain('confirms');
  expect(payload.httpRequest.json).toMatchObject({
    zone_id: 'zone123',
    name: 'demo',
    type: 'A',
    ttl: 300,
    value: '203.0.113.10',
  });
  expect(deleteWithoutGrant.status).not.toBe(0);
  expect(deleteWithoutGrant.stderr).toContain('--operator-grant');
  expect(dashPrefixedTxt.status).toBe(0);
  expect(JSON.parse(dashPrefixedTxt.stdout).httpRequest.json.value).toBe(
    '--spf-fragment',
  );
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
  const encodedWebdav = runHelper(
    'hetzner-storage-box',
    'hetzner_storage_box.cjs',
    [
      '--format',
      'json',
      'webdav-request',
      'download-file',
      '--host',
      'u00000.your-storagebox.de',
      '--path',
      '/archives/q4 invoices#final.txt',
    ],
  );
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
  const shareAlreadyPublicWithoutGrant = runHelper(
    'hetzner-storage-box',
    'hetzner_storage_box.cjs',
    [
      '--format',
      'json',
      'share-public-link',
      '--already-public',
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
  const shareAlreadyPublicWithGrant = runHelper(
    'hetzner-storage-box',
    'hetzner_storage_box.cjs',
    [
      '--format',
      'json',
      'share-public-link',
      '--already-public',
      '--host',
      'u00000.your-storagebox.de',
      '--path',
      '/archives/q4.zip',
      '--operator-grant',
    ],
  );
  const dashPrefixedBody = runHelper(
    'hetzner-storage-box',
    'hetzner_storage_box.cjs',
    [
      '--format',
      'json',
      'webdav-request',
      'archive-text',
      '--host',
      'u00000.your-storagebox.de',
      '--path',
      '/archives/flags.txt',
      '--body',
      '--manifest-start',
      '--operator-grant',
    ],
  );

  expect(api.status).toBe(0);
  expect(JSON.parse(api.stdout).httpRequest).toMatchObject({
    method: 'GET',
    url: 'https://api.hetzner.com/v1/storage_boxes',
    bearerSecretName: 'HETZNER_API_TOKEN',
  });
  expect(JSON.parse(api.stdout).liveExecution).toMatchObject({
    requiresConfiguredSecrets: ['HETZNER_API_TOKEN'],
    callPolicy: expect.stringContaining('CJS helper as the API wrapper'),
    requestShape: expect.stringContaining('Do not handcraft'),
    secretRefPolicy: expect.stringContaining('bearerSecretName'),
    unauthorizedPolicy: expect.stringContaining('stop after the first failure'),
  });
  expect(JSON.parse(api.stdout).liveExecution.callPolicy).not.toContain(
    'confirms',
  );
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
  expect(JSON.parse(webdav.stdout).liveExecution).toMatchObject({
    requiresConfiguredSecrets: ['HETZNER_STORAGE_BOX_BASIC_AUTH'],
    callPolicy: expect.stringContaining('CJS helper as the WebDAV API wrapper'),
    requestShape: expect.stringContaining('Do not handcraft'),
    secretRefPolicy: expect.stringContaining('secretHeaders'),
    unauthorizedPolicy: expect.stringContaining('stop after the first failure'),
  });
  expect(JSON.parse(webdav.stdout).liveExecution.callPolicy).not.toContain(
    'confirms',
  );
  expect(encodedWebdav.status).toBe(0);
  expect(JSON.parse(encodedWebdav.stdout).httpRequest.url).toBe(
    'https://u00000.your-storagebox.de/archives/q4%20invoices%23final.txt',
  );
  expect(deleteWithoutGrant.status).not.toBe(0);
  expect(deleteWithoutGrant.stderr).toContain('--operator-grant');
  expect(shareWithoutGrant.status).not.toBe(0);
  expect(shareWithoutGrant.stderr).toContain('--operator-grant');
  expect(shareAlreadyPublicWithoutGrant.status).not.toBe(0);
  expect(shareAlreadyPublicWithoutGrant.stderr).toContain('--operator-grant');
  expect(shareWithGrant.status).toBe(0);
  expect(JSON.parse(shareWithGrant.stdout)).toMatchObject({
    operation: 'share-public-link',
    stakesTier: 'amber',
    requiresOperatorAction: true,
    publicUrl: 'https://u00000.your-storagebox.de/archives/q4.zip',
    expiresAt: '2026-06-30',
  });
  expect(shareAlreadyPublicWithGrant.status).toBe(0);
  expect(JSON.parse(shareAlreadyPublicWithGrant.stdout)).toMatchObject({
    requiresOperatorAction: true,
    operatorChecklist: [
      'Confirm the Storage Box path is already public and intended to remain shareable.',
    ],
  });
  expect(dashPrefixedBody.status).toBe(0);
  expect(JSON.parse(dashPrefixedBody.stdout).httpRequest.body).toBe(
    '--manifest-start',
  );
});

test('Hetzner plan classifiers route representative prompts', () => {
  const cases = [
    {
      skill: skills[0],
      prompt: 'Spin up a sandboxed VPS in Falkenstein for Friday demo.',
      operation: 'create-server',
      tier: 'amber',
    },
    {
      skill: skills[0],
      prompt: 'Downgrade the bastion VPS to CPX32.',
      operation: 'downgrade-server',
      tier: 'amber',
    },
    {
      skill: skills[0],
      prompt: 'Delete the temporary demo VPS.',
      operation: 'delete-vps',
      tier: 'red',
    },
    {
      skill: skills[1],
      prompt: 'Change the demo A record to the new IPv4 address.',
      operation: 'update-rrset',
      tier: 'amber',
    },
    {
      skill: skills[1],
      prompt: 'List Hetzner DNS zones available in this project.',
      operation: 'list-zones',
      tier: 'green',
    },
    {
      skill: skills[2],
      prompt: 'Share the archived invoice bundle via public link.',
      operation: 'share-public-link',
      tier: 'amber',
    },
    {
      skill: skills[2],
      prompt: 'List files in the archive folder.',
      operation: 'list-files',
      tier: 'green',
    },
  ];

  for (const testCase of cases) {
    const result = runHelper(testCase.skill.name, testCase.skill.helper, [
      '--format',
      'json',
      'plan',
      testCase.prompt,
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      operation: testCase.operation,
      stakesTier: testCase.tier,
      costMeasurement: { system: 'UsageTotals' },
    });
  }
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
