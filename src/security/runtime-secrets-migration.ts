import fs from 'node:fs';

export interface LegacySecretFileMigrationOptions<TSecrets> {
  filePath: string;
  legacyPath: string;
  tempPath: string;
  expectedSecrets: TSecrets;
  writeTempFile: (tempPath: string) => void;
  validateFinalFile: (filePath: string) => TSecrets;
  areEqual: (left: TSecrets, right: TSecrets) => boolean;
  onValidated: () => void;
  onValidatedBackupRemovalError?: (error: unknown) => void;
}

function removeFileIfExists(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

export function migrateLegacySecretFile<TSecrets>({
  filePath,
  legacyPath,
  tempPath,
  expectedSecrets,
  writeTempFile,
  validateFinalFile,
  areEqual,
  onValidated,
  onValidatedBackupRemovalError,
}: LegacySecretFileMigrationOptions<TSecrets>): void {
  if (fs.existsSync(legacyPath)) {
    throw new Error(
      `legacy backup already exists at ${legacyPath}; remove or restore it before retrying migration`,
    );
  }

  let legacyCreated = false;
  let finalWritten = false;

  try {
    writeTempFile(tempPath);
    fs.renameSync(filePath, legacyPath);
    legacyCreated = true;
    fs.renameSync(tempPath, filePath);
    finalWritten = true;

    const validatedSecrets = validateFinalFile(filePath);
    if (!areEqual(validatedSecrets, expectedSecrets)) {
      throw new Error('read-back validation mismatch');
    }

    onValidated();

    try {
      removeFileIfExists(legacyPath);
    } catch (error) {
      onValidatedBackupRemovalError?.(error);
    }
  } catch (error) {
    removeFileIfExists(tempPath);
    if (legacyCreated) {
      try {
        if (finalWritten && fs.existsSync(filePath)) {
          removeFileIfExists(filePath);
        }
        fs.renameSync(legacyPath, filePath);
      } catch (restoreError) {
        throw new Error(
          `migration rollback failed for ${filePath}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        );
      }
    }
    throw error;
  }
}
