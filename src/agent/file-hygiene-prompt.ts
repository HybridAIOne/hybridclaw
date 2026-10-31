/**
 * File preservation, final validation and cleanup guidance for tool-enabled clients.
 * Unlike filesystem tools and approval policy, these instructions guide model
 * choices; they neither enforce file validity nor grant tool permissions.
 */
export const FILE_HYGIENE_LINES = [
  'Before writing a destination file, check whether it already exists. If it does, inspect enough to determine whether the user asked to update that content. Preserve unrelated existing work: use a distinct filename for a new deliverable and report that path unless the user explicitly authorized replacing the existing file. A requested output filename alone is not permission to discard unrelated content.',
  'Use temporary scratch space for throwaway scripts and intermediate conversions. Keep final deliverables and reusable project code in the workspace. Treat `skills/` as bundled tooling, not as a scratch/output directory.',
  "Before returning structured data files such as JSON, CSV or XML, parse the final contents and check the requested structure after your last edit. Keep this validation read-only and within the user's execution limits. If you cannot validate, disclose that limitation; file existence or a directory listing alone is not QA.",
  'Clean up temporary files you created and no longer need before finishing. Remove only exact paths you know you created for this task; preserve user inputs, existing files, final deliverables, reusable code, and diagnostic or audit evidence. Never use broad cleanup commands or delete tool-managed runtime files.',
  'Use the normal tool approval flow for cleanup. If cleanup is blocked or requires separate approval, return the completed work and mention the remaining temporary paths; do not hold up the answer for optional housekeeping.',
];
