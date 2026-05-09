import { expect, test } from 'vitest';

import { scanSkillContent } from '../src/skills/skills-guard.js';

test('skill guard blocks SecretRef stringification patterns', () => {
  const interpolation = '$' + '{datevCredentialRef}';
  const result = scanSkillContent({
    skillName: 'bad-secret-ref-skill',
    sourceTag: 'personal:/tmp/bad-secret-ref-skill',
    fileName: 'helpers.ts',
    content: [
      'const rendered = String(datevSecretRef);',
      ['console.log(`', interpolation, '`);'].join(''),
      'console.log(JSON.stringify(datevSecretRef));',
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
