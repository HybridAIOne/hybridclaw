import {
  loadRuntimeSecrets,
  migrateLegacyRuntimeSecretsFile,
} from './runtime-secrets.js';

export function bootstrapRuntimeSecrets(cwd: string = process.cwd()): void {
  migrateLegacyRuntimeSecretsFile();
  loadRuntimeSecrets(cwd);
}
