import fs from 'node:fs';

import YAML from 'yaml';
import type {
  SkillPolicyAccessEvaluation,
  SkillPolicyAccessInput,
  SkillPolicyAction,
  SkillPolicyActionType,
  SkillPolicyRule,
  SkillPolicyState,
} from '../../container/shared/skill-policy.js';
import {
  DEFAULT_SKILL_POLICY_ACTION,
  evaluateSkillPolicyAccess,
  readSkillPolicyState,
} from '../../container/shared/skill-policy.js';
import { resolveWorkspacePolicyPath } from './policy-store.js';

export type {
  SkillPolicyAccessEvaluation,
  SkillPolicyAccessInput,
  SkillPolicyAction,
  SkillPolicyActionType,
  SkillPolicyRule,
  SkillPolicyState,
};

export {
  DEFAULT_SKILL_POLICY_ACTION,
  evaluateSkillPolicyAccess,
  readSkillPolicyState,
};

function readRawPolicyObject(policyPath: string): Record<string, unknown> {
  if (!fs.existsSync(policyPath)) return {};
  const parsed = YAML.parse(fs.readFileSync(policyPath, 'utf-8')) as unknown;
  if (!parsed) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Policy file must contain a YAML mapping: ${policyPath}`);
  }
  return parsed as Record<string, unknown>;
}

export function readWorkspaceSkillPolicyState(
  workspacePath: string,
): SkillPolicyState {
  return readSkillPolicyState(
    readRawPolicyObject(resolveWorkspacePolicyPath(workspacePath)),
  );
}
