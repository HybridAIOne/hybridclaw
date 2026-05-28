import { expect, test } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

test('parses manifest fields using the documented source priority', () => {
  const manifest = parseSkillManifestFromMarkdown(
    `---
name: Priority Skill
id: frontmatter-id
version: 0.0.1
capabilities: frontmatter.capability
metadata:
  id: metadata-id
  version: 0.0.2
  capabilities: metadata.capability
  hybridclaw:
    id: hybridclaw-id
    version: 0.0.3
    capabilities: hybridclaw.capability
    manifest:
      id: nested-manifest-id
      version: 0.0.4
      capabilities: nested.manifest.capability
manifest:
  id: top-level-manifest-id
  version: 1.2.3
  capabilities: top.level.capability
---
Use the skill.
`,
    { name: 'fallback' },
  );

  expect(manifest.id).toBe('top-level-manifest-id');
  expect(manifest.version).toBe('1.2.3');
  expect(manifest.capabilities).toEqual(['top.level.capability']);
});

test('parses YAML inline manifest sequences as arrays', () => {
  const manifest = parseSkillManifestFromMarkdown(
    `---
name: Inline Skill
manifest:
  id: inline-skill
  version: 1.0.0
  capabilities: [crm.sync, proposal.write]
  required_credentials: [crm_token, quote_token]
  supported_channels: [slack, email, web]
---
Use the skill.
`,
    { name: 'fallback' },
  );

  expect(manifest.capabilities).toEqual(['crm.sync', 'proposal.write']);
  expect(manifest.requiredCredentials).toEqual([
    { id: 'crm-token', required: true },
    { id: 'quote-token', required: true },
  ]);
  expect(manifest.credentials).toEqual([]);
  expect(manifest.supportedChannels).toEqual(['slack', 'email', 'tui']);
});

test('parses first-class credential declarations from frontmatter', () => {
  const manifest = parseSkillManifestFromMarkdown(
    `---
name: Credential Skill
manifest:
  id: credential-skill
  version: 1.0.0
credentials:
  - id: crm_api
    kind: api_key
    required: true
    secret_ref:
      source: store
      id: CRM_API_KEY
    scope: "*.crm.example.com"
    how_to_obtain: |
      Create a CRM API key from the admin console.
  - id: browser_session
    kind: browser_login
    required: false
    secret_ref:
      source: store
      id: BROWSER_SESSION_TOKEN
    scope: "#login-form"
    how_to_obtain: Sign in with the shared test account.
---
Use the skill.
`,
    { name: 'fallback' },
  );

  expect(manifest.credentials).toEqual([
    {
      id: 'crm-api',
      kind: 'api_key',
      required: true,
      secretRef: {
        source: 'store',
        id: 'CRM_API_KEY',
      },
      scope: '*.crm.example.com',
      howToObtain: 'Create a CRM API key from the admin console.',
    },
    {
      id: 'browser-session',
      kind: 'browser_login',
      required: false,
      secretRef: {
        source: 'store',
        id: 'BROWSER_SESSION_TOKEN',
      },
      scope: '#login-form',
      howToObtain: 'Sign in with the shared test account.',
    },
  ]);
  expect(manifest.requiredCredentials).toEqual([
    { id: 'crm-api', required: true },
    { id: 'browser-session', required: false },
  ]);
});

test('parses first-class config variable declarations from frontmatter', () => {
  const manifest = parseSkillManifestFromMarkdown(
    `---
name: Config Skill
manifest:
  id: config-skill
  version: 1.0.0
config_variables:
  - id: inverter-host
    env: FRONIUS_LOCAL_HOST
    required: false
    scope: Local inverter base URL
    how_to_obtain: Find the inverter IP in the router.
---
Use the skill.
`,
    { name: 'fallback' },
  );

  expect(manifest.configVariables).toEqual([
    {
      id: 'inverter-host',
      env: 'FRONIUS_LOCAL_HOST',
      required: false,
      scope: 'Local inverter base URL',
      howToObtain: 'Find the inverter IP in the router.',
    },
  ]);
});

test('reports precise credential frontmatter validation errors', () => {
  expect(() =>
    parseSkillManifestFromMarkdown(
      `---
name: Invalid Credential Skill
credentials:
  - id: crm
    kind: password
    required: true
    secret_ref:
      source: store
      id: CRM_API_KEY
    scope: "*.crm.example.com"
    how_to_obtain: Ask an admin.
---
Use the skill.
`,
      { name: 'fallback' },
    ),
  ).toThrow(
    'Invalid skill credentials frontmatter: credentials[0].kind must be one of api_key, oauth, browser_login, bearer, header.',
  );
});

test('reports missing and duplicate credential frontmatter fields', () => {
  const cases = [
    {
      name: 'missing required',
      fields: [
        '    kind: api_key',
        '    secret_ref:',
        '      source: store',
        '      id: CRM_API_KEY',
        '    scope: "*.crm.example.com"',
        '    how_to_obtain: Ask an admin.',
      ],
      message:
        'Invalid skill credentials frontmatter: credentials[0].required must be true or false.',
    },
    {
      name: 'missing scope',
      fields: [
        '    kind: api_key',
        '    required: true',
        '    secret_ref:',
        '      source: store',
        '      id: CRM_API_KEY',
        '    how_to_obtain: Ask an admin.',
      ],
      message:
        'Invalid skill credentials frontmatter: credentials[0].scope is required.',
    },
    {
      name: 'missing how_to_obtain',
      fields: [
        '    kind: api_key',
        '    required: true',
        '    secret_ref:',
        '      source: store',
        '      id: CRM_API_KEY',
        '    scope: "*.crm.example.com"',
      ],
      message:
        'Invalid skill credentials frontmatter: credentials[0].how_to_obtain is required.',
    },
  ];

  for (const testCase of cases) {
    expect(() =>
      parseSkillManifestFromMarkdown(
        [
          '---',
          `name: ${testCase.name}`,
          'credentials:',
          '  - id: crm',
          ...testCase.fields,
          '---',
          'Use the skill.',
        ].join('\n'),
        { name: 'fallback' },
      ),
    ).toThrow(testCase.message);
  }

  expect(() =>
    parseSkillManifestFromMarkdown(
      `---
name: Duplicate Credential Skill
credentials:
  - id: crm
    kind: api_key
    required: true
    secret_ref:
      source: store
      id: CRM_API_KEY
    scope: "*.crm.example.com"
    how_to_obtain: Ask an admin.
  - id: crm
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: CRM_BEARER_TOKEN
    scope: "*.crm.example.com"
    how_to_obtain: Ask an admin.
---
Use the skill.
`,
      { name: 'fallback' },
    ),
  ).toThrow(
    'Invalid skill credentials frontmatter: credentials[1].id duplicates credential "crm".',
  );
});

test('parses skill-side middleware hook declarations', () => {
  const manifest = parseSkillManifestFromMarkdown(
    `---
name: Middleware Skill
metadata:
  hybridclaw:
    middleware:
      pre_send: true
      post_receive: true
---
Use the skill.
`,
    { name: 'fallback' },
  );

  expect(manifest.middleware).toEqual({
    preSend: true,
    postReceive: true,
  });
});

test('requires valid versions when strict manifest parsing is requested', () => {
  expect(() =>
    parseSkillManifestFromMarkdown(
      `---
name: Missing Version
manifest:
  id: missing-version
---
Use the skill.
`,
      { name: 'fallback' },
      { requireVersion: true },
    ),
  ).toThrow(
    'Skill manifest for "Missing Version" has missing version; packaged skills must declare a semantic version like 1.2.3.',
  );

  expect(() =>
    parseSkillManifestFromMarkdown(
      `---
name: Invalid Version
manifest:
  id: invalid-version
  version: latest
---
Use the skill.
`,
      { name: 'fallback' },
      { requireVersion: true },
    ),
  ).toThrow(
    'Skill manifest for "Invalid Version" has invalid version "latest"; packaged skills must declare a semantic version like 1.2.3.',
  );
});
