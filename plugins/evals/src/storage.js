import fs from 'node:fs';
import path from 'node:path';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function ensureEvalDirs(config) {
  ensureDir(config.dataDir);
  ensureDir(config.runsDir);
  ensureDir(config.cacheDir);
}

export function writeRunRecord(config, runRecord) {
  ensureEvalDirs(config);
  const filePath = path.join(config.runsDir, `${runRecord.runId}.json`);
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(runRecord, null, 2)}\n`,
    'utf-8',
  );
  return filePath;
}

export function listRunRecords(config, options = {}) {
  ensureEvalDirs(config);
  const files = fs
    .readdirSync(config.runsDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .reverse();
  const records = [];
  for (const file of files) {
    try {
      const fullPath = path.join(config.runsDir, file);
      const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      if (
        options.benchmark &&
        String(parsed.benchmark || '').toLowerCase() !==
          String(options.benchmark).toLowerCase()
      ) {
        continue;
      }
      records.push({
        ...parsed,
        filePath: fullPath,
      });
      if (records.length >= (options.limit || 10)) {
        break;
      }
    } catch {
      // Ignore malformed run files.
    }
  }
  return records;
}
