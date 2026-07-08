import { requestHeaders, requestJson, throwResponseError } from './client';

export type AppCategory =
  | 'apps'
  | 'documents'
  | 'games'
  | 'productivity'
  | 'creative'
  | 'quiz'
  | 'scratch';

export type AppVisibility = 'private' | 'public';

export type AppKind = 'web' | 'live';

export interface AppSummary {
  id: string;
  title: string;
  description: string | null;
  category: AppCategory;
  kind: AppKind;
  prompt: string | null;
  agentId: string | null;
  sessionId: string | null;
  sourceKey: string | null;
  visibility: AppVisibility;
  createdAt: string;
  updatedAt: string;
}

export interface AppDetail extends AppSummary {
  html: string;
}

export interface AppsListResponse {
  apps: AppSummary[];
  total: number;
}

export interface GenerateAppRequest {
  description: string;
  category?: AppCategory;
  sessionId?: string;
  agentId?: string;
  model?: string;
  chatbotId?: string;
}

export interface AppMutationResponse {
  app: AppDetail;
}

export type AppPublicationPolicyKind = 'link' | 'password' | 'oidc';

export interface AppPublication {
  id: string;
  appId: string;
  policy: {
    kind: AppPublicationPolicyKind;
    ttlSeconds?: number;
    provider?: string;
  };
  embedHosts: string[];
  allowBridge: boolean;
  label: string | null;
  createdAt: string;
  createdBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface AppPublicationsResponse {
  publications: AppPublication[];
  total: number;
}

export interface CreateAppPublicationRequest {
  kind: 'link' | 'password' | 'company' | 'teams';
  password?: string;
  embedHosts?: string[];
  allowBridge?: boolean;
  acknowledgeAnonymousBridge?: boolean;
  allowFrom?: string[];
  ttlSeconds?: number;
  label?: string | null;
  expiresAt?: string | null;
}

export interface CreateAppPublicationResponse {
  publication: AppPublication;
  token: string;
  url: string;
  app: AppDetail;
}

export interface LiveAppToolCallRequest {
  toolName: string;
  arguments?: Record<string, unknown>;
  args?: Record<string, unknown>;
}

export interface LiveAppToolExecutionSummary {
  name: string;
  arguments: string;
  result: string;
  durationMs: number;
  isError?: boolean;
  blocked?: boolean;
  blockedReason?: string;
  approvalTier?: string;
  approvalDecision?: string;
}

export interface LiveAppToolCallResponse {
  ok: true;
  toolName: string;
  result: string;
  text: string;
  toolExecutions?: LiveAppToolExecutionSummary[];
}

export function fetchApps(
  token: string,
  options: { category?: string; search?: string } = {},
): Promise<AppsListResponse> {
  const params = new URLSearchParams();
  if (options.category && options.category !== 'all') {
    params.set('category', options.category);
  }
  if (options.search?.trim()) params.set('q', options.search.trim());
  const query = params.toString();
  return requestJson<AppsListResponse>(`/api/apps${query ? `?${query}` : ''}`, {
    token,
  });
}

export function fetchApp(
  token: string,
  id: string,
): Promise<AppMutationResponse> {
  return requestJson<AppMutationResponse>(
    `/api/apps/${encodeURIComponent(id)}`,
    { token },
  );
}

export function generateApp(
  token: string,
  request: GenerateAppRequest,
): Promise<AppMutationResponse> {
  return requestJson<AppMutationResponse>('/api/apps/generate', {
    token,
    method: 'POST',
    body: request,
  });
}

export function deleteApp(token: string, id: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/apps/${encodeURIComponent(id)}`, {
    token,
    method: 'DELETE',
  });
}

export function updateApp(
  token: string,
  id: string,
  request: { visibility: AppVisibility },
): Promise<AppMutationResponse> {
  return requestJson<AppMutationResponse>(
    `/api/apps/${encodeURIComponent(id)}`,
    {
      token,
      method: 'PATCH',
      body: request,
    },
  );
}

export function fetchAppPublications(
  token: string,
  id: string,
): Promise<AppPublicationsResponse> {
  return requestJson<AppPublicationsResponse>(
    `/api/apps/${encodeURIComponent(id)}/publications`,
    { token },
  );
}

export function createAppPublication(
  token: string,
  id: string,
  request: CreateAppPublicationRequest,
): Promise<CreateAppPublicationResponse> {
  return requestJson<CreateAppPublicationResponse>(
    `/api/apps/${encodeURIComponent(id)}/publications`,
    {
      token,
      method: 'POST',
      body: request,
    },
  );
}

export function revokeAppPublication(
  token: string,
  appId: string,
  publicationId: string,
): Promise<{ publication: AppPublication }> {
  return requestJson<{ publication: AppPublication }>(
    `/api/apps/${encodeURIComponent(appId)}/publications/${encodeURIComponent(
      publicationId,
    )}`,
    {
      token,
      method: 'DELETE',
    },
  );
}

export async function downloadAppTeamsManifest(
  token: string,
  appId: string,
): Promise<Blob> {
  const response = await fetch(
    `/api/apps/${encodeURIComponent(appId)}/teams-manifest`,
    {
      headers: requestHeaders(token),
    },
  );
  if (!response.ok) {
    await throwResponseError(response);
  }
  return response.blob();
}

export function callLiveAppTool(
  token: string,
  id: string,
  request: LiveAppToolCallRequest,
): Promise<LiveAppToolCallResponse> {
  return requestJson<LiveAppToolCallResponse>(
    `/api/apps/${encodeURIComponent(id)}/bridge/tool`,
    {
      token,
      method: 'POST',
      body: request,
    },
  );
}

/** Token-bearing URL for embedding a generated app in a sandboxed iframe. */
export function appViewUrl(id: string, token: string): string {
  const params = new URLSearchParams({ token });
  return `/api/apps/${encodeURIComponent(id)}/view?${params.toString()}`;
}
