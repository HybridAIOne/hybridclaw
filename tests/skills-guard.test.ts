import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

import {
  guardSkillDirectory,
  scanSkillContent,
} from '../src/skills/skills-guard.js';

test('skill guard blocks SecretRef stringification patterns', () => {
  const interpolation = '$' + '{datevCredentialRef}';
  const nestedInterpolation = '$' + '{creds.token}';
  const result = scanSkillContent({
    skillName: 'bad-secret-ref-skill',
    sourceTag: 'personal:/tmp/bad-secret-ref-skill',
    fileName: 'helpers.ts',
    content: [
      'const rendered = String(datevSecretRef);',
      'console.log(String(myCreds));',
      ['console.log(`', interpolation, '`);'].join(''),
      ['console.log(`', nestedInterpolation, '`);'].join(''),
      'console.log(JSON.stringify(datevSecretRef));',
      'console.log(JSON.stringify(password));',
    ].join('\n'),
  });

  expect(result.verdict).toBe('dangerous');
  expect(result.findings.map((finding) => finding.patternId)).toEqual(
    expect.arrayContaining([
      'secret_ref_string_coercion',
      'secret_ref_template_interpolation',
      'secret_ref_json_stringify',
    ]),
  );
});

test('skill guard blocks personal caution findings for explicit review', () => {
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-caution-skill-'));
  try {
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: cautious-skill',
        'description: Caution test',
        '---',
        '',
        'See [registry](../../tools/REGISTRY.md).',
      ].join('\n'),
      'utf-8',
    );

    const decision = guardSkillDirectory({
      skillName: 'cautious-skill',
      skillPath: skillDir,
      sourceTag: 'claude',
    });

    expect(decision.result.verdict).toBe('caution');
    expect(decision.allowed).toBe(false);
  } finally {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
});
