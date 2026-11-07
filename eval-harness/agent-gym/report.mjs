// Summarize stored evidence without rerunning inference or changing verdicts.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { latestDraft } from './synthetic-tools.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { output: { type: 'string' } },
});
if (!positionals.length)
  throw new Error(
    'Usage: node report.mjs result.jsonl [result2.jsonl] [--output report.md]',
  );
const files = positionals.map((file) => ({
  file,
  rows: fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)),
}));
const metadata = files.map((file) =>
  file.rows.find((row) => row.type === 'metadata'),
);
for (const key of [
  'suite',
  'model',
  'baselineSha256',
  'datasetSha256',
  'worldSha256',
  'scorerSha256',
  'runnerSha256',
]) {
  if (!metadata.every((item) => item?.[key] && item[key] === metadata[0][key]))
    throw new Error(`Cannot pool incompatible or incomplete metadata: ${key}`);
}
const usedHashes = { baseline: new Set(), candidate: new Set() };
for (const file of files) {
  const meta = file.rows.find((row) => row.type === 'metadata');
  for (const variant of new Set(
    file.rows.filter((row) => row.type === 'episode').map((row) => row.variant),
  )) {
    if (!Object.hasOwn(usedHashes, variant) || !meta?.[`${variant}Sha256`])
      throw new Error('Missing actual prompt hash');
    usedHashes[variant].add(meta[`${variant}Sha256`]);
  }
}
for (const [variant, hashes] of Object.entries(usedHashes)) {
  if (hashes.size > 1)
    throw new Error(`Cannot pool different actual ${variant} prompts`);
}
const episodes = files.flatMap((file) =>
  file.rows.filter((row) => row.type === 'episode'),
);
const planned = metadata.reduce((sum, item) => sum + item.plannedEpisodes, 0);
const lines = [
  '# Synthetic conversation evaluation',
  '',
  `Suite: ${metadata[0].suite}. Model: ${metadata[0].model}. Episodes recorded: ${episodes.length}/${planned}.`,
  `Completed agent episodes with checks: ${episodes.filter((row) => Array.isArray(row.checks)).length}/${planned}. Technical interruptions (including optional judging): ${episodes.filter((row) => row.error || row.judgeError).length}. Interrupted episodes are not passing results.`,
  'Real inference; simulated sources, tools, sends and review control. No app UI was exercised.',
  '',
  '| Variant | Scenario | Episodes | Deterministic checks | Model judge (unverified) | Errors |',
  '| --- | --- | ---: | ---: | ---: | ---: |',
];
for (const variant of ['baseline', 'candidate'])
  for (const scenario of [...new Set(episodes.map((row) => row.scenario.id))]) {
    const rows = episodes.filter(
      (row) => row.variant === variant && row.scenario.id === scenario,
    );
    if (!rows.length) continue;
    const checks = rows.flatMap((row) => row.checks || []);
    const judge = rows.flatMap((row) => row.judge || []);
    lines.push(
      `| ${variant} | ${scenario} | ${rows.length} | ${checks.filter((check) => check.pass).length}/${checks.length} | ${judge.filter((check) => check.pass).length}/${judge.length} | ${rows.filter((row) => row.error || row.judgeError).length} |`,
    );
  }
lines.push('', '## Failed deterministic checks', '');
for (const variant of ['baseline', 'candidate']) {
  const rows = episodes.filter((row) => row.variant === variant);
  for (const id of [
    ...new Set(
      rows.flatMap((row) => row.checks || []).map((check) => check.id),
    ),
  ]) {
    const checks = rows
      .flatMap((row) => row.checks || [])
      .filter((check) => check.id === id);
    const failures = checks.filter((check) => !check.pass).length;
    if (failures)
      lines.push(`- ${variant}: ${id}: ${failures}/${checks.length} failed.`);
  }
}
lines.push('', '## Technical interruptions', '');
for (const row of episodes.filter((item) => item.error || item.judgeError)) {
  const detail = row.failure || row.judgeError;
  lines.push(
    `- ${row.variant}, ${row.scenario.id}, repetition ${row.run}: ${row.judgeError ? 'judge' : row.failurePhase || 'unknown phase'}; ${JSON.stringify(detail || { kind: 'unclassified' })}.`,
  );
}
lines.push('', '## Candidate evidence', '');
const example =
  episodes.find(
    (row) =>
      row.variant === 'candidate' &&
      row.scenario.review &&
      !row.scenario.blocked &&
      !row.error &&
      row.checks?.every((check) => check.pass),
  ) ||
  episodes.find(
    (row) =>
      row.variant === 'candidate' &&
      row.scenario.review &&
      !row.scenario.blocked &&
      !row.error,
  );
if (example) {
  lines.push(
    `Review example: ${example.scenario.id}, repetition ${example.run}. Deterministic checks passed: ${example.checks.filter((check) => check.pass).length}/${example.checks.length}. Judge limitations are listed below.`,
    '',
  );
  lines.push(
    'Brief recommendation:',
    '',
    example.phases.find((phase) =>
      ['brief', 'plan', 'inspect'].includes(phase.name),
    )?.answer || '(none)',
    '',
  );
  const card = example.trace.findLast(
    (call) =>
      call.name === 'review_action' &&
      call.result.ok &&
      call.phase === 'revise',
  );
  const draft =
    latestDraft(example, 'revise') ||
    latestDraft(example, 'draft') ||
    latestDraft(example, 'plan');
  lines.push(
    'Latest shortened draft shown for review:',
    '',
    draft?.body ||
      (draft ? JSON.stringify(draft, null, 2) : null) ||
      card?.args.body ||
      example.phases.find((phase) => phase.name === 'revise')?.answer ||
      '(none)',
    '',
  );
  lines.push(
    `Prototype review created: ${Boolean(card || draft)}. Successful simulated actions: ${example.sent.length}.`,
  );
}
const blocked = episodes.find(
  (row) =>
    row.variant === 'candidate' &&
    row.scenario.blocked &&
    row.checks?.some(
      (check) => check.id === 'blocked-access-still-drafted' && check.pass,
    ),
);
if (blocked) {
  lines.push(
    '',
    '## Draft despite denied destination access',
    '',
    `Scenario: ${blocked.scenario.id}, repetition ${blocked.run}.`,
    '',
    blocked.phases.find((phase) => phase.name === 'draft')?.answer || '(none)',
    '',
    'After the shortening request:',
    '',
    blocked.phases.find((phase) => phase.name === 'revise')?.answer || '(none)',
    '',
  );
}
lines.push('', '## Unverified model judge flags', '');
for (const episode of episodes.filter((row) => row.variant === 'candidate')) {
  for (const criterion of (episode.judge || []).filter(
    (check) => !check.pass,
  )) {
    lines.push(
      `- ${episode.scenario.id}, repetition ${episode.run}, ${criterion.id}: ${criterion.reason}`,
    );
  }
}
lines.push(
  '',
  '## Limits and provenance',
  '',
  'These are small repeated scenarios, not a statistical guarantee or a production-agent test. Regression cases may have informed tuning; they are not unseen holdouts. Exact-number checks are formatting-sensitive. The model judge can be wrong; inspect its reasons and the full transcript. Missing/error episodes are not successes. Benchmark preservation is tested after both drafting and shortening, including an explicit user override. Blocked destination access must leave a usable text draft.',
  '',
  `Candidate prompt SHA-256: ${[...usedHashes.candidate][0] || 'not exercised'}`,
  '',
  `Baseline prompt SHA-256: ${[...usedHashes.baseline][0] || 'not exercised'}`,
  '',
  ...files.map((file) => `- Source: ${file.file}`),
  '',
);
const report = lines.join('\n');
if (values.output) fs.writeFileSync(values.output, report, { flag: 'wx' });
else console.log(report);
