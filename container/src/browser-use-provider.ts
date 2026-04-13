import fs from 'node:fs';
import path from 'node:path';

import {
  type BrowserSessionItemView,
  type BrowserSessionView,
  BrowserUse,
  type MessageResponse,
  type ProfileView,
  type ProxyCountryCode,
  type SessionResponse,
  type StopSessionRequest,
  type WorkspaceView,
} from 'browser-use-sdk/v3';

type BrowserUseRunHandle = PromiseLike<SessionResponse> &
  AsyncIterable<MessageResponse> & {
    sessionId: string | null;
    result: SessionResponse | null;
  };

type BrowserUseBrowserSession = BrowserSessionItemView | BrowserSessionView;

type BrowserUseConfig = {
  enabled: boolean;
  provider: 'none' | 'browser-use';
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  defaultProxyCountry: ProxyCountryCode | null;
  enableRecording: boolean;
  maxCostPerTaskUsd: number | null;
  maxSessionTimeoutMinutes: number;
  preferAgentMode: boolean;
  deterministicRerun: boolean;
};

type BrowserUseSessionState = {
  preferredProfileId?: string;
  preferredWorkspaceId?: string;
  browserSessionId?: string;
  browserSession?: BrowserUseBrowserSession;
  browserSessionPromise?: Promise<BrowserUseBrowserSession>;
  browserProfileId?: string;
  browserProxyCountry?: string | null;
  agentSessionId?: string;
  lastRecordingPaths: string[];
};

export type BrowserUseCdpSessionResult = {
  id: string;
  cdpUrl: string;
  liveUrl?: string | null;
  profileId?: string | null;
  proxyCountryCode?: string | null;
  timeoutAt?: string;
  enableRecording: boolean;
};

export type BrowserUseArtifact = {
  path: string;
  filename: string;
  mimeType: string;
};

export type BrowserUseCloseResult = {
  warnings: string[];
  artifacts: BrowserUseArtifact[];
};

export type BrowserUseAgentTaskParams = {
  localSessionId: string;
  task: string;
  outputSchema?: Record<string, unknown>;
  artifactPaths?: string[];
  sessionId?: string;
  proxyCountry?: string;
  model?: string;
  artifactRoot: string;
  progress?: (message: string, raw: MessageResponse) => void;
};

export type BrowserUseAgentTaskResult = {
  sessionId: string;
  status: string;
  isTaskSuccessful: boolean | null | undefined;
  output: unknown;
  outputText: string;
  stepCount: number;
  lastStepSummary?: string | null;
  liveUrl?: string | null;
  profileId?: string | null;
  workspaceId?: string | null;
  llmCostUsd: string;
  proxyCostUsd: string;
  browserCostUsd: string;
  totalCostUsd: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  screenshotUrl?: string | null;
  recordingUrls: string[];
  recordingPaths: string[];
  workspaceArtifactPaths: string[];
  artifacts: BrowserUseArtifact[];
};

export type BrowserUseProfileBindingResult = {
  profile: ProfileView;
  appliesToCurrentSession: boolean;
  appliesToNextSession: boolean;
};

const ENV_FALSEY = new Set(['0', 'false', 'no', 'off']);
const DEFAULT_BASE_URL = 'https://api.browser-use.com/api/v3';
const RECORDING_DOWNLOAD_TIMEOUT_MS = 20_000;

function envFlagEnabled(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return defaultValue;
  return !ENV_FALSEY.has(raw.trim().toLowerCase());
}

function normalizeProvider(
  raw: string,
  fallback: BrowserUseConfig['provider'],
): BrowserUseConfig['provider'] {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'browser-use' || normalized === 'browser_use') {
    return 'browser-use';
  }
  if (normalized === 'none' || normalized === 'local' || normalized === 'off') {
    return 'none';
  }
  return fallback;
}

function normalizeNumber(
  raw: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const parsed = Number.parseFloat(raw);
  let normalized = Number.isFinite(parsed) ? parsed : fallback;
  if (options.min != null && normalized < options.min) normalized = options.min;
  if (options.max != null && normalized > options.max) normalized = options.max;
  return normalized;
}

function normalizeInteger(
  raw: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  return Math.trunc(normalizeNumber(raw, fallback, options));
}

function normalizeProxyCountry(
  raw: string,
  fallback: ProxyCountryCode | null,
): ProxyCountryCode | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'none' || normalized === 'off') return null;
  if (!/^[a-z]{2}$/.test(normalized)) return fallback;
  return normalized as ProxyCountryCode;
}

function getBrowserUseConfig(): BrowserUseConfig {
  const provider = normalizeProvider(
    String(process.env.BROWSER_CLOUD_PROVIDER || ''),
    'none',
  );
  const apiKey = String(process.env.BROWSER_USE_API_KEY || '').trim();
  const baseUrl =
    String(process.env.BROWSER_USE_BASE_URL || '')
      .trim()
      .replace(/\/+$/, '') || DEFAULT_BASE_URL;
  const defaultModel =
    String(process.env.BROWSER_USE_DEFAULT_MODEL || '').trim() ||
    'claude-sonnet-4.6';
  const maxCostPerTaskUsd = normalizeNumber(
    String(process.env.BROWSER_USE_MAX_COST_PER_TASK_USD || ''),
    1,
    { min: 0 },
  );
  return {
    enabled: provider === 'browser-use' && Boolean(apiKey),
    provider,
    apiKey,
    baseUrl,
    defaultModel,
    defaultProxyCountry: normalizeProxyCountry(
      String(process.env.BROWSER_USE_DEFAULT_PROXY_COUNTRY || ''),
      'us',
    ),
    enableRecording: envFlagEnabled('BROWSER_USE_ENABLE_RECORDING', false),
    maxCostPerTaskUsd:
      maxCostPerTaskUsd > 0 ? Number(maxCostPerTaskUsd.toFixed(4)) : null,
    maxSessionTimeoutMinutes: normalizeInteger(
      String(process.env.BROWSER_USE_MAX_SESSION_TIMEOUT_MINUTES || ''),
      30,
      { min: 1, max: 240 },
    ),
    preferAgentMode: envFlagEnabled('BROWSER_USE_PREFER_AGENT_MODE', true),
    deterministicRerun: envFlagEnabled('BROWSER_USE_DETERMINISTIC_RERUN', true),
  };
}

function formatOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output == null) return '';
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function truncateProgress(text: string, maxLength = 240): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

function formatProgressMessage(message: MessageResponse): string {
  const summary = truncateProgress(message.summary || '');
  if (summary) return summary;
  const data = truncateProgress(message.data || '');
  if (data) return data;
  return truncateProgress(message.type || '');
}

function toPosixRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

function isPathInsideRoot(root: string, targetPath: string): boolean {
  const relative = path.relative(root, targetPath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(fullPath);
    }
  };
  if (fs.existsSync(root)) {
    await walk(root);
  }
  return out.sort((left, right) => left.localeCompare(right));
}

async function downloadUrlToFile(url: string, filePath: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    RECORDING_DOWNLOAD_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `download failed (${response.status} ${response.statusText})`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buffer);
  } finally {
    clearTimeout(timer);
  }
}

export class BrowserUseProvider {
  private readonly config = getBrowserUseConfig();
  private readonly states = new Map<string, BrowserUseSessionState>();
  private clientInstance: BrowserUse | null = null;

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getExecutionPreferences(): Pick<
    BrowserUseConfig,
    'enabled' | 'provider' | 'preferAgentMode'
  > {
    return {
      enabled: this.config.enabled,
      provider: this.config.provider,
      preferAgentMode: this.config.preferAgentMode,
    };
  }

  private getClient(): BrowserUse {
    if (!this.config.enabled) {
      throw new Error(
        'Browser Use cloud is not configured. Set browser.cloudProvider to "browser-use" and provide BROWSER_USE_API_KEY.',
      );
    }
    if (!this.clientInstance) {
      this.clientInstance = new BrowserUse({
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseUrl,
      });
    }
    return this.clientInstance;
  }

  private getState(localSessionId: string): BrowserUseSessionState {
    let state = this.states.get(localSessionId);
    if (!state) {
      state = {
        lastRecordingPaths: [],
      };
      this.states.set(localSessionId, state);
    }
    return state;
  }

  private activeBrowserUsesProfile(
    state: BrowserUseSessionState,
    profileId: string,
  ): boolean {
    return (
      Boolean(state.browserSessionId) && state.browserProfileId === profileId
    );
  }

  getTrackedSessionIds(): string[] {
    const tracked: string[] = [];
    for (const [localSessionId, state] of this.states.entries()) {
      if (!state.browserSessionId && !state.agentSessionId) continue;
      tracked.push(localSessionId);
    }
    return tracked.sort((left, right) => left.localeCompare(right));
  }

  getLatestRecordingArtifacts(localSessionId: string): BrowserUseArtifact[] {
    const state = this.states.get(localSessionId);
    if (!state?.lastRecordingPaths.length) return [];
    return state.lastRecordingPaths
      .filter((filePath) => fs.existsSync(filePath))
      .map((filePath) => ({
        path: filePath,
        filename: path.basename(filePath),
        mimeType: 'video/mp4',
      }));
  }

  shouldUseCloudCdp(params: {
    localSessionId: string;
    proxyCountry?: string;
    timeoutMinutes?: number;
  }): boolean {
    if (!this.config.enabled) return false;
    if (params.proxyCountry?.trim()) return true;
    if (
      typeof params.timeoutMinutes === 'number' &&
      Number.isFinite(params.timeoutMinutes)
    ) {
      return true;
    }
    const state = this.states.get(params.localSessionId);
    return Boolean(
      state?.preferredProfileId ||
        state?.browserSessionId ||
        state?.browserSessionPromise,
    );
  }

  private async ensureWorkspace(
    localSessionId: string,
  ): Promise<WorkspaceView | null> {
    const state = this.getState(localSessionId);
    const workspaceId = state.preferredWorkspaceId;
    const client = this.getClient();
    if (workspaceId) {
      try {
        return await client.workspaces.get(workspaceId);
      } catch {
        state.preferredWorkspaceId = undefined;
      }
    }
    const workspace = await client.workspaces.create({
      name: `HybridClaw ${localSessionId}`,
    });
    state.preferredWorkspaceId = workspace.id;
    return workspace;
  }

  private async uploadArtifactPaths(
    workspaceId: string,
    artifactRoot: string,
    artifactPaths: string[],
  ): Promise<void> {
    const client = this.getClient();
    if (artifactPaths.length === 0) return;
    const seen = new Set<string>();
    const files: Array<{ absolutePath: string; relativePath: string }> = [];
    for (const rawPath of artifactPaths) {
      const normalized = rawPath.trim();
      if (!normalized) continue;
      const absolutePath = path.resolve(artifactRoot, normalized);
      if (!isPathInsideRoot(artifactRoot, absolutePath)) {
        throw new Error(
          `artifact path must stay under .browser-artifacts: ${normalized}`,
        );
      }
      const stat = await fs.promises.stat(absolutePath).catch(() => null);
      if (!stat?.isFile()) {
        throw new Error(
          `artifact path does not exist or is not a file: ${normalized}`,
        );
      }
      const relativePath = toPosixRelative(artifactRoot, absolutePath);
      if (
        !relativePath ||
        relativePath.startsWith('..') ||
        seen.has(relativePath)
      ) {
        continue;
      }
      seen.add(relativePath);
      files.push({ absolutePath, relativePath });
    }
    for (const file of files) {
      const prefix = path.posix.dirname(file.relativePath);
      await client.workspaces.upload(
        workspaceId,
        file.absolutePath,
        prefix === '.' ? {} : { prefix },
      );
    }
  }

  private async downloadWorkspaceArtifacts(
    workspaceId: string,
    artifactRoot: string,
    localSessionId: string,
    remoteSessionId: string,
  ): Promise<BrowserUseArtifact[]> {
    const downloadRoot = path.join(
      artifactRoot,
      'browser-use-workspaces',
      localSessionId,
      remoteSessionId,
    );
    await fs.promises.rm(downloadRoot, { recursive: true, force: true });
    await fs.promises.mkdir(downloadRoot, { recursive: true });
    await this.getClient().workspaces.downloadAll(workspaceId, {
      to: downloadRoot,
    });
    const files = await listFilesRecursive(downloadRoot);
    return files.map((filePath) => ({
      path: filePath,
      filename: path.basename(filePath),
      mimeType: 'application/octet-stream',
    }));
  }

  private async resolveReusableAgentSession(
    requestedSessionId: string | undefined,
    localSessionId: string,
  ): Promise<string | null> {
    const state = this.getState(localSessionId);
    const candidate = requestedSessionId?.trim() || state.agentSessionId || '';
    if (!candidate) return null;
    try {
      const session = await this.getClient().sessions.get(candidate);
      if (session.status === 'idle') {
        state.agentSessionId = session.id;
        return session.id;
      }
      if (
        session.status === 'stopped' ||
        session.status === 'timed_out' ||
        session.status === 'error'
      ) {
        if (state.agentSessionId === candidate) {
          state.agentSessionId = undefined;
        }
        return null;
      }
      throw new Error(
        `Browser Use session ${candidate} is ${session.status}. Wait for it to become idle or close it first.`,
      );
    } catch (err) {
      if (state.agentSessionId === candidate) {
        state.agentSessionId = undefined;
      }
      if (requestedSessionId) {
        throw err;
      }
      return null;
    }
  }

  async createProfile(params: {
    localSessionId: string;
    name?: string;
    userId?: string;
  }): Promise<BrowserUseProfileBindingResult> {
    const profile = await this.getClient().profiles.create({
      ...(params.name?.trim() ? { name: params.name.trim() } : {}),
      ...(params.userId?.trim() ? { userId: params.userId.trim() } : {}),
    });
    const state = this.getState(params.localSessionId);
    state.preferredProfileId = profile.id;
    return {
      profile,
      appliesToCurrentSession: this.activeBrowserUsesProfile(state, profile.id),
      appliesToNextSession: true,
    };
  }

  async loadProfile(params: {
    localSessionId: string;
    profileId?: string;
    query?: string;
    userId?: string;
  }): Promise<BrowserUseProfileBindingResult> {
    const client = this.getClient();
    const state = this.getState(params.localSessionId);
    let profile: ProfileView | null = null;
    if (params.profileId?.trim()) {
      profile = await client.profiles.get(params.profileId.trim());
    } else {
      const listing = await client.profiles.list({
        ...(params.query?.trim() ? { query: params.query.trim() } : {}),
        page: 1,
        page_size: 100,
      });
      const matches = listing.items.filter((entry) => {
        if (params.userId?.trim() && entry.userId !== params.userId.trim()) {
          return false;
        }
        if (!params.query?.trim()) return true;
        const needle = params.query.trim().toLowerCase();
        return (
          String(entry.name || '').toLowerCase() === needle ||
          String(entry.id || '').toLowerCase() === needle
        );
      });
      profile = matches[0] || null;
    }
    if (!profile) {
      throw new Error('Browser Use profile not found.');
    }
    state.preferredProfileId = profile.id;
    return {
      profile,
      appliesToCurrentSession: this.activeBrowserUsesProfile(state, profile.id),
      appliesToNextSession: true,
    };
  }

  async ensureCdpSession(params: {
    localSessionId: string;
    proxyCountry?: string;
    timeoutMinutes?: number;
  }): Promise<BrowserUseCdpSessionResult> {
    const state = this.getState(params.localSessionId);
    if (
      state.browserSession?.status === 'active' &&
      state.browserSession.cdpUrl
    ) {
      return {
        id: state.browserSession.id,
        cdpUrl: state.browserSession.cdpUrl,
        liveUrl: state.browserSession.liveUrl,
        profileId: state.browserProfileId,
        proxyCountryCode: state.browserProxyCountry,
        timeoutAt: state.browserSession.timeoutAt,
        enableRecording: this.config.enableRecording,
      };
    }
    if (state.browserSessionPromise) {
      const session = await state.browserSessionPromise;
      if (!session.cdpUrl) {
        throw new Error('Browser Use did not return a CDP URL.');
      }
      return {
        id: session.id,
        cdpUrl: session.cdpUrl,
        liveUrl: session.liveUrl,
        profileId: state.browserProfileId,
        proxyCountryCode: state.browserProxyCountry,
        timeoutAt: session.timeoutAt,
        enableRecording: this.config.enableRecording,
      };
    }

    const proxyCountry = normalizeProxyCountry(
      params.proxyCountry || '',
      this.config.defaultProxyCountry,
    );
    state.browserSessionPromise = this.getClient()
      .browsers.create({
        ...(state.preferredProfileId
          ? { profileId: state.preferredProfileId }
          : {}),
        proxyCountryCode: proxyCountry,
        timeout: Math.min(
          240,
          Math.max(
            1,
            params.timeoutMinutes || this.config.maxSessionTimeoutMinutes,
          ),
        ),
        enableRecording: this.config.enableRecording,
      })
      .then((session) => {
        state.browserSessionId = session.id;
        state.browserSession = session;
        state.browserProfileId = state.preferredProfileId;
        state.browserProxyCountry = proxyCountry;
        return session;
      })
      .finally(() => {
        state.browserSessionPromise = undefined;
      });

    const session = await state.browserSessionPromise;
    if (!session.cdpUrl) {
      throw new Error('Browser Use did not return a CDP URL.');
    }
    return {
      id: session.id,
      cdpUrl: session.cdpUrl,
      liveUrl: session.liveUrl,
      profileId: state.browserProfileId,
      proxyCountryCode: state.browserProxyCountry,
      timeoutAt: session.timeoutAt,
      enableRecording: this.config.enableRecording,
    };
  }

  private async maybeDownloadRecordingUrls(
    localSessionId: string,
    recordingUrls: string[],
    artifactRoot: string,
    prefix: 'session' | 'browser',
  ): Promise<BrowserUseArtifact[]> {
    const state = this.getState(localSessionId);
    if (recordingUrls.length === 0) {
      state.lastRecordingPaths = [];
      return [];
    }

    const recordingDir = path.join(artifactRoot, 'recordings');
    await fs.promises.mkdir(recordingDir, { recursive: true });
    const artifacts: BrowserUseArtifact[] = [];
    for (const [index, url] of recordingUrls.entries()) {
      const filePath = path.join(
        recordingDir,
        `${prefix}-${localSessionId}-${index + 1}.mp4`,
      );
      await downloadUrlToFile(url, filePath);
      artifacts.push({
        path: filePath,
        filename: path.basename(filePath),
        mimeType: 'video/mp4',
      });
    }
    state.lastRecordingPaths = artifacts.map((entry) => entry.path);
    return artifacts;
  }

  async runAgentTask(
    params: BrowserUseAgentTaskParams,
  ): Promise<BrowserUseAgentTaskResult> {
    const client = this.getClient();
    const state = this.getState(params.localSessionId);
    const reusableSessionId = await this.resolveReusableAgentSession(
      params.sessionId,
      params.localSessionId,
    );
    const workspace = await this.ensureWorkspace(params.localSessionId);
    if (workspace && params.artifactPaths?.length) {
      await this.uploadArtifactPaths(
        workspace.id,
        params.artifactRoot,
        params.artifactPaths,
      );
    }

    const runOptions: Record<string, unknown> = {
      model: params.model?.trim() || this.config.defaultModel,
      keepAlive: true,
      ...(this.config.maxCostPerTaskUsd != null
        ? { maxCostUsd: this.config.maxCostPerTaskUsd }
        : {}),
      ...(params.outputSchema ? { outputSchema: params.outputSchema } : {}),
      ...(this.config.enableRecording ? { enableRecording: true } : {}),
      ...(this.config.deterministicRerun && workspace?.id
        ? { cacheScript: true, autoHeal: true }
        : {}),
    };
    if (reusableSessionId) {
      runOptions.sessionId = reusableSessionId;
    } else {
      if (state.preferredProfileId) {
        runOptions.profileId = state.preferredProfileId;
      }
      if (workspace?.id) {
        runOptions.workspaceId = workspace.id;
      }
      const proxyCountry = normalizeProxyCountry(
        params.proxyCountry || '',
        this.config.defaultProxyCountry,
      );
      if (proxyCountry !== undefined) {
        runOptions.proxyCountryCode = proxyCountry;
      }
    }

    const run = client.run(
      params.task,
      runOptions as never,
    ) as BrowserUseRunHandle;
    let lastProgress = '';
    for await (const message of run) {
      if (run.sessionId) {
        state.agentSessionId = run.sessionId;
      }
      if (message.hidden) continue;
      const formatted = formatProgressMessage(message);
      if (!formatted || formatted === lastProgress) continue;
      lastProgress = formatted;
      params.progress?.(formatted, message);
    }

    const result = (run.result as SessionResponse | null) ?? (await run);
    state.agentSessionId = result.id;
    state.preferredProfileId = result.profileId || state.preferredProfileId;
    state.preferredWorkspaceId = result.workspaceId || workspace?.id;

    const workspaceArtifacts = state.preferredWorkspaceId
      ? await this.downloadWorkspaceArtifacts(
          state.preferredWorkspaceId,
          params.artifactRoot,
          params.localSessionId,
          result.id,
        )
      : [];

    const recordingUrls =
      result.recordingUrls.length > 0
        ? result.recordingUrls
        : this.config.enableRecording
          ? await client.sessions.waitForRecording(result.id)
          : [];
    const recordingArtifacts = await this.maybeDownloadRecordingUrls(
      params.localSessionId,
      recordingUrls,
      params.artifactRoot,
      'session',
    );

    return {
      sessionId: result.id,
      status: result.status,
      isTaskSuccessful: result.isTaskSuccessful,
      output: result.output,
      outputText: formatOutputText(result.output),
      stepCount: result.stepCount,
      lastStepSummary: result.lastStepSummary,
      liveUrl: result.liveUrl,
      profileId: result.profileId,
      workspaceId: result.workspaceId,
      llmCostUsd: result.llmCostUsd,
      proxyCostUsd: result.proxyCostUsd,
      browserCostUsd: result.browserCostUsd,
      totalCostUsd: result.totalCostUsd,
      totalInputTokens: result.totalInputTokens,
      totalOutputTokens: result.totalOutputTokens,
      screenshotUrl: result.screenshotUrl,
      recordingUrls,
      recordingPaths: recordingArtifacts.map((entry) => entry.path),
      workspaceArtifactPaths: workspaceArtifacts.map((entry) => entry.path),
      artifacts: [...workspaceArtifacts, ...recordingArtifacts],
    };
  }

  private async stopAgentSession(
    localSessionId: string,
    artifactRoot: string,
  ): Promise<BrowserUseCloseResult> {
    const state = this.getState(localSessionId);
    const warnings: string[] = [];
    const artifacts: BrowserUseArtifact[] = [];
    if (!state.agentSessionId) {
      return { warnings, artifacts };
    }
    try {
      const stopped = await this.getClient().sessions.stop(
        state.agentSessionId,
        {
          strategy: 'session',
        } satisfies StopSessionRequest,
      );
      const recordingUrls =
        stopped.recordingUrls.length > 0
          ? stopped.recordingUrls
          : this.config.enableRecording
            ? await this.getClient().sessions.waitForRecording(stopped.id)
            : [];
      artifacts.push(
        ...(await this.maybeDownloadRecordingUrls(
          localSessionId,
          recordingUrls,
          artifactRoot,
          'session',
        )),
      );
    } catch (err) {
      warnings.push(
        err instanceof Error
          ? err.message
          : 'failed to stop Browser Use session',
      );
    } finally {
      state.agentSessionId = undefined;
    }
    return { warnings, artifacts };
  }

  private async stopBrowserSession(
    localSessionId: string,
    artifactRoot: string,
  ): Promise<BrowserUseCloseResult> {
    const state = this.getState(localSessionId);
    const warnings: string[] = [];
    const artifacts: BrowserUseArtifact[] = [];
    if (!state.browserSessionId) {
      return { warnings, artifacts };
    }
    try {
      const stopped = await this.getClient().browsers.stop(
        state.browserSessionId,
      );
      const recordingArtifacts =
        stopped.recordingUrl && this.config.enableRecording
          ? await this.maybeDownloadRecordingUrls(
              localSessionId,
              [stopped.recordingUrl],
              artifactRoot,
              'browser',
            )
          : [];
      artifacts.push(...recordingArtifacts);
    } catch (err) {
      warnings.push(
        err instanceof Error
          ? err.message
          : 'failed to stop Browser Use browser',
      );
    } finally {
      state.browserSessionId = undefined;
      state.browserSession = undefined;
      state.browserProfileId = undefined;
      state.browserProxyCountry = undefined;
    }
    return { warnings, artifacts };
  }

  async closeLocalSession(
    localSessionId: string,
    artifactRoot: string,
  ): Promise<BrowserUseCloseResult> {
    if (!this.config.enabled) {
      return { warnings: [], artifacts: [] };
    }
    const sessionStop = await this.stopAgentSession(
      localSessionId,
      artifactRoot,
    );
    const browserStop = await this.stopBrowserSession(
      localSessionId,
      artifactRoot,
    );
    return {
      warnings: [...sessionStop.warnings, ...browserStop.warnings],
      artifacts: [...sessionStop.artifacts, ...browserStop.artifacts],
    };
  }
}

export const browserUseProvider = new BrowserUseProvider();
