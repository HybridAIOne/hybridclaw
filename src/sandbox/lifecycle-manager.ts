/**
 * Sandbox lifecycle manager — manages per-agent persistent sandboxes.
 * Each agent (agentId = chatbotId) gets one sandbox backed by a named volume.
 * Sandbox IDs are persisted in SQLite so they survive gateway restarts.
 */
import {
  deleteSandboxInstance,
  getAllSandboxInstances,
  getSandboxInstance,
  saveSandboxInstance,
  touchSandboxInstance,
} from '../db.js';
import { logger } from '../logger.js';
import type { WorkspaceManager } from './workspace-manager.js';

/** Minimal interface for sandbox client — dependency injection. */
export interface LifecycleClient {
  createSandbox(opts: { volumeId: string }): Promise<{ sandboxId: string }>;
  deleteSandbox(sandboxId: string): Promise<void>;
  runProcess(sandboxId: string, opts: { code: string; language?: string; timeoutMs?: number }): Promise<{ exitCode: number }>;
}

export class SandboxLifecycleManager {
  constructor(
    private client: LifecycleClient,
    private workspace: WorkspaceManager,
  ) {}

  /**
   * Get existing sandbox or create a new one for the agent.
   */
  async getOrCreateSandbox(agentId: string): Promise<{ sandboxId: string; volumeId: string }> {
    const existing = getSandboxInstance(agentId);
    if (existing) {
      touchSandboxInstance(agentId);
      return existing;
    }

    const { volumeId } = await this.workspace.ensureVolume(agentId);
    const { sandboxId } = await this.client.createSandbox({ volumeId });
    await this.workspace.bootstrapWorkspace(sandboxId, agentId);
    saveSandboxInstance(agentId, sandboxId, volumeId);
    logger.info({ agentId, sandboxId, volumeId }, 'Created new sandbox for agent');
    return { sandboxId, volumeId };
  }

  /**
   * Ensure the agent's sandbox exists and is healthy.
   * If unhealthy or missing, recreate it with the same volume.
   */
  async ensureHealthy(agentId: string): Promise<{ sandboxId: string; volumeId: string }> {
    const existing = getSandboxInstance(agentId);

    if (existing) {
      const healthy = await this.healthCheck(existing.sandboxId);
      if (healthy) {
        touchSandboxInstance(agentId);
        return existing;
      }
      logger.warn({ agentId, sandboxId: existing.sandboxId }, 'Sandbox unhealthy, recreating');
      // Clean up the old sandbox (best-effort)
      try {
        await this.client.deleteSandbox(existing.sandboxId);
      } catch {
        // May already be gone
      }
      deleteSandboxInstance(agentId);
    }

    // Create new sandbox
    const { volumeId } = await this.workspace.ensureVolume(agentId);
    const { sandboxId } = await this.client.createSandbox({ volumeId });
    await this.workspace.bootstrapWorkspace(sandboxId, agentId);
    saveSandboxInstance(agentId, sandboxId, volumeId);
    logger.info({ agentId, sandboxId, volumeId }, 'Created sandbox for agent');
    return { sandboxId, volumeId };
  }

  /**
   * Delete the sandbox for an agent.
   */
  async deleteSandbox(agentId: string): Promise<void> {
    const existing = getSandboxInstance(agentId);
    if (!existing) return;

    try {
      await this.client.deleteSandbox(existing.sandboxId);
    } catch (err) {
      logger.warn({ agentId, sandboxId: existing.sandboxId, err }, 'Failed to delete sandbox');
    }
    deleteSandboxInstance(agentId);
    logger.info({ agentId, sandboxId: existing.sandboxId }, 'Deleted sandbox for agent');
  }

  /**
   * Stop all tracked sandboxes (used during graceful shutdown).
   */
  async stopAll(): Promise<void> {
    const instances = getAllSandboxInstances();
    if (instances.length === 0) return;

    logger.info({ count: instances.length }, 'Stopping all tracked sandboxes');
    const results = await Promise.allSettled(
      instances.map(async (instance) => {
        try {
          await this.client.deleteSandbox(instance.sandboxId);
        } catch {
          // Best-effort
        }
        deleteSandboxInstance(instance.agentId);
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      logger.warn({ failed, total: instances.length }, 'Some sandboxes failed to stop');
    }
  }

  private async healthCheck(sandboxId: string): Promise<boolean> {
    try {
      const result = await this.client.runProcess(sandboxId, { code: 'echo ok', language: 'shell' });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}
