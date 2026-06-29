#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_FILE_BYTES = 1024 * 1024;

const SKIP_PATHS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)dist\//,
  /(^|\/)coverage\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /^tests\/fixtures\//,
  /^docs\/index\.html$/,
];

// Redaction tests intentionally contain fake credential-shaped fixtures.
const TEST_FIXTURE_SUBSTRINGS = [
  ['1234567890', 'abcdefghijklmnop'].join(''),
  ['abcdefghijklmnopqrstuvwxyz', '123456'].join(''),
  ['AKIA', '1234567890ABCDEF'].join(''),
  ['AIza', '12345678901234567890123456789012345'].join(''),
  ['sk-test-', 'ABCDEFGHIJKLMNOP1234567890'].join(''),
  ['sk-ant-', 'gateway-status-1234567890'].join(''),
  ['sk-ant-', 'model-catalog-test'].join(''),
  ['sk-ant-', 'oat-cache-'].join(''),
  ['sk-ant-', 'oat-model-catalog-test'].join(''),
  ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
];

const SECRET_PATTERNS = [
  {
    name: 'private key',
    regex: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
  },
  {
    name: 'GitHub token',
    regex: /\bgh[pousr]_[A-Za-z0-9_]{36,255}\b/,
  },
  {
    name: 'OpenAI API key',
    regex: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    name: 'Anthropic API key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    name: 'Slack token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  },
  {
    name: 'AWS access key ID',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    name: 'Google API key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    name: 'high-entropy credential assignment',
    regex:
      /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*['"][A-Za-z0-9_./+=-]{32,}['"]/i,
  },
];

function listTrackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'buffer',
  });
  return output.toString('utf8').split('\0').filter(Boolean);
}

function shouldSkip(file) {
  return SKIP_PATHS.some((pattern) => pattern.test(file));
}

function isAllowedTestFixtureLine(file, line) {
  return (
    file.startsWith('tests/') &&
    TEST_FIXTURE_SUBSTRINGS.some((fixture) => line.includes(fixture))
  );
}

function isBinary(buffer) {
  return buffer.includes(0);
}

function readCandidate(file) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'EISDIR')
    ) {
      return null;
    }
    throw error;
  }

  if (buffer.length > MAX_FILE_BYTES || isBinary(buffer)) return null;
  return buffer.toString('utf8');
}

const findings = [];

for (const file of listTrackedFiles()) {
  if (shouldSkip(file)) continue;

  const text = readCandidate(file);
  if (text === null) continue;

  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.includes('secret-scan: allow-line')) continue;
    if (isAllowedTestFixtureLine(file, line)) continue;

    for (const pattern of SECRET_PATTERNS) {
      if (pattern.regex.test(line)) {
        findings.push({
          file,
          line: index + 1,
          pattern: pattern.name,
        });
      }
    }
  }
}

if (findings.length > 0) {
  console.error('Secret scan found high-confidence credential material:');
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} (${finding.pattern})`);
  }
  process.exit(1);
}

console.log('Secret scan completed with no findings.');
