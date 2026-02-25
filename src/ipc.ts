import fs from 'fs';
import path from 'path';

import { CONTAINER_MAX_OUTPUT_SIZE, DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { ContainerInput, ContainerOutput } from './types.js';

/**
 * Get session directory, creating it if needed.
 */
function sessionDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(DATA_DIR, 'sessions', safe);
  return dir;
}

function ipcDir(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'ipc');
}

function agentDir(agentId: string): string {
  const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_DIR, 'agents', safe);
}

export function agentWorkspaceDir(agentId: string): string {
  return path.join(agentDir(agentId), 'workspace');
}

/**
 * Ensure session directories exist (IPC only).
 */
export function ensureSessionDirs(sessionId: string): void {
  fs.mkdirSync(ipcDir(sessionId), { recursive: true });
}

/**
 * Ensure agent workspace directory exists, migrating from legacy session workspace if needed.
 */
export function ensureAgentDirs(agentId: string): void {
  const wsDir = agentWorkspaceDir(agentId);
  if (!fs.existsSync(wsDir)) {
    fs.mkdirSync(wsDir, { recursive: true });
    migrateWorkspace(agentId, wsDir);
  }
}

/**
 * Write input for the container agent.
 * When omitApiKey is set, the apiKey field is excluded from the file on disk
 * (the container already has the key in memory from the initial stdin payload).
 */
export function writeInput(sessionId: string, input: ContainerInput, opts?: { omitApiKey?: boolean }): string {
  const dir = ipcDir(sessionId);
  const inputPath = path.join(dir, 'input.json');
  const toWrite = opts?.omitApiKey ? { ...input, apiKey: '' } : input;
  fs.writeFileSync(inputPath, JSON.stringify(toWrite, null, 2));
  logger.debug({ sessionId, path: inputPath }, 'Wrote IPC input');
  return inputPath;
}

/**
 * Read output from the container agent. Polls until file appears or timeout.
 */
export async function readOutput(
  sessionId: string,
  timeoutMs: number,
): Promise<ContainerOutput> {
  const dir = ipcDir(sessionId);
  const outputPath = path.join(dir, 'output.json');

  const start = Date.now();
  const pollInterval = 250;

  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      if (stat.size > CONTAINER_MAX_OUTPUT_SIZE) {
        fs.unlinkSync(outputPath);
        logger.warn({ sessionId, size: stat.size, limit: CONTAINER_MAX_OUTPUT_SIZE }, 'Container output exceeded size limit');
        return { status: 'error', result: null, toolsUsed: [], error: `Output too large (${stat.size} bytes, limit ${CONTAINER_MAX_OUTPUT_SIZE})` };
      }
      try {
        const raw = fs.readFileSync(outputPath, 'utf-8');
        const output: ContainerOutput = JSON.parse(raw);
        // Clean up output file after reading
        fs.unlinkSync(outputPath);
        logger.debug({ sessionId }, 'Read IPC output');
        return output;
      } catch (err) {
        // File might be partially written, wait and retry
        logger.debug({ sessionId, err }, 'Output file not ready, retrying');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return {
    status: 'error',
    result: null,
    toolsUsed: [],
    error: `Timeout waiting for container output after ${timeoutMs}ms`,
  };
}

/**
 * Clean up IPC files for a session.
 */
export function cleanupIpc(sessionId: string): void {
  const dir = ipcDir(sessionId);
  for (const file of ['input.json', 'output.json', 'history.json']) {
    const filePath = path.join(dir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

/**
 * Get host paths for container mounting.
 */
export function getSessionPaths(sessionId: string, agentId: string): {
  ipcPath: string;
  workspacePath: string;
} {
  return {
    ipcPath: path.resolve(ipcDir(sessionId)),
    workspacePath: path.resolve(agentWorkspaceDir(agentId)),
  };
}

/**
 * One-time migration: copy workspace files from legacy session dir to agent dir.
 */
function migrateWorkspace(agentId: string, targetDir: string): void {
  // Check common legacy session workspace locations
  const candidates = [
    path.join(DATA_DIR, 'sessions', 'tui_local', 'workspace'),
    path.join(DATA_DIR, 'sessions', 'tui:local', 'workspace'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const files = fs.readdirSync(candidate);
        if (files.length === 0) continue;
        for (const file of files) {
          const src = path.join(candidate, file);
          const dest = path.join(targetDir, file);
          if (!fs.existsSync(dest)) {
            const stat = fs.statSync(src);
            if (stat.isFile()) {
              fs.copyFileSync(src, dest);
            } else if (stat.isDirectory()) {
              fs.cpSync(src, dest, { recursive: true });
            }
          }
        }
        logger.info({ agentId, from: candidate }, 'Migrated workspace from legacy session dir');
        return;
      } catch (err) {
        logger.warn({ agentId, from: candidate, err }, 'Failed to migrate workspace');
      }
    }
  }
}
