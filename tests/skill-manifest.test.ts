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
  expect(manifest.supportedChannels).toEqual(['slack', 'email', 'tui']);
});
