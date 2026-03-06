/**
 * SandboxServiceBackend — "sandbox as tool" pattern.
 *
 * LLM calls happen HERE in the gateway process (API keys never enter the sandbox).
 * Only tool execution (bash, file I/O, browser) runs inside the sandboxed container.
 *
 * Activated via: HYBRIDCLAW_BACKEND=sandbox-service
 * Required env vars:
 *   HYBRIDCLAW_SANDBOX_URL   — base URL of the sandbox-service (e.g. http://localhost:8080)
 *   HYBRIDCLAW_SANDBOX_TOKEN — Bearer token for authentication (optional)
 */
import { getAllSandboxInstances } from '../db.js';
import { logger } from '../logger.js';
import type { ChatMessage, ContainerOutput } from '../types.js';
import { SandboxClient } from '../sandbox/client.js';
import { runAgentLoop } from '../sandbox/agent-loop.js';
import { WorkspaceManager } from '../sandbox/workspace-manager.js';
import { SandboxLifecycleManager } from '../sandbox/lifecycle-manager.js';
import type { ContainerBackend, RunContainerOptions } from './types.js';

export class SandboxServiceBackend implements ContainerBackend {
  private client: SandboxClient;
  private workspace: WorkspaceManager;
  private lifecycle: SandboxLifecycleManager;

  constructor() {
    this.client = new SandboxClient();
    this.workspace = new WorkspaceManager(this.client);
    this.lifecycle = new SandboxLifecycleManager(this.client, this.workspace);
  }

  getActiveCount(): number {
    return getAllSandboxInstances().length;
  }

  stop(sandboxId: string): void {
    void this.client.deleteSandbox(sandboxId).catch(err => {
      logger.debug({ sandboxId, err }, 'Failed to stop sandbox');
    });
  }

  stopAll(): void {
    void this.lifecycle.stopAll();
  }

  async run(
    _sessionId: string,
    messages: ChatMessage[],
    options: RunContainerOptions,
  ): Promise<ContainerOutput> {
    const { chatbotId, agentId = chatbotId } = options;

    // SECURITY: API key stays in the gateway process. It is NOT passed to the sandbox.
    // The runAgentLoop function uses it directly for LLM calls only.

    let sandboxId: string;
    try {
      const sandbox = await this.lifecycle.ensureHealthy(agentId);
      sandboxId = sandbox.sandboxId;
    } catch (err) {
      return {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: `Failed to get sandbox: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Load workspace context from sandbox volume (not host filesystem)
    let contextFiles: { name: string; content: string }[] = [];
    try {
      contextFiles = await this.workspace.loadWorkspaceContext(sandboxId, agentId);
    } catch (err) {
      logger.warn({ agentId, err }, 'Failed to load workspace context, proceeding without it');
    }

    // Inject workspace context into system message
    const contextPrompt = this.workspace.buildContextPrompt(contextFiles);
    const augmentedMessages = injectContext(messages, contextPrompt);

    // Run agent loop in gateway (LLM calls here, tool calls dispatched to sandbox)
    return runAgentLoop(augmentedMessages, sandboxId, {
      chatbotId,
      model: options.model,
      enableRag: options.enableRag,
      agentId,
      channelId: options.channelId,
      allowedTools: options.allowedTools,
      scheduledTasks: options.scheduledTasks,
      onToolProgress: options.onToolProgress,
      abortSignal: options.abortSignal,
    });
  }
}

function injectContext(messages: ChatMessage[], contextPrompt: string): ChatMessage[] {
  if (!contextPrompt) return messages;
  // Find existing system message and prepend context, or add new system message at start
  const systemIdx = messages.findIndex(m => m.role === 'system');
  if (systemIdx >= 0) {
    return messages.map((m, i) =>
      i === systemIdx
        ? { ...m, content: contextPrompt + '\n\n' + m.content }
        : m
    );
  }
  return [{ role: 'system', content: contextPrompt }, ...messages];
}
