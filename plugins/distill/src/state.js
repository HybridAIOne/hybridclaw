import { readJsonFile, sha256Hex, writeJsonFile } from './paths.js';

export function loadDistillState(paths) {
  return (
    readJsonFile(paths.statePath) || {
      version: 1,
      subject: paths.subject,
      analysedDocIds: [],
      claims: [],
      mergeHistory: [],
    }
  );
}

export function saveDistillState(paths, state) {
  writeJsonFile(paths.statePath, state);
}

export function makeClaimId(claim) {
  return `claim_${sha256Hex(`${claim.dimension}\n${claim.claim}`).slice(0, 12)}`;
}
