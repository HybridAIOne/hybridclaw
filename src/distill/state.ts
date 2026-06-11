import type { DistillPaths } from './paths.js';
import { readJsonFile, sha256Hex, writeJsonFile } from './paths.js';
import type { DistillState, ExtractionClaim } from './types.js';

export function loadDistillState(paths: DistillPaths): DistillState {
  return (
    readJsonFile<DistillState>(paths.statePath) || {
      version: 1,
      subject: paths.subject,
      analysedDocIds: [],
      claims: [],
      mergeHistory: [],
    }
  );
}

export function saveDistillState(
  paths: DistillPaths,
  state: DistillState,
): void {
  writeJsonFile(paths.statePath, state);
}

export function makeClaimId(claim: ExtractionClaim): string {
  return `claim_${sha256Hex(`${claim.dimension}\n${claim.claim}`).slice(0, 12)}`;
}
