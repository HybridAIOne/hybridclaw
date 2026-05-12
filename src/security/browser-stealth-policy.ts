import fs from 'node:fs';

import YAML from 'yaml';
import {
  type BrowserStealthPolicyContext,
  type BrowserStealthPolicyDecision,
  type BrowserStealthPolicyState,
  evaluateBrowserStealthPolicyAccess,
  readBrowserStealthPolicyStateFromDocument,
} from '../../container/shared/browser-stealth-policy.js';
import { resolveWorkspacePolicyPath } from '../policy/policy-store.js';

export type {
  BrowserStealthPolicyContext,
  BrowserStealthPolicyDecision,
  BrowserStealthPolicyState,
};

type CachedPolicyState = {
  mtimeMs: number;
  size: number;
  state: BrowserStealthPolicyState;
};

const browserStealthPolicyStateCache = new Map<string, CachedPolicyState>();

function readPolicyDocument(policyPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(policyPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse policy file ${policyPath}: ${message}`);
  }
  if (!parsed) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Policy file must contain a YAML mapping: ${policyPath}`);
  }
  return parsed as Record<string, unknown>;
}

export function readWorkspaceBrowserStealthPolicyState(
  workspacePath: string,
): BrowserStealthPolicyState {
  const policyPath = resolveWorkspacePolicyPath(workspacePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(policyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      browserStealthPolicyStateCache.delete(policyPath);
      return readBrowserStealthPolicyStateFromDocument({});
    }
    throw err;
  }

  const cached = browserStealthPolicyStateCache.get(policyPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.state;
  }

  const state = readBrowserStealthPolicyStateFromDocument(
    readPolicyDocument(policyPath),
  );
  browserStealthPolicyStateCache.set(policyPath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    state,
  });
  return state;
}

export function clearBrowserStealthPolicyStateCache(): void {
  browserStealthPolicyStateCache.clear();
}
export {
  evaluateBrowserStealthPolicyAccess,
  readBrowserStealthPolicyStateFromDocument,
};

export function assertBrowserStealthAllowed(params: {
  workspacePath: string;
  context: BrowserStealthPolicyContext;
}): void {
  const state = readWorkspaceBrowserStealthPolicyState(params.workspacePath);
  const evaluation = evaluateBrowserStealthPolicyAccess({
    state,
    context: params.context,
  });
  if (evaluation.decision === 'allow') return;
  throw new Error(
    `Camofox stealth browser mode is not allowlisted for host ${params.context.host}. Add a browser.stealth policy rule with the browser_stealth_allowed predicate before using stealth on this host.`,
  );
}
