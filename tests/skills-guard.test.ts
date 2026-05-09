import { expect, test } from 'vitest';

import { scanSkillContent } from '../src/skills/skills-guard.js';

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
