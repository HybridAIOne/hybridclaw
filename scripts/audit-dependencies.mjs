#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const severityRank = new Map([
  ['info', 0],
  ['low', 1],
  ['moderate', 2],
  ['high', 3],
  ['critical', 4],
]);
const auditThreshold = severityRank.get('moderate');
const allowlistPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'dependency-audit-allowlist.json',
);

function advisoryId(via) {
  if (typeof via?.url !== 'string') return null;
  const match = via.url.match(/\/(GHSA-[a-z0-9-]+)$/iu);
  return match?.[1] || null;
}

function relevantVulnerabilities(audit) {
  return Object.fromEntries(
    Object.entries(audit.vulnerabilities || {}).filter(([, vulnerability]) => {
      const rank = severityRank.get(vulnerability.severity);
      return rank !== undefined && rank >= auditThreshold;
    }),
  );
}

export function evaluateAudit(audit, allowlist, now = new Date()) {
  const vulnerabilities = relevantVulnerabilities(audit);
  const seenAdvisories = new Set();
  const errors = [];

  for (const [id, exception] of Object.entries(allowlist)) {
    if (!/^GHSA-[a-z0-9-]+$/iu.test(id)) {
      errors.push(`invalid advisory id ${id}`);
      continue;
    }
    if (
      typeof exception?.expires !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(exception.expires)
    ) {
      errors.push(`${id} must have an expires date in YYYY-MM-DD format`);
      continue;
    }
    if (
      typeof exception.reason !== 'string' ||
      exception.reason.trim().length === 0
    ) {
      errors.push(`${id} must include a reason`);
    }
    const expiresAt = Date.parse(`${exception.expires}T23:59:59.999Z`);
    if (!Number.isFinite(expiresAt) || now.getTime() > expiresAt) {
      errors.push(`${id} expired on ${exception.expires}`);
    }
  }

  function collectAdvisories(name, visiting = new Set()) {
    if (visiting.has(name)) return new Set();
    const vulnerability = vulnerabilities[name];
    if (!vulnerability || !Array.isArray(vulnerability.via)) {
      return new Set([`dependency:${name}`]);
    }

    const nextVisiting = new Set(visiting);
    nextVisiting.add(name);
    const causes = new Set();
    for (const via of vulnerability.via) {
      if (typeof via === 'string') {
        for (const cause of collectAdvisories(via, nextVisiting)) {
          causes.add(cause);
        }
        continue;
      }
      const id = advisoryId(via);
      if (id) {
        seenAdvisories.add(id);
        causes.add(id);
      } else {
        causes.add(`advisory:${via?.source || 'unknown'}`);
      }
    }
    return causes;
  }

  const allowed = [];
  const unallowed = [];
  for (const name of Object.keys(vulnerabilities).sort()) {
    const causes = collectAdvisories(name);
    const accepted =
      causes.size > 0 &&
      [...causes].every((id) => Object.hasOwn(allowlist, id));
    (accepted ? allowed : unallowed).push(name);
  }

  for (const id of Object.keys(allowlist)) {
    if (!seenAdvisories.has(id)) {
      errors.push(`${id} is stale because the advisory is not present`);
    }
  }

  return { allowed, unallowed, errors };
}

function runAudit(args) {
  const result = spawnSync('npm', ['audit', '--json', ...args], {
    encoding: 'utf8',
  });
  if (result.error) {
    return { error: result.error.message, status: result.status ?? 1 };
  }
  try {
    const audit = JSON.parse(result.stdout);
    if (audit.error) {
      return {
        error: audit.error.summary || audit.error.message || 'npm audit failed',
        status: result.status ?? 1,
      };
    }
    return { audit, status: result.status ?? 1 };
  } catch {
    return {
      error:
        result.stderr || result.stdout || 'npm audit returned invalid JSON',
      status: result.status ?? 1,
    };
  }
}

export function main() {
  const production = runAudit(['--omit=dev', '--audit-level=moderate']);
  if (production.error) {
    console.error(`dependency-audit: ${production.error}`);
    return production.status;
  }
  if (production.status !== 0) {
    const names = Object.keys(relevantVulnerabilities(production.audit)).sort();
    console.error(
      `dependency-audit: production vulnerabilities: ${names.join(', ')}`,
    );
    return production.status;
  }

  let allowlist;
  try {
    allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  } catch (error) {
    console.error(`dependency-audit: cannot read allowlist: ${error.message}`);
    return 1;
  }

  const full = runAudit(['--audit-level=moderate']);
  if (full.error) {
    console.error(`dependency-audit: ${full.error}`);
    return full.status;
  }
  const result = evaluateAudit(full.audit, allowlist);
  if (result.allowed.length > 0) {
    console.warn(
      `dependency-audit: accepted reviewed development-only vulnerabilities: ${result.allowed.join(', ')}`,
    );
  }
  for (const error of result.errors) {
    console.error(`dependency-audit: ${error}`);
  }
  if (result.unallowed.length > 0) {
    console.error(
      `dependency-audit: unreviewed vulnerabilities: ${result.unallowed.join(', ')}`,
    );
  }
  return result.errors.length === 0 && result.unallowed.length === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  process.exitCode = main();
}
