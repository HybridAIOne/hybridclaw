import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

const MMLU_SUBJECTS = [
  'abstract_algebra',
  'anatomy',
  'astronomy',
  'business_ethics',
  'clinical_knowledge',
  'college_biology',
  'college_chemistry',
  'college_computer_science',
  'college_mathematics',
  'college_medicine',
  'college_physics',
  'computer_security',
  'conceptual_physics',
  'econometrics',
  'electrical_engineering',
  'elementary_mathematics',
  'formal_logic',
  'global_facts',
  'high_school_biology',
  'high_school_chemistry',
  'high_school_computer_science',
  'high_school_european_history',
  'high_school_geography',
  'high_school_government_and_politics',
  'high_school_macroeconomics',
  'high_school_mathematics',
  'high_school_microeconomics',
  'high_school_physics',
  'high_school_psychology',
  'high_school_statistics',
  'high_school_us_history',
  'high_school_world_history',
  'human_aging',
  'human_sexuality',
  'international_law',
  'jurisprudence',
  'logical_fallacies',
  'machine_learning',
  'management',
  'marketing',
  'medical_genetics',
  'miscellaneous',
  'moral_disputes',
  'moral_scenarios',
  'nutrition',
  'philosophy',
  'prehistory',
  'professional_accounting',
  'professional_law',
  'professional_medicine',
  'professional_psychology',
  'public_relations',
  'security_studies',
  'sociology',
  'us_foreign_policy',
  'virology',
  'world_religions',
];

function createSeededRng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function pickRandom(list, random) {
  return list[Math.floor(random() * list.length)];
}

function normalizeMmluRow(record) {
  const columns = record.map((value) => String(value || '').trim());
  if (columns.length < 6) {
    return null;
  }
  const [question, optionA, optionB, optionC, optionD, answer] = columns;
  if (!question || !optionA || !optionB || !optionC || !optionD) {
    return null;
  }
  const normalizedAnswer = answer.toUpperCase();
  if (!['A', 'B', 'C', 'D'].includes(normalizedAnswer)) {
    return null;
  }
  return {
    question,
    choices: {
      A: optionA,
      B: optionB,
      C: optionC,
      D: optionD,
    },
    answer: normalizedAnswer,
  };
}

export function formatSubjectLabel(subject) {
  return subject
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function buildMmluPrompt(sample) {
  return [
    `Answer the following MMLU multiple-choice question from the subject "${formatSubjectLabel(sample.subject)}".`,
    'Reply with exactly one letter: A, B, C, or D.',
    '',
    sample.question,
    '',
    `A. ${sample.choices.A}`,
    `B. ${sample.choices.B}`,
    `C. ${sample.choices.C}`,
    `D. ${sample.choices.D}`,
  ].join('\n');
}

export function extractAnswerLetter(text) {
  const normalized = String(text || '')
    .trim()
    .toUpperCase();
  if (!normalized) return null;
  const exact = normalized.match(/^[\s"'`([{<]*([ABCD])[\s"')\]}>.:,!?-]*$/);
  if (exact) {
    return exact[1];
  }
  const match = normalized.match(/\b([ABCD])\b/);
  return match ? match[1] : null;
}

async function readSubjectCsv(config, subject) {
  const cachePath = path.join(config.cacheDir, 'mmlu', `${subject}.csv`);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, 'utf-8');
  }

  const url = `${config.mmluBaseUrl.replace(/\/+$/, '')}/${subject}_test.csv`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch MMLU subject ${subject}: ${response.status}`,
    );
  }
  const text = await response.text();
  fs.writeFileSync(cachePath, text, 'utf-8');
  return text;
}

async function loadSubjectRows(config, subject) {
  const csvText = await readSubjectCsv(config, subject);
  const records = parse(csvText, {
    relax_quotes: true,
    skip_empty_lines: true,
  });
  const rows = records
    .map((record) => normalizeMmluRow(record))
    .filter(Boolean);
  if (rows.length === 0) {
    throw new Error(`No rows loaded for MMLU subject ${subject}`);
  }
  return rows;
}

export async function buildMmluSamples(config, options) {
  const random = createSeededRng(options.seed);
  const subjects = options.subject ? [options.subject] : MMLU_SUBJECTS;
  if (!subjects.length) {
    throw new Error('No MMLU subjects available.');
  }

  const plannedSubjects = Array.from({ length: options.n }, () =>
    pickRandom(subjects, random),
  );
  const uniqueSubjects = [...new Set(plannedSubjects)];
  const subjectRows = new Map();
  for (const subject of uniqueSubjects) {
    subjectRows.set(subject, await loadSubjectRows(config, subject));
  }

  return plannedSubjects.map((subject, index) => {
    const rows = subjectRows.get(subject);
    const row = pickRandom(rows, random);
    return {
      caseIndex: index + 1,
      subject,
      question: row.question,
      choices: row.choices,
      answer: row.answer,
      prompt: buildMmluPrompt({
        subject,
        question: row.question,
        choices: row.choices,
      }),
    };
  });
}
