const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : "/api";

const API_KEY = import.meta.env.VITE_API_KEY || "";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }
  return headers;
}

function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, credentials: "include" });
}

// ─── Auth API ──────────────────────────────────────────────────

export interface AuthUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

export async function getMe(): Promise<AuthUser> {
  const res = await authedFetch(`${API_BASE}/auth/me`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Not authenticated");
  return res.json();
}

export async function logout(): Promise<void> {
  await authedFetch(`${API_BASE}/auth/logout`, {
    method: "POST",
    headers: authHeaders(),
  });
}

export function getGitHubAuthUrl(): string {
  const clientId = import.meta.env.VITE_GITHUB_CLIENT_ID;
  const apiUrl = import.meta.env.VITE_API_URL || "";
  const redirectUri = `${apiUrl}/api/auth/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "read:user",
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

// ─── Data Types ────────────────────────────────────────────────

export interface Repository {
  id: string;
  url: string;
  name: string;
  branch: string;
  commit_sha: string | null;
  last_digest_at: string | null;
  status: string;
  created_at: string;
  sync_mode: string;
  sync_config: Record<string, unknown>;
  last_synced_at: string | null;
  last_synced_sha: string | null;
}

export interface DigestJob {
  id: string;
  repo_id: string;
  status: string;
  stage: string;
  started_at: string;
  completed_at: string | null;
  error_log: string | null;
  stats: {
    fileCount?: number;
    nodeCount?: number;
    edgeCount?: number;
    durationMs?: number;
  } | null;
}

export interface HealthStatus {
  status: string;
  neo4j: string;
  supabase: string;
}

export interface SyncStatus {
  sync_mode: string;
  sync_config: Record<string, unknown>;
  last_synced_at: string | null;
  last_synced_sha: string | null;
  is_running: boolean;
  is_pending: boolean;
  watcher_active: boolean;
}

export interface SyncEvent {
  id: string;
  repo_id: string;
  trigger: string;
  started_at: string;
  completed_at: string | null;
  files_changed: number;
  files_added: number;
  files_removed: number;
  duration_ms: number | null;
  status: string;
  error_log: string | null;
}

export async function checkHealth(): Promise<HealthStatus> {
  const res = await authedFetch(`${API_BASE}/health`, { headers: authHeaders() });
  return res.json();
}

export async function startDigest(url: string, branch: string) {
  const res = await authedFetch(`${API_BASE}/digest`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ url, branch }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || "Digest failed") as Error & { code?: string };
    err.code = data.code;
    throw err;
  }
  return data;
}

export async function getRepositories(): Promise<Repository[]> {
  const res = await authedFetch(`${API_BASE}/repositories`, { headers: authHeaders() });
  return res.json();
}

export async function getJob(jobId: string): Promise<DigestJob> {
  const res = await authedFetch(`${API_BASE}/jobs/${jobId}`, { headers: authHeaders() });
  return res.json();
}

export async function deleteRepository(id: string) {
  const res = await authedFetch(`${API_BASE}/repositories/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return res.json();
}

export async function updateSyncMode(
  repoId: string,
  mode: string,
  config: Record<string, unknown> = {}
) {
  const res = await authedFetch(`${API_BASE}/repos/${repoId}/sync`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ mode, config }),
  });
  return res.json();
}

export async function getSyncStatus(repoId: string): Promise<SyncStatus> {
  const res = await authedFetch(`${API_BASE}/repos/${repoId}/sync/status`, { headers: authHeaders() });
  return res.json();
}

export async function getSyncEvents(repoId: string): Promise<SyncEvent[]> {
  const res = await authedFetch(`${API_BASE}/repos/${repoId}/sync/events`, { headers: authHeaders() });
  return res.json();
}

// ─── Graph Explorer API ──────────────────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  props: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  props: Record<string, unknown>;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export async function getGraphData(repoId: string): Promise<GraphData> {
  const res = await authedFetch(`${API_BASE}/graph/${repoId}`, { headers: authHeaders() });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to fetch graph");
  }
  return res.json();
}

export async function getFileContent(
  repoId: string,
  filePath: string
): Promise<{ content: string; language: string }> {
  const res = await authedFetch(
    `${API_BASE}/graph/${repoId}/file-content?path=${encodeURIComponent(filePath)}`,
    { headers: authHeaders() }
  );
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to fetch file content");
  }
  return res.json();
}
