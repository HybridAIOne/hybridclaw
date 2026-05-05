import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

function resolveDataDir() {
  const envDir = (process.env.HYBRIDCLAW_DATA_DIR || '').trim();
  if (!envDir) {
    return path.join(os.homedir(), '.hybridclaw', 'data');
  }
  if (!path.isAbsolute(envDir)) {
    throw new Error(
      `HYBRIDCLAW_DATA_DIR must be an absolute path, got: ${envDir}`,
    );
  }
  return path.join(envDir, 'data');
}

function resolveDbPath() {
  const dataDir = resolveDataDir();
  return path.join(dataDir, 'hybridclaw.db');
}

function safeSessionFilename(sessionId) {
  const normalized = String(sessionId)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  return normalized || 'session';
}

function findTranscriptFiles(dataDir, sessionId) {
  const agentsDir = path.join(dataDir, 'agents');
  if (!fs.existsSync(agentsDir)) return [];
  const safeName = `${safeSessionFilename(sessionId)}.jsonl`;
  const results = [];
  for (const agent of fs.readdirSync(agentsDir)) {
    const candidate = path.join(
      agentsDir,
      agent,
      'workspace',
      '.session-transcripts',
      safeName,
    );
    if (fs.existsSync(candidate)) results.push(candidate);
  }
  return results;
}

function readTranscript(filePath) {
  const entries = [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return entries;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}

function loadTranscriptForSession(dataDir, sessionId) {
  const files = findTranscriptFiles(dataDir, sessionId);
  const seen = new Set();
  const entries = [];
  for (const filePath of files) {
    for (const entry of readTranscript(filePath)) {
      const key = `${entry.createdAt || ''}|${entry.role || ''}|${(entry.content || '').slice(0, 120)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  entries.sort((a, b) => {
    const ta = Date.parse(a.createdAt || '') || 0;
    const tb = Date.parse(b.createdAt || '') || 0;
    return ta - tb;
  });
  return entries;
}

function findPromptForObservation(transcript, observationCreatedAt) {
  const observationMs = Date.parse(observationCreatedAt) || Date.now();
  let best = null;
  for (const entry of transcript) {
    const entryMs = Date.parse(entry.createdAt || '') || 0;
    if (entryMs > observationMs) break;
    if (String(entry.role || '').toLowerCase() !== 'user') continue;
    best = entry;
  }
  return best ? String(best.content || '').trim() : '';
}

function loadSqliteDriver() {
  try {
    return require('better-sqlite3');
  } catch (err) {
    throw new Error(
      `better-sqlite3 is required to read the HybridClaw database. Install via the main repo (\`npm install\`) before running trace extraction. Underlying error: ${err.message}`,
    );
  }
}

export function extractTraces(options) {
  const {
    skillName,
    repoRoot,
    limit = 500,
    includeOtherSkills = true,
    otherSkillSampleCap = 200,
    includeTranscripts = true,
  } = options;
  if (!skillName) {
    throw new Error('extractTraces requires a skillName');
  }

  const dataDir = resolveDataDir();
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    return {
      dbPath,
      dataDir,
      repoRoot,
      skillName,
      observations: [],
      otherSkillObservations: [],
      warning: 'HybridClaw database not found at expected path.',
    };
  }

  const Database = loadSqliteDriver();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  let observations = [];
  let otherSkillObservations = [];
  const transcripts = {};

  try {
    observations = db
      .prepare(
        `SELECT id, skill_name, session_id, run_id, outcome, error_category,
                error_detail, tool_calls_attempted, tool_calls_failed,
                duration_ms, feedback_sentiment, created_at
         FROM skill_observations
         WHERE skill_name = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(skillName, limit);

    if (includeOtherSkills) {
      otherSkillObservations = db
        .prepare(
          `SELECT skill_name, session_id, run_id, outcome, created_at
           FROM skill_observations
           WHERE skill_name != ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(skillName, otherSkillSampleCap);
    }

    if (includeTranscripts) {
      const sessionIds = new Set(observations.map((o) => o.session_id));
      for (const otherObs of otherSkillObservations) {
        sessionIds.add(otherObs.session_id);
      }

      for (const sessionId of sessionIds) {
        const transcript = loadTranscriptForSession(dataDir, sessionId);
        if (transcript.length === 0) continue;
        transcripts[sessionId] = transcript;
      }
    }
  } finally {
    db.close();
  }

  const enriched = observations.map((row) => {
    const transcript = transcripts[row.session_id] || [];
    const userPrompt = findPromptForObservation(transcript, row.created_at);
    return {
      ...row,
      user_prompt: userPrompt,
    };
  });

  const enrichedOthers = otherSkillObservations.map((row) => {
    const transcript = transcripts[row.session_id] || [];
    const userPrompt = findPromptForObservation(transcript, row.created_at);
    return {
      ...row,
      user_prompt: userPrompt,
    };
  });

  return {
    dbPath,
    dataDir,
    repoRoot,
    skillName,
    observations: enriched,
    otherSkillObservations: enrichedOthers,
  };
}

export function writeTraceDataset(payload, outPath) {
  const { transcripts: _transcripts, ...sanitized } = payload;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf-8');
  return outPath;
}
