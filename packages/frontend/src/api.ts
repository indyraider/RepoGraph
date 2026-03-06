const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : "/api";

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
  const res = await fetch(`${API_BASE}/health`);
  return res.json();
}

export async function startDigest(url: string, branch: string) {
  const res = await fetch(`${API_BASE}/digest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  const res = await fetch(`${API_BASE}/repositories`);
  return res.json();
}

export async function getJob(jobId: string): Promise<DigestJob> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}`);
  return res.json();
}

export async function deleteRepository(id: string) {
  const res = await fetch(`${API_BASE}/repositories/${id}`, {
    method: "DELETE",
  });
  return res.json();
}

export async function updateSyncMode(
  repoId: string,
  mode: string,
  config: Record<string, unknown> = {}
) {
  const res = await fetch(`${API_BASE}/repos/${repoId}/sync`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, config }),
  });
  return res.json();
}

export async function getSyncStatus(repoId: string): Promise<SyncStatus> {
  const res = await fetch(`${API_BASE}/repos/${repoId}/sync/status`);
  return res.json();
}

export async function getSyncEvents(repoId: string): Promise<SyncEvent[]> {
  const res = await fetch(`${API_BASE}/repos/${repoId}/sync/events`);
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
  const res = await fetch(`${API_BASE}/graph/${repoId}`);
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
  const res = await fetch(
    `${API_BASE}/graph/${repoId}/file-content?path=${encodeURIComponent(filePath)}`
  );
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to fetch file content");
  }
  return res.json();
}
