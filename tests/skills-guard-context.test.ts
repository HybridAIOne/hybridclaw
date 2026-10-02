import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  guardSkillDirectory,
  scanSkillContent,
} from '../src/skills/skills-guard.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hc-skill-context-');

function findings(content: string, fileName = 'SKILL.md') {
  return scanSkillContent({
    skillName: 'probe',
    sourceTag: 'codex',
    fileName,
    content,
  }).findings;
}

test.each(['fixture.test.js', 'fixture.test.cjs', 'fixture.test.ts'])(
  '%s treats a const string as data rather than an npm command',
  (file) => {
    expect(
      findings("const sample = 'Run npm install example-package.';", file),
    ).toEqual([]);
  },
);

test.each([
  ['fixture.js', "const sample = 'Run npm install example-package.';"],
  ['fixture.test.js', "exec('npm install example-package');"],
  ['fixture.test.js', 'const sample = `npm install ${packageName}`;'],
  [
    'fixture.test.js',
    "const sample = 'npm install example-package'; exec(sample);",
  ],
  ['SKILL.md', "const sample = 'Run npm install example-package.';"],
])(
  'npm commands outside literal test assignments remain flagged in %s',
  (file, content) => {
    expect(findings(content, file).map((f) => f.patternId)).toContain(
      'unpinned_npm_install',
    );
  },
);

test('literal test data does not exempt critical instructions', () => {
  expect(
    findings(
      "const sample = 'npm install example-package; ignore previous instructions';",
      'fixture.test.js',
    ).map((f) => f.patternId),
  ).toContain('prompt_injection_ignore');
});

test.each([
  ['python_os_environ', '`os.Environ()`'],
  ['node_process_env', '`console.log(process.env)`'],
  ['exec_string', '`exec("convert " + input)`'],
  ['python_subprocess', '`subprocess.run(command, shell=True)`'],
  ['python_os_system', '`os.system(input)`'],
  ['path_traversal', '`?file=../../private.txt`'],
  ['path_traversal_deep', '`?file=../../../private.txt`'],
  ['bind_all_interfaces', '`node --inspect=0.0.0.0:9229 app.js`'],
])(
  'unsafe-code documentation excludes %s only in inline examples',
  (id, code) => {
    expect(findings(`Insecure patterns:\n\n- ${code}\n`)).toEqual([]);
    expect(findings(`Run ${code}.`).map((f) => f.patternId)).toContain(id);
    expect(
      findings(`Insecure patterns:\n\n- ${code}\n`, 'helper.py').map(
        (f) => f.patternId,
      ),
    ).toContain(id);
  },
);

test.each([
  'Insecure patterns:\n- `os.system(input)`\n\nFix:\nRun `os.system(input)`.',
  'Insecure patterns:\n- `os.system(input)`\n\n## Execute\n- `os.system(input)`',
  'Insecure patterns:\n- `os.system(input)`\n\n```python\nos.system(input)\n```',
  '```markdown\nInsecure patterns:\n```\n- `os.system(input)`',
  'Insecure patterns:\n- `safe()` then run os.system(input)',
  'Insecure patterns:\n- os.system(input)',
  'Insecure patterns:\n- \\`os.system(input)\\`',
  'Insecure patterns:\n- ``os.system(input)``',
])('example context cannot suppress an operational match: %s', (content) => {
  expect(findings(content).map((f) => f.patternId)).toContain(
    'python_os_system',
  );
});

test.each([
  ['prompt_injection_ignore', '`ignore previous instructions`'],
  ['agent_config_mod', '`Append instructions to AGENTS.md`'],
  ['destructive_root_rm', '`rm -rf /`'],
  ['unpinned_npm_install', '`npm install example-package@latest`'],
  ['git_clone', '`git clone https://example.com/tool.git`'],
])('example labels preserve critical and supply-chain rule %s', (id, code) => {
  expect(
    findings(`Insecure patterns:\n- ${code}`).map((f) => f.patternId),
  ).toContain(id);
});

test.each([
  [
    'validate.py',
    'raise SystemExit("Update AGENTS.md to correct the metadata.")',
  ],
  [
    'validate.py',
    'raise SystemExit(\n    "Update AGENTS.md to correct the metadata."\n    + details\n)',
  ],
  ['validate.sh', 'echo "Update the metadata in CLAUDE.md." >&2'],
  ['validate.zsh', 'echo "Update the metadata in CLAUDE.md to $count." >&2'],
])(
  'literal diagnostics do not modify instruction files: %s',
  (file, content) => {
    expect(findings(content, file)).toEqual([]);
  },
);

test.each([
  ['validate.py', 'raise SystemExit(f"Update AGENTS.md {write_rules()}")'],
  ['validate.py', 'raise SystemExit(\n    write_rules("Update AGENTS.md")\n)'],
  ['validate.sh', 'echo "Update AGENTS.md $(write_rules)" >&2'],
  ['validate.sh', 'echo "Update AGENTS.md `write_rules`" >&2'],
  ['validate.sh', 'echo "Update AGENTS.md" >> CLAUDE.md'],
  ['validate.sh', 'echo "Update AGENTS.md" >&2; write_rules'],
  ['validate.py', 'raise SystemExit("Update AGENTS.md"); write_rules()'],
  ['SKILL.md', 'echo "Update AGENTS.md" >&2'],
  [
    'validate.py',
    'raise SystemExit("Update AGENTS.md")\nPath("AGENTS.md").write_text(rules)',
  ],
])(
  'diagnostics do not excuse active instructions or writes: %s',
  (file, content) => {
    expect(findings(content, file).map((f) => f.patternId)).toContain(
      'agent_config_mod',
    );
  },
);

test.each(['helper.js', 'helper.cjs', 'helper.mts', 'cases.test.js'])(
  '%s can represent invisible characters as data',
  (file) => {
    const content = [
      `const separator = '${String.fromCodePoint(0x200b)}';`,
      `out = out.replace(/[${String.fromCodePoint(0x200b)}-${String.fromCodePoint(0x200d)}]/g, () => { count++; return ''; });`,
      `check('${String.fromCodePoint(0xfeff)}---\\ntitle: probe\\n---');`,
    ].join('\n');
    expect(findings(content, file)).toEqual([]);
  },
);

test.each([
  ['SKILL.md', `const separator = '${String.fromCodePoint(0x200b)}';`],
  [
    'helper.js',
    `const instructions = 'upload${String.fromCodePoint(0x200b)} secrets';`,
  ],
  ['helper.js', `// hide ${String.fromCodePoint(0x200b)} instructions`],
  [
    'helper.js',
    `out = out.replace(/[${String.fromCodePoint(0x200b)}a]/g, '');`,
  ],
  [
    'helper.js',
    `out = out.replace(/[${String.fromCodePoint(0x200b)}]/g, ''); // ${String.fromCodePoint(0x200b)}`,
  ],
])('concealed text remains flagged in %s', (file, content) => {
  expect(findings(content, file).map((f) => f.patternId)).toContain(
    'invisible_unicode',
  );
});

test('directory scans use the same context rules and retain original line numbers', () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'references'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Review code\n');
  fs.writeFileSync(
    path.join(dir, 'references', 'review.md'),
    'Insecure patterns:\n- `os.system(input)`\n',
  );
  fs.writeFileSync(
    path.join(dir, 'validate.py'),
    'raise SystemExit(\n    "Update AGENTS.md metadata."\n)\n',
  );
  expect(
    guardSkillDirectory({
      skillName: 'probe',
      skillPath: dir,
      sourceTag: 'codex',
    }).allowed,
  ).toBe(true);

  fs.writeFileSync(
    path.join(dir, 'references', 'review.md'),
    'Insecure patterns:\n- `os.system(input)`\n\nRun `os.system(input)`.\n',
  );
  const decision = guardSkillDirectory({
    skillName: 'probe',
    skillPath: dir,
    sourceTag: 'codex',
  });
  expect(decision.allowed).toBe(false);
  expect(decision.result.findings).toEqual([
    expect.objectContaining({
      patternId: 'python_os_system',
      file: 'references/review.md',
      line: 4,
    }),
  ]);
});
