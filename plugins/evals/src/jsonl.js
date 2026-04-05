import fs from 'node:fs';
import path from 'node:path';
import { extractAnswerLetter } from './mmlu.js';

function createSeededRng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffleInPlace(items, seed) {
  const random = createSeededRng(seed);
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function resolveEvalFilePath(filePath, workspacePath) {
  if (!filePath) {
    throw new Error('Missing JSONL eval file path.');
  }
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workspacePath || process.cwd(), filePath);
}

function normalizeAnswers(record) {
  if (Array.isArray(record.answers)) {
    return record.answers
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  }
  const single = String(record.answer ?? record.expected ?? '').trim();
  return single ? [single] : [];
}

function normalizeJsonlRecord(record, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Invalid JSONL eval case at line ${index + 1}.`);
  }
  const prompt = String(record.prompt || '').trim();
  const answers = normalizeAnswers(record);
  const answerMode = String(record.answerMode || 'exact')
    .trim()
    .toLowerCase();
  if (!prompt) {
    throw new Error(`Missing prompt in JSONL eval case at line ${index + 1}.`);
  }
  if (answers.length === 0) {
    throw new Error(`Missing answer in JSONL eval case at line ${index + 1}.`);
  }
  if (!['exact', 'includes', 'choice'].includes(answerMode)) {
    throw new Error(
      `Unsupported answerMode "${answerMode}" in JSONL eval case at line ${index + 1}.`,
    );
  }
  return {
    id: String(record.id || `case-${index + 1}`),
    prompt,
    answers,
    answerMode,
    metadata:
      record.metadata && typeof record.metadata === 'object'
        ? record.metadata
        : null,
  };
}

function normalizeForExact(text) {
  return String(text || '')
    .trim()
    .toLowerCase();
}

export function scoreJsonlResponse(sample, rawResponse, command) {
  const mode = command.answerMode || sample.answerMode || 'exact';
  if (mode === 'choice') {
    const predictedAnswer = extractAnswerLetter(rawResponse);
    const correct = sample.answers.some(
      (answer) =>
        predictedAnswer ===
        String(answer || '')
          .trim()
          .toUpperCase(),
    );
    return {
      predicted: predictedAnswer,
      correct,
    };
  }

  const normalizedResponse = normalizeForExact(rawResponse);
  if (mode === 'includes') {
    const correct = sample.answers.some((answer) =>
      normalizedResponse.includes(normalizeForExact(answer)),
    );
    return {
      predicted: String(rawResponse || '').trim(),
      correct,
    };
  }

  const correct = sample.answers.some(
    (answer) => normalizedResponse === normalizeForExact(answer),
  );
  return {
    predicted: String(rawResponse || '').trim(),
    correct,
  };
}

export function loadJsonlEvalSamples(command, context) {
  const resolvedPath = resolveEvalFilePath(
    command.filePath,
    context.workspacePath,
  );
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`JSONL eval file not found: ${resolvedPath}`);
  }
  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`JSONL eval file is empty: ${resolvedPath}`);
  }

  const records = lines.map((line, index) =>
    normalizeJsonlRecord(JSON.parse(line), index),
  );
  const shuffled = shuffleInPlace([...records], command.seed || 0);
  const selected = shuffled.slice(0, Math.min(command.n, shuffled.length));
  return {
    filePath: resolvedPath,
    samples: selected.map((sample, index) => ({
      caseIndex: index + 1,
      id: sample.id,
      prompt: sample.prompt,
      answers: sample.answers,
      answerMode: sample.answerMode,
      metadata: sample.metadata,
    })),
  };
}
