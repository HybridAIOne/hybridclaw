import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;

let tempHome: string;

type DistillModules = {
  collectors: typeof import('../src/distill/collectors.js');
  corpus: typeof import('../src/distill/corpus.js');
  masking: typeof import('../src/distill/masking.js');
  paths: typeof import('../src/distill/paths.js');
};

async function loadDistill(): Promise<DistillModules> {
  vi.resetModules();
  return {
    collectors: await import('../src/distill/collectors.js'),
    corpus: await import('../src/distill/corpus.js'),
    masking: await import('../src/distill/masking.js'),
    paths: await import('../src/distill/paths.js'),
  };
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-distill-'));
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

const CONTEXT = {
  subject: 'maya',
  matchAliases: ['Maya Lindqvist', 'maya', 'maya@example.com'],
  ruleSet: null,
};

function writeFixture(name: string, content: string): string {
  const filePath = path.join(tempHome, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

test('detectSourceKind dispatches by extension and content shape', async () => {
  const { collectors } = await loadDistill();
  expect(collectors.detectSourceKind('a.mbox', 'From x')).toBe('email-mbox');
  expect(collectors.detectSourceKind('a.jsonl', '{}')).toBe('chat-jsonl');
  expect(
    collectors.detectSourceKind(
      'a.json',
      JSON.stringify([{ user: 'U1', ts: '1700000000.0', text: 'hi' }]),
    ),
  ).toBe('slack-export');
  expect(collectors.detectSourceKind('a.json', '{"not":"slack"}')).toBe('text');
  expect(collectors.detectSourceKind('notes.md', '# Title\n\nBody')).toBe(
    'markdown',
  );
  expect(
    collectors.detectSourceKind(
      'answers.md',
      '**Q1 (identity):** who?\n\n**A:** me\n\n**Q2 (expression):** how?\n\n**A:** so',
    ),
  ).toBe('interview');
  const transcript = [
    'Maya: morning all',
    'Tom: hello',
    'Maya: shipping today',
    'Tom: nice',
    'Anna: agreed',
  ].join('\n');
  expect(collectors.detectSourceKind('meeting.txt', transcript)).toBe(
    'transcript',
  );
});

test('slack export resolves authors via users.json and extracts long-form subject messages', async () => {
  const { collectors } = await loadDistill();
  const exportDir = path.join(tempHome, 'slack-export');
  const longText = Array.from(
    { length: 60 },
    (_, index) => `word${index}`,
  ).join(' ');
  writeFixture(
    'slack-export/users.json',
    JSON.stringify([
      { id: 'U_MAYA', profile: { real_name: 'Maya Lindqvist' } },
      { id: 'U_TOM', profile: { real_name: 'Tom Other' } },
    ]),
  );
  writeFixture(
    'slack-export/general/2026-06-01.json',
    JSON.stringify([
      { user: 'U_MAYA', ts: '1764576000.000100', text: longText },
      { user: 'U_TOM', ts: '1764576060.000200', text: 'short reply' },
    ]),
  );
  const result = collectors.collectSourcePath(exportDir, 'auto', CONTEXT);
  expect(result.documents).toHaveLength(2);
  const conversation = result.documents.find(
    (doc) => doc.author === 'conversation',
  );
  expect(conversation?.authoredBySubject).toBe(true);
  expect(conversation?.channel).toBe('general');
  expect(conversation?.content).toContain('[Maya Lindqvist]');
  expect(conversation?.content).toContain('[Tom Other]');
  const longform = result.documents.find((doc) =>
    doc.origin.endsWith('#longform'),
  );
  expect(longform?.authoredBySubject).toBe(true);
  expect(longform?.weight).toBeGreaterThan(conversation?.weight || 0);
});

test('third-party emails and phones are masked at ingest; subject identifiers survive', async () => {
  const { collectors } = await loadDistill();
  const file = writeFixture(
    'memo.md',
    '# Memo\n\nReach me at maya@example.com. For escalation call Jonas (jonas@corp.example.com, +1 555 234 5678).',
  );
  const result = collectors.collectSourcePath(file, 'auto', CONTEXT);
  const doc = result.documents[0];
  expect(doc.content).toContain('maya@example.com');
  expect(doc.content).not.toContain('jonas@corp.example.com');
  expect(doc.content).toContain('[third-party-email]');
  expect(doc.content).not.toContain('555 234 5678');
  expect(doc.content).toContain('[phone]');
  expect(doc.maskedThirdParties).toBeGreaterThanOrEqual(2);
});

test('mbox collector parses messages, attributes authorship, and strips quoted replies', async () => {
  const { collectors } = await loadDistill();
  const mbox = [
    'From maya@example.com Mon Jun 01 10:00:00 2026',
    'From: Maya Lindqvist <maya@example.com>',
    'Subject: Re: rollout plan',
    'Date: Mon, 01 Jun 2026 10:00:00 +0000',
    '',
    'I would stage this behind the flag first.',
    '> what about a big bang release?',
    'Big bang is how we got the March incident.',
    '',
    'From tom@corp.example.com Mon Jun 01 11:00:00 2026',
    'From: Tom Other <tom@corp.example.com>',
    'Subject: lunch',
    'Date: Mon, 01 Jun 2026 11:00:00 +0000',
    '',
    'Burgers?',
  ].join('\n');
  const file = writeFixture('mail.mbox', mbox);
  const result = collectors.collectSourcePath(file, 'auto', CONTEXT);
  expect(result.documents).toHaveLength(2);
  const mayaMail = result.documents.find((doc) => doc.authoredBySubject);
  expect(mayaMail?.title).toBe('Re: rollout plan');
  expect(mayaMail?.content).not.toContain('big bang release?');
  expect(mayaMail?.content).toContain('March incident');
  const tomMail = result.documents.find((doc) => !doc.authoredBySubject);
  expect(tomMail?.weight).toBeLessThan(mayaMail?.weight || 0);
});

test('quality weighting ranks interview > long-form > chat, and third-party material lowest', async () => {
  const { corpus } = await loadDistill();
  const interview = corpus.computeQualityWeight({
    source: 'interview',
    wordCount: 400,
    authoredBySubject: true,
  });
  const longform = corpus.computeQualityWeight({
    source: 'markdown',
    wordCount: 400,
    authoredBySubject: true,
  });
  const chat = corpus.computeQualityWeight({
    source: 'slack-export',
    wordCount: 30,
    authoredBySubject: true,
  });
  const thirdParty = corpus.computeQualityWeight({
    source: 'markdown',
    wordCount: 400,
    authoredBySubject: false,
  });
  expect(interview).toBeGreaterThan(longform);
  expect(longform).toBeGreaterThan(chat);
  expect(thirdParty).toBeLessThan(chat);
});

test('corpus append is deduplicated by stable provenance id and survives re-ingest', async () => {
  const { collectors, corpus, paths } = await loadDistill();
  const file = writeFixture('doc.md', '# Stable\n\nSame content every time.');
  const distillPaths = paths.resolveDistillPaths('maya', 'maya');
  const first = collectors.collectSourcePath(file, 'auto', CONTEXT);
  const second = collectors.collectSourcePath(file, 'auto', CONTEXT);
  expect(first.documents[0].id).toBe(second.documents[0].id);
  const appended = corpus.appendCorpusDocuments(
    distillPaths,
    first.documents,
    'run-1',
  );
  expect(appended.added).toHaveLength(1);
  const reAppended = corpus.appendCorpusDocuments(
    distillPaths,
    second.documents,
    'run-2',
  );
  expect(reAppended.added).toHaveLength(0);
  expect(reAppended.skippedDuplicates).toBe(1);
  expect(corpus.listCorpusDocuments(distillPaths)).toHaveLength(1);
});

test('subject alias normalization sanitizes path-unsafe values and rejects empty ones', async () => {
  const { paths } = await loadDistill();
  expect(paths.normalizeSubjectAlias('Maya Lindqvist')).toBe('maya-lindqvist');
  // Path separators and dots never survive into the slug.
  expect(paths.normalizeSubjectAlias('../escape')).toBe('escape');
  expect(() => paths.normalizeSubjectAlias('')).toThrow(
    /Invalid coworker alias/,
  );
  expect(() => paths.normalizeSubjectAlias('../..')).toThrow(
    /Invalid coworker alias/,
  );
});
