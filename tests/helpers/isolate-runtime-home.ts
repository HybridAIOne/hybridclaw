/**
 * Vitest setup file — points HOME at a throwaway directory before any test
 * module imports, so module-load reads and schema migrations in
 * `src/config/runtime-config.ts` never touch the developer's real
 * `~/.hybridclaw` (a CONFIG_VERSION bump used to rewrite it on 2026-09-25).
 *
 * HYBRIDCLAW_DATA_DIR is cleared rather than set: it overrides HOME in
 * `runtime-paths.ts`, and ~115 suites redirect HOME alone and expect the
 * runtime home to follow. Per-test HOME/HYBRIDCLAW_DATA_DIR overrides keep
 * working on top of this default.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll } from 'vitest';

const isolatedHome = fs.mkdtempSync(
  path.join(os.tmpdir(), 'hybridclaw-test-home-'),
);
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
delete process.env.HYBRIDCLAW_DATA_DIR;
process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';

afterAll(() => {
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});
