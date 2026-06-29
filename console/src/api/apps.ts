import { requestJson } from './client';

export type AppCategory =
  | 'apps'
  | 'documents'
  | 'games'
  | 'productivity'
  | 'creative'
  | 'quiz'
  | 'scratch';

export type AppVisibility = 'private' | 'public';

export interface AppSummary {
  id: string;
  title: string;
  description: string | null;
  category: AppCategory;
  prompt: string | null;
  agentId: string | null;
  sessionId: string | null;
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

/** Token-bearing URL for embedding a generated app in a sandboxed iframe. */
export function appViewUrl(id: string, token: string): string {
  const params = new URLSearchParams({ token });
  return `/api/apps/${encodeURIComponent(id)}/view?${params.toString()}`;
}
