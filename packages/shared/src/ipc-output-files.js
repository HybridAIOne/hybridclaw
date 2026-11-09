/**
 * Reply-file naming shared by the gateway reader and the agent writer: each
 * request replies in `output-<requestId>.json`, so a stopped agent's late reply
 * lands where no later request reads and cannot overwrite a later request's
 * reply. Requests without an id reply in `output.json`.
 * NOT the input or health-probe files; each side names those itself.
 */
export const LEGACY_IPC_OUTPUT_FILE = 'output.json';

export function ipcOutputFileName(requestId) {
  if (!requestId) return LEGACY_IPC_OUTPUT_FILE;
  // The id arrives over IPC; keep the name inside the IPC directory.
  return `output-${String(requestId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
}

export function isIpcOutputFileName(name) {
  return (
    name === LEGACY_IPC_OUTPUT_FILE ||
    /^output-[a-zA-Z0-9_-]+\.json$/.test(name)
  );
}
