import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { expandHomePath } from '../utils/path.js';

export const CONTAINER_BEHAVIOR_ANOMALY_TRAJECTORY_STORE_DIR =
  '/hybridclaw-trajectories';

export function resolveBehaviorAnomalyTrajectoryStoreDir(): string {
  const configured =
    getRuntimeConfig().adaptiveSkills.trajectoryCapture.storeDir.trim();
  if (!configured) return path.join(DATA_DIR, 'trajectories');
  const expanded = expandHomePath(configured);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(DEFAULT_RUNTIME_HOME_DIR, expanded);
}

export function ensureBehaviorAnomalyTrajectoryStoreDir(): string {
  const storeDir = resolveBehaviorAnomalyTrajectoryStoreDir();
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  return storeDir;
}
