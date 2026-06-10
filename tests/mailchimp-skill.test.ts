import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const helperPath = path.join(process.cwd(), 'skills', 'mailchimp', 'mailchimp.cjs');
const skillPath = path.join(process.cwd(), 'skills', 'mailchimp', 'SKILL.md');
const roadmapPath = path.join(process.cwd(), 'docs', 'content', 'internal', 'roadmap.md');
const require = createRequire(import.meta.url);
const mailchimp = require('../skills/mailchimp/mailchimp.cjs') as {
  buildRequest: (args: string[]) => Record<string, any>;
  subscriberHash: (email: string) => string;
};

function runHelper(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

function build(args: string[]) {
  return mailchimp.buildRequest(['--format', 'json', ...args]);
}

test('mailchimp skill manifest declares Marketing and Mandrill credentials', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, { name: 'mailchimp' });

  expect(manifest.credentials).toEqual([
    expect.objectContaining({
      id: 'mailchimp-marketing-basic-auth',
      kind: 'header',
      required: true,
      secretRef: {
        source: 'store',
        id: 'MAILCHIMP_MARKETING_BASIC_AUTH',
      },
      scope: 'Mailchimp Marketing API Authorization Basic header secret for https://<dc>.api.mailchimp.com/3.0',
    }),
    expect.objectContaining({
      id: 'mailchimp-marketing-oauth-token',
      kind: 'bearer',
      required: false,
      secretRef: {
        source: 'store',
        id: 'MAILCHIMP_MARKETING_OAUTH_TOKEN',
      },
    }),
    expect.objectContaining({
      id: 'mandrill-api-key',
      kind: 'api_key',
      required: false,
      secretRef: {
        source: 'store',
        id: 'MANDRILL_API_KEY',
      },
    }),
  ]);
  expect(manifest.configVariables).toEqual([
    expect.objectContaining({
      id: 'mailchimp-server-prefix',
      env: 'MAILCHIMP_SERVER_PREFIX',
      required: true,
    }),
  ]);
  expect(skill).toContain('approval-plan campaign.send');
  expect(skill).toContain('approval-plan audience.bulk-plan');
  expect(skill).toContain('MAILCHIMP_MARKETING_BASIC_AUTH');
  expect(skill).toContain('Authorization: Basic');
  expect(skill).toContain('already stored OAuth access token');
  expect(skill).toContain('permanent member deletion');
});

test('mailchimp roadmap row links issue 1136', () => {
  const roadmap = fs.readFileSync(roadmapPath, 'utf-8');

  expect(roadmap).toContain(
    '| R21.67 | Skill | Mailchimp skill (audiences, campaigns, transactional via Mandrill — peer to brevo-email plugin) | ✅ #1136 |',
  );
});

test('mailchimp helper --help lists audience campaign and transactional surfaces', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Mailchimp skill helper');
  expect(result.stdout).toContain('oauth.metadata');
  expect(result.stdout).toContain('audience.member-upsert');
  expect(result.stdout).toContain('campaign.send');
  expect(result.stdout).toContain('mandrill.send-template');
  expect(result.stdout).toContain('approval-plan <operation>');
});

test('mailchimp helper reports gateway-resolved placeholders without reading stores', () => {
  const payload = build(['credential-check']);

  expect(payload).toMatchObject({
    command: 'credential-check',
    ok: true,
    missing: [],
    gatewayResolution: expect.stringContaining('<env:...> and <secret:...>'),
    diagnosticPolicy: expect.stringContaining(
      'Do not run hybridclaw secret/env list',
    ),
  });
  expect(payload.requiredPlaceholders).toEqual([
    '<env:MAILCHIMP_SERVER_PREFIX>',
    '<secret:MAILCHIMP_MARKETING_BASIC_AUTH>',
  ]);
  expect(payload.requiredConfigVariables).toEqual([
    expect.objectContaining({
      name: 'MAILCHIMP_SERVER_PREFIX',
      placeholder: '<env:MAILCHIMP_SERVER_PREFIX>',
    }),
  ]);
  expect(payload.requiredRuntimeSecrets).toEqual([
    expect.objectContaining({
      name: 'MAILCHIMP_MARKETING_BASIC_AUTH',
      placeholder: '<secret:MAILCHIMP_MARKETING_BASIC_AUTH>',
    }),
  ]);
  expect(payload.optionalRuntimeSecrets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'MAILCHIMP_MARKETING_OAUTH_TOKEN',
        placeholder: '<secret:MAILCHIMP_MARKETING_OAUTH_TOKEN>',
      }),
      expect.objectContaining({
        name: 'MANDRILL_API_KEY',
        placeholder: '<secret:MANDRILL_API_KEY>',
      }),
    ]),
  );
  expect(payload.secretVisibility).toContain('does not read runtime env or secret values');
});

test('mailchimp helper builds OAuth metadata request without server prefix', () => {
  const payload = build(['http-request', 'oauth.metadata', '--auth', 'oauth']);

  expect(payload).toMatchObject({
    command: 'http-request',
    operation: 'oauth.metadata',
    stakesTier: 'green',
    httpRequest: {
      url: 'https://login.mailchimp.com/oauth2/metadata',
      method: 'GET',
      headers: {
        Authorization: 'OAuth <secret:MAILCHIMP_MARKETING_OAUTH_TOKEN>',
      },
      skillName: 'mailchimp',
      stakesTier: 'green',
    },
  });
  expect(payload.httpRequest).not.toHaveProperty('bearerSecretName');
});

test('mailchimp helper builds placeholder-backed audience member lookup', () => {
  const hash = mailchimp.subscriberHash('Ada@Example.com');
  const payload = build([
    'http-request',
    'audience.member',
    '--server-prefix',
    'us21',
    '--list-id',
    'list/id',
    '--email',
    'Ada@Example.com',
  ]);

  expect(hash).toBe('3e3417d7ef77d5932a6734b916515ed5');
  expect(payload).toMatchObject({
    command: 'http-request',
    operation: 'audience.member',
    stakesTier: 'green',
    httpRequest: {
      url: `https://us21.api.mailchimp.com/3.0/lists/list%2Fid/members/${hash}`,
      method: 'GET',
      authMode: 'api-key',
      headers: {
        Authorization: 'Basic <secret:MAILCHIMP_MARKETING_BASIC_AUTH>',
      },
      skillName: 'mailchimp',
      stakesTier: 'green',
    },
    auditPolicy: {
      automationContext: expect.stringContaining('status and audit-safe context capture'),
      pii: expect.stringContaining('subscriber_hash'),
    },
  });
  expect(JSON.stringify(payload)).not.toContain('Ada@Example.com');
  expect(JSON.stringify(payload)).not.toContain('Bearer');
  expect(payload.httpRequest).not.toHaveProperty('secretHeaders');
});

test('mailchimp helper supports OAuth placeholder auth for Marketing requests', () => {
  const payload = build([
    'http-request',
    'audience.list',
    '--auth',
    'oauth',
    '--server-prefix',
    'us21',
  ]);

  expect(payload.httpRequest).toMatchObject({
    url: 'https://us21.api.mailchimp.com/3.0/lists?count=25',
    method: 'GET',
    authMode: 'oauth',
    headers: {
      Authorization: 'OAuth <secret:MAILCHIMP_MARKETING_OAUTH_TOKEN>',
    },
  });
  expect(payload.httpRequest).not.toHaveProperty('secretHeaders');
  expect(payload.httpRequest).not.toHaveProperty('bearerSecretName');
});

test('mailchimp helper uses env placeholder for default Marketing host', () => {
  const payload = build(['http-request', 'audience.list']);

  expect(payload.httpRequest).toMatchObject({
    url: 'https://<env:MAILCHIMP_SERVER_PREFIX>.api.mailchimp.com/3.0/lists?count=25',
    method: 'GET',
    headers: {
      Authorization: 'Basic <secret:MAILCHIMP_MARKETING_BASIC_AUTH>',
    },
  });
});

test('mailchimp helper builds automation and journey status reads', () => {
  const automation = build([
    'http-request',
    'automation.get',
    '--server-prefix',
    'us21',
    '--workflow-id',
    'workflow/id',
  ]);
  const journey = build([
    'http-request',
    'journey.get',
    '--server-prefix',
    'us21',
    '--journey-id',
    'journey/id',
  ]);

  expect(automation.httpRequest.url).toBe(
    'https://us21.api.mailchimp.com/3.0/automations/workflow%2Fid',
  );
  expect(journey.httpRequest.url).toBe(
    'https://us21.api.mailchimp.com/3.0/customer-journeys/journeys/journey%2Fid',
  );
  expect(automation.auditPolicy.automationContext).toContain('ids, names, status');
  expect(journey.auditPolicy.automationContext).toContain('ids, names, status');
});

test('mailchimp helper exposes explicit campaign bounce report summary', () => {
  const payload = build([
    'http-request',
    'campaign.report',
    '--server-prefix',
    'us21',
    '--campaign-id',
    'campaign/id',
    '--kind',
    'bounces',
  ]);
  const url = new URL(payload.httpRequest.url as string);

  expect(url.origin + url.pathname).toBe(
    'https://us21.api.mailchimp.com/3.0/reports/campaign%2Fid',
  );
  expect(url.searchParams.get('fields')).toBe(
    'id,campaign_title,emails_sent,bounces,send_time,list_id,list_name',
  );
  expect(url.searchParams.has('count')).toBe(false);
  expect(payload).toMatchObject({
    operation: 'campaign.report',
    stakesTier: 'green',
  });
});

test('mailchimp guarded campaign send requires approval plan and grant', () => {
  const denied = runHelper([
    '--format',
    'json',
    'http-request',
    'campaign.send',
    '--server-prefix',
    'us21',
    '--campaign-id',
    'abc123',
  ]);

  expect(denied.status).toBe(1);
  expect(denied.stderr).toContain('Run approval-plan campaign.send first');

  const plan = build([
    'approval-plan',
    'campaign.send',
    '--server-prefix',
    'us21',
    '--campaign-id',
    'abc123',
  ]);

  expect(plan).toMatchObject({
    command: 'approval-plan',
    operation: 'campaign.send',
    stakesTier: 'red',
    preview: {
      method: 'POST',
      url: 'https://us21.api.mailchimp.com/3.0/campaigns/abc123/actions/send',
      sendsExternalEmail: true,
    },
  });
  expect(plan.approval.requiredGrant).toContain('mailchimp:campaign.send');
  expect(plan.approval.approvedHelperCommand).toContain('--operator-grant');

  const approved = build([
    'http-request',
    'campaign.send',
    '--server-prefix',
    'us21',
    '--campaign-id',
    'abc123',
    '--operator-grant',
  ]);
  expect(approved.httpRequest.url).toBe(
    'https://us21.api.mailchimp.com/3.0/campaigns/abc123/actions/send',
  );
});

test('mailchimp helper requires a red approval preview for bulk member plans', () => {
  const direct = runHelper([
    '--format',
    'json',
    'http-request',
    'audience.bulk-plan',
    '--list-id',
    'list-123',
    '--operation',
    'member-upsert',
    '--count',
    '2500',
    '--source-label',
    'imports/may.csv',
  ]);

  expect(direct.status).toBe(1);
  expect(direct.stderr).toContain('approval-plan only operation');

  const plan = build([
    'approval-plan',
    'audience.bulk-plan',
    '--list-id',
    'list-123',
    '--operation',
    'member-upsert',
    '--count',
    '2500',
    '--source-label',
    'imports/may.csv',
    '--sample-json',
    '{"email":"user@example.com","FNAME":"Ada","status_if_new":"pending"}',
  ]);

  expect(plan).toMatchObject({
    command: 'approval-plan',
    operation: 'audience.bulk-plan',
    stakesTier: 'red',
    preview: {
      listId: 'list-123',
      memberOperation: 'member-upsert',
      count: 2500,
      source: 'imports/may.csv',
      sendsExternalEmail: false,
      subscriberMutation: true,
    },
  });
  expect(plan.preview.sample.email).toBe('<redacted:email>');
  expect(plan.preview.sample.FNAME).toBe('<redacted:FNAME>');
  expect(plan.preview.execution).toContain('does not expose Mailchimp batch endpoints');
  expect(plan.approval.requiredGrant).toContain('mailchimp:audience.bulk-plan');
});

test('mailchimp approval previews redact subscriber fields and campaign content bodies', () => {
  const member = build([
    'approval-plan',
    'audience.member-upsert',
    '--server-prefix',
    'us21',
    '--list-id',
    'list-123',
    '--email',
    'user@example.com',
    '--merge-fields-json',
    '{"FNAME":"Ada","LNAME":"Lovelace"}',
  ]);
  expect(member.preview.body.email_address).toBe(
    '<redacted:email_address:length=16>',
  );
  expect(member.preview.body.merge_fields).toEqual({
    FNAME: '<redacted:merge-field>',
    LNAME: '<redacted:merge-field>',
  });

  const campaignContent = build([
    'approval-plan',
    'campaign.content-set',
    '--server-prefix',
    'us21',
    '--campaign-id',
    'campaign-123',
    '--body-json',
    '{"html":"<p>Hello subscriber</p>","plain_text":"Hello subscriber"}',
  ]);
  expect(campaignContent.preview.body.html).toBe(
    '<redacted:html:length=23>',
  );
  expect(campaignContent.preview.body.plain_text).toBe(
    '<redacted:plain_text:length=16>',
  );
});

test('mailchimp helper injects Mandrill key as placeholder and rejects raw key bodies', () => {
  const info = build(['http-request', 'mandrill.message-info', '--id', 'msg-123']);
  expect(info).toMatchObject({
    command: 'http-request',
    operation: 'mandrill.message-info',
    stakesTier: 'green',
    httpRequest: {
      url: 'https://mandrillapp.com/api/1.0/messages/info.json',
      method: 'POST',
      json: {
        key: '<secret:MANDRILL_API_KEY>',
        id: 'msg-123',
      },
    },
  });

  const plan = build([
    'approval-plan',
    'mandrill.send-template',
    '--body-json',
    '{"template_name":"receipt","template_content":[],"message":{"to":[{"email":"user@example.com","type":"to"}]}}',
  ]);

  expect(plan).toMatchObject({
    command: 'approval-plan',
    operation: 'mandrill.send-template',
    stakesTier: 'red',
    preview: {
      method: 'POST',
      url: 'https://mandrillapp.com/api/1.0/messages/send-template.json',
      sendsExternalEmail: true,
    },
  });
  expect(plan.preview.body.key).toBe('<secret:MANDRILL_API_KEY>');
  expect(plan.preview.body.message.to).toBe('<1 recipients>');

  const customSecretPlan = build([
    'approval-plan',
    'mandrill.send',
    '--mandrill-secret',
    'CUSTOM_MANDRILL_SECRET',
    '--body-json',
    '{"message":{"text":"hello","to":[{"email":"user@example.com"}]}}',
  ]);
  expect(customSecretPlan.preview.body.key).toBe(
    '<secret:CUSTOM_MANDRILL_SECRET>',
  );

  const rejected = runHelper([
    '--format',
    'json',
    'approval-plan',
    'mandrill.send',
    '--body-json',
    '{"key":"raw","message":{"text":"nope"}}',
  ]);
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain('must not include Mandrill key');
});

test('mailchimp helper classifies credential and rate-limit API errors', () => {
  const credential = build([
    'classify-response',
    '--status',
    '403',
    '--body-json',
    '{"title":"Forbidden","detail":"role denied"}',
  ]);
  expect(credential).toMatchObject({
    command: 'classify-response',
    status: 403,
    layer: 'credential-or-permission',
    upstream: {
      title: 'Forbidden',
      detail: 'role denied',
    },
  });

  const rateLimit = build(['classify-response', '--status', '429', '--body-json', '{}']);
  expect(rateLimit.layer).toBe('rate-limit');
});

test('mailchimp helper classifies missing runtime secret gateway errors', () => {
  const payload = build([
    'classify-response',
    '--gateway-error',
    'Stored secret MAILCHIMP_MARKETING_BASIC_AUTH is not set.',
  ]);

  expect(payload).toMatchObject({
    command: 'classify-response',
    status: 0,
    layer: 'missing-runtime-secret',
    upstream: {
      detail: 'Stored secret MAILCHIMP_MARKETING_BASIC_AUTH is not set.',
    },
  });
  expect(payload.action).toContain('hybridclaw secret set MAILCHIMP_MARKETING_BASIC_AUTH');
  expect(payload.action).toContain('hybridclaw secret set MAILCHIMP_MARKETING_OAUTH_TOKEN');
});
