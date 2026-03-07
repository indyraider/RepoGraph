import { supabase } from "./lib/supabase";

export const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL.trim()}/api`
  : "/api";

const API_KEY = import.meta.env.VITE_API_KEY || "";

/**
 * Build auth headers using the Supabase access token.
 * Falls back to API key if configured (for programmatic access).
 */
async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...extra };

  // Prefer Supabase JWT when user has an active session (RLS-enforced).
  // Fall back to API key only when there's no session (programmatic access).
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    headers["Authorization"] = `Bearer ${session.access_token}`;
  } else if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  return headers;
}

async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = await authHeaders(
    (init.headers as Record<string, string>) || {}
  );
  return fetch(url, { ...init, headers });
}

// ─── GitHub Repos ─────────────────────────────────────────────

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  url: string;
  html_url: string;
  private: boolean;
  default_branch: string;
  updated_at: string;
  language: string | null;
  description: string | null;
  owner: string;
  owner_avatar: string;
}

export async function getGitHubRepos(githubToken: string): Promise<GitHubRepo[]> {
  const headers = await authHeaders({ "X-GitHub-Token": githubToken });
  const res = await fetch(`${API_BASE}/github/repos`, { headers });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to fetch repos");
  }
  return res.json();
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
    symbolCount?: number;
    importCount?: number;
    directImportCount?: number;
    resolvedImports?: number;
    unresolvedImports?: number;
    nodeCount?: number;
    edgeCount?: number;
    packageCount?: number;
    exportedSymbolCount?: number;
    durationMs?: number;
    changedFiles?: number;
    deletedFiles?: number;
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

export interface SyncEventSummary {
  commits?: { sha: string; message: string }[];
  changedPaths?: string[];
  deletedPaths?: string[];
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
  summary: SyncEventSummary | null;
}

export async function checkHealth(): Promise<HealthStatus> {
  const res = await authedFetch(`${API_BASE}/health`);
  return res.json();
}

export async function startDigest(url: string, branch: string, force = false, githubToken?: string) {
  const extra: Record<string, string> = { "Content-Type": "application/json" };
  if (githubToken) extra["X-GitHub-Token"] = githubToken;
  const res = await authedFetch(`${API_BASE}/digest`, {
    method: "POST",
    headers: extra,
    body: JSON.stringify({ url, branch, force }),
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
  const res = await authedFetch(`${API_BASE}/repositories`);
  return res.json();
}

export async function getJob(jobId: string): Promise<DigestJob> {
  const res = await authedFetch(`${API_BASE}/jobs/${jobId}`);
  return res.json();
}

export async function getDigestJobs(repoId: string): Promise<DigestJob[]> {
  const res = await authedFetch(`${API_BASE}/repositories/${repoId}/jobs`);
  return res.json();
}

export async function deleteRepository(id: string) {
  const res = await authedFetch(`${API_BASE}/repositories/${id}`, {
    method: "DELETE",
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, config }),
  });
  return res.json();
}

export async function getSyncStatus(repoId: string): Promise<SyncStatus> {
  const res = await authedFetch(`${API_BASE}/repos/${repoId}/sync/status`);
  return res.json();
}

export async function getSyncEvents(repoId: string): Promise<SyncEvent[]> {
  const res = await authedFetch(`${API_BASE}/repos/${repoId}/sync/events`);
  return res.json();
}

// ─── Connections API ─────────────────────────────────────────

export interface UserConnection {
  id: string;
  owner_id: string;
  provider: "neo4j" | "supabase";
  label: string;
  credentials: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface McpConfig {
  neo4j: Record<string, string> | null;
  supabase: Record<string, string> | null;
}

export async function getConnections(): Promise<UserConnection[]> {
  const res = await authedFetch(`${API_BASE}/connections`);
  if (!res.ok) throw new Error("Failed to fetch connections");
  return res.json();
}

export async function getMcpConfig(): Promise<McpConfig> {
  const res = await authedFetch(`${API_BASE}/connections/mcp-config`);
  if (!res.ok) throw new Error("Failed to fetch MCP config");
  return res.json();
}

export async function saveConnection(
  provider: "neo4j" | "supabase",
  credentials: Record<string, string>
): Promise<{ id: string; status: string }> {
  const res = await authedFetch(`${API_BASE}/connections/${provider}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credentials }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to save connection");
  }
  return res.json();
}

export async function deleteConnection(provider: "neo4j" | "supabase"): Promise<void> {
  const res = await authedFetch(`${API_BASE}/connections/${provider}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete connection");
}

export async function testNeo4jConnection(
  uri: string,
  username: string,
  password: string
): Promise<{ ok: boolean; error?: string; version?: string }> {
  const res = await authedFetch(`${API_BASE}/connections/neo4j/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uri, username, password }),
  });
  return res.json();
}

// ─── Log Sources API ─────────────────────────────────────────

export interface LogSource {
  id: string;
  repo_id: string;
  platform: string;
  display_name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  polling_interval_sec: number;
  min_level: string;
  last_poll_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface LogSourcePlatform {
  platform: string;
  displayName: string;
}

export async function getLogSources(): Promise<LogSource[]> {
  const res = await authedFetch(`${API_BASE}/log-sources`);
  if (!res.ok) throw new Error("Failed to fetch log sources");
  return res.json();
}

export async function getLogSourcePlatforms(): Promise<LogSourcePlatform[]> {
  const res = await authedFetch(`${API_BASE}/log-sources/platforms`);
  if (!res.ok) throw new Error("Failed to fetch platforms");
  return res.json();
}

export async function createLogSource(params: {
  repo_id: string;
  platform: string;
  display_name: string;
  api_token: string;
  config?: Record<string, unknown>;
  polling_interval_sec?: number;
  min_level?: string;
}): Promise<LogSource> {
  const res = await authedFetch(`${API_BASE}/log-sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to create log source");
  }
  return res.json();
}

export async function updateLogSource(
  id: string,
  params: {
    display_name?: string;
    api_token?: string;
    config?: Record<string, unknown>;
    polling_interval_sec?: number;
    min_level?: string;
  }
): Promise<LogSource> {
  const res = await authedFetch(`${API_BASE}/log-sources/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to update log source");
  }
  return res.json();
}

export async function deleteLogSource(id: string): Promise<void> {
  const res = await authedFetch(`${API_BASE}/log-sources/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete log source");
}

export async function testLogSourceConnection(params: {
  platform: string;
  api_token: string;
  config?: Record<string, unknown>;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await authedFetch(`${API_BASE}/log-sources/test-connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

export async function testSavedLogSource(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await authedFetch(`${API_BASE}/log-sources/${id}/test`, {
    method: "POST",
  });
  return res.json();
}

export async function toggleLogSource(id: string): Promise<{ id: string; enabled: boolean }> {
  const res = await authedFetch(`${API_BASE}/log-sources/${id}/toggle`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to toggle log source");
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
  const res = await authedFetch(`${API_BASE}/graph/${repoId}`);
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
    `${API_BASE}/graph/${repoId}/file-content?path=${encodeURIComponent(filePath)}`
  );
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to fetch file content");
  }
  return res.json();
}

// ─── Runtime Logs API ────────────────────────────────────────

export interface RuntimeLogEntry {
  id: string;
  repo_id: string;
  source: string;
  level: string;
  message: string;
  timestamp: string;
  deployment_id: string | null;
  function_name: string | null;
  file_path: string | null;
  line_number: number | null;
  stack_trace: string | null;
  metadata: Record<string, unknown>;
}

export interface RuntimeLogPage {
  entries: RuntimeLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RuntimeLogStats {
  total: number;
  byLevel: { info: number; warn: number; error: number };
  bySource: Record<string, number>;
}

export interface RuntimeLogFilters {
  level?: string;
  source?: string;
  search?: string;
  since?: string;
  until?: string;
  page?: number;
  pageSize?: number;
}

export async function getRuntimeLogs(
  repoId: string,
  filters: RuntimeLogFilters = {}
): Promise<RuntimeLogPage> {
  const params = new URLSearchParams();
  if (filters.level) params.set("level", filters.level);
  if (filters.source) params.set("source", filters.source);
  if (filters.search) params.set("search", filters.search);
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  if (filters.page) params.set("page", String(filters.page));
  if (filters.pageSize) params.set("pageSize", String(filters.pageSize));

  const qs = params.toString();
  const res = await authedFetch(`${API_BASE}/runtime-logs/${repoId}${qs ? `?${qs}` : ""}`);
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to fetch runtime logs");
  }
  return res.json();
}

export async function getRuntimeLogStats(
  repoId: string,
  since?: string,
  until?: string
): Promise<RuntimeLogStats> {
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (until) params.set("until", until);

  const qs = params.toString();
  const res = await authedFetch(`${API_BASE}/runtime-logs/${repoId}/stats${qs ? `?${qs}` : ""}`);
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to fetch log stats");
  }
  return res.json();
}

// ─── Temporal / History API ──────────────────────────────────

export interface CommitSummary {
  sha: string;
  author: string;
  author_email: string | null;
  message: string;
  timestamp: string;
}

export interface SymbolVersion {
  name: string;
  signature: string | null;
  filePath: string;
  validFrom: string | null;
  validFromTs: string | null;
  validTo: string | null;
  validToTs: string | null;
  changeType: string | null;
  changedBy: string | null;
  commitMessage: string | null;
  commitSha: string | null;
  commitAuthor: string | null;
}

export interface ComplexityDataPoint {
  commit_sha: string;
  file_path: string;
  metric_name: string;
  metric_value: number;
  timestamp: string;
}

export interface BlameResult {
  name: string;
  filePath: string;
  signature: string | null;
  commitSha: string;
  author: string;
  authorEmail: string | null;
  message: string;
  timestamp: string;
}

export interface DiffEntry {
  name: string;
  kind: string;
  filePath: string;
  commitSha: string;
  author: string;
  message: string;
  timestamp: string;
}

export interface BackfillJob {
  id: string;
  repo_id: string;
  mode: string;
  commits_processed: number;
  commits_total: number;
  oldest_commit_sha: string | null;
  newest_commit_sha: string | null;
  stats: Record<string, unknown>;
  status: string;
  started_at: string;
  completed_at: string | null;
  error_log: string | null;
}

export async function getCommits(repoId: string, limit = 50): Promise<CommitSummary[]> {
  const res = await authedFetch(`${API_BASE}/temporal/${repoId}/commits?limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch commits");
  const data = await res.json();
  return data.commits;
}

export async function getSymbolHistory(
  repoId: string,
  name: string,
  kind?: string,
  limit = 20
): Promise<SymbolVersion[]> {
  const params = new URLSearchParams({ name, limit: String(limit) });
  if (kind) params.set("kind", kind);
  const res = await authedFetch(`${API_BASE}/temporal/${repoId}/symbol-history?${params}`);
  if (!res.ok) throw new Error("Failed to fetch symbol history");
  const data = await res.json();
  return data.versions;
}

export async function getComplexityTrend(
  repoId: string,
  filePath: string,
  metric = "coupling_score",
  since?: string
): Promise<ComplexityDataPoint[]> {
  const params = new URLSearchParams({ file_path: filePath, metric });
  if (since) params.set("since", since);
  const res = await authedFetch(`${API_BASE}/temporal/${repoId}/complexity-trend?${params}`);
  if (!res.ok) throw new Error("Failed to fetch complexity trend");
  const data = await res.json();
  return data.data;
}

export async function getComplexityFiles(repoId: string): Promise<string[]> {
  const res = await authedFetch(`${API_BASE}/temporal/${repoId}/complexity-files`);
  if (!res.ok) throw new Error("Failed to fetch complexity files");
  const data = await res.json();
  return data.files;
}

export async function getStructuralBlame(
  repoId: string,
  name: string,
  kind?: string
): Promise<BlameResult | null> {
  const params = new URLSearchParams({ name });
  if (kind) params.set("kind", kind);
  const res = await authedFetch(`${API_BASE}/temporal/${repoId}/structural-blame?${params}`);
  if (!res.ok) throw new Error("Failed to fetch structural blame");
  const data = await res.json();
  return data.blame;
}

export async function getDiffGraph(
  repoId: string,
  fromRef: string,
  toRef: string
): Promise<{ created: DiffEntry[]; modified: DiffEntry[]; deleted: DiffEntry[] }> {
  const params = new URLSearchParams({ from_ref: fromRef, to_ref: toRef });
  const res = await authedFetch(`${API_BASE}/temporal/${repoId}/diff?${params}`);
  if (!res.ok) throw new Error("Failed to fetch diff");
  return res.json();
}

export async function triggerBackfill(repoId: string, maxCommits = 50, githubToken?: string): Promise<{ status: string }> {
  const extra: Record<string, string> = { "Content-Type": "application/json" };
  if (githubToken) extra["X-GitHub-Token"] = githubToken;
  const res = await authedFetch(`${API_BASE}/temporal/${repoId}/backfill`, {
    method: "POST",
    headers: extra,
    body: JSON.stringify({ maxCommits }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to start backfill");
  }
  return res.json();
}

export async function getBackfillStatus(repoId: string): Promise<BackfillJob | null> {
  const res = await authedFetch(`${API_BASE}/temporal/${repoId}/backfill/status`);
  if (!res.ok) throw new Error("Failed to fetch backfill status");
  const data = await res.json();
  return data.job;
}
