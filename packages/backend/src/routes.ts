import { Router, Request, Response } from "express";
import { getUserDb, getUser } from "./db/supabase.js";
import { verifyNeo4jConnection, getSession } from "./db/neo4j.js";
import { verifySupabaseConnection } from "./db/supabase.js";
import { runDigest } from "./pipeline/digest.js";
import { PrivateRepoError, RepoOwnedError } from "./pipeline/cloner.js";
import { purgeRepoFromNeo4j, purgeRepoFromSupabase } from "./pipeline/loader.js";
import { syncManager } from "./sync/manager.js";
import { handleGitHubWebhook } from "./sync/webhook.js";
import { startWatcher, stopWatcher, isWatching } from "./sync/watcher.js";
import fs from "fs/promises";

const router = Router();

// Track active digests to prevent double-submits for the same URL
const activeDigests = new Set<string>();


// ─── GitHub Repos (for Vercel-style import) ─────────────────
router.get("/github/repos", async (req: Request, res: Response) => {
  // GitHub token is passed from the frontend via X-GitHub-Token header
  const githubToken = req.headers["x-github-token"] as string | undefined;
  if (!githubToken) {
    res.status(401).json({ error: "No GitHub token — please re-login" });
    return;
  }

  try {
    const page = parseInt(req.query.page as string) || 1;
    const perPage = Math.min(parseInt(req.query.per_page as string) || 100, 100);

    const ghRes = await fetch(
      `https://api.github.com/user/repos?sort=updated&per_page=${perPage}&page=${page}&type=all`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (!ghRes.ok) {
      const err = await ghRes.text();
      res.status(ghRes.status).json({ error: `GitHub API error: ${err}` });
      return;
    }

    const repos = (await ghRes.json()) as Array<{
      id: number;
      full_name: string;
      name: string;
      html_url: string;
      clone_url: string;
      private: boolean;
      default_branch: string;
      updated_at: string;
      language: string | null;
      description: string | null;
      owner: { login: string; avatar_url: string };
    }>;

    res.json(
      repos.map((r) => ({
        id: r.id,
        full_name: r.full_name,
        name: r.name,
        url: r.clone_url,
        html_url: r.html_url,
        private: r.private,
        default_branch: r.default_branch,
        updated_at: r.updated_at,
        language: r.language,
        description: r.description,
        owner: r.owner.login,
        owner_avatar: r.owner.avatar_url,
      }))
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Health check
router.get("/health", async (_req: Request, res: Response) => {
  const neo4j = await verifyNeo4jConnection();
  const supabase = await verifySupabaseConnection();
  res.json({
    status: neo4j && supabase ? "ok" : "degraded",
    neo4j: neo4j ? "connected" : "disconnected",
    supabase: supabase ? "connected" : "disconnected",
  });
});

// Start a digest
router.post("/digest", async (req: Request, res: Response) => {
  const { url, branch = "main", force = false } = req.body;
  const user = getUser(req);

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }

  // Validate URL format (GitHub HTTPS, SSH, or local path)
  const isValid =
    url.startsWith("https://") ||
    url.startsWith("git@") ||
    url.startsWith("/");

  if (!isValid) {
    res.status(400).json({ error: "Invalid URL. Use HTTPS, SSH, or local path." });
    return;
  }

  // Prevent double-submits for the same URL
  if (activeDigests.has(url)) {
    res.status(409).json({ error: "A digest is already running for this repository." });
    return;
  }

  activeDigests.add(url);

  try {
    const githubToken = req.headers["x-github-token"] as string | undefined;
    const result = await runDigest({
      url,
      branch,
      trigger: "manual",
      ownerId: user?.id,
      force: !!force,
      githubToken,
    });
    res.json({
      jobId: result.jobId,
      repoId: result.repoId,
      incremental: result.incremental,
      stats: result.stats,
      delta: result.delta,
      status: "complete",
    });
  } catch (err) {
    if (err instanceof RepoOwnedError) {
      res.status(403).json({ error: err.message, code: "REPO_OWNED" });
    } else if (err instanceof PrivateRepoError) {
      res.status(403).json({ error: err.message, code: "PRIVATE_REPO" });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error("[digest] Error:", msg);
      if (stack) console.error("[digest] Stack:", stack);
      res.status(500).json({ error: msg });
    }
  } finally {
    activeDigests.delete(url);
  }
});

// List repositories (RLS-filtered to current user)
router.get("/repositories", async (req: Request, res: Response) => {
  const sb = getUserDb(req);
  const { data, error } = await sb
    .from("repositories")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data);
});

// Get a specific job (RLS-filtered)
router.get("/jobs/:id", async (req: Request, res: Response) => {
  const sb = getUserDb(req);
  const { data, error } = await sb
    .from("digest_jobs")
    .select("*")
    .eq("id", req.params.id as string)
    .single();

  if (error) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(data);
});

// Get jobs for a repository (RLS-filtered)
router.get("/repositories/:id/jobs", async (req: Request, res: Response) => {
  const sb = getUserDb(req);
  const { data, error } = await sb
    .from("digest_jobs")
    .select("*")
    .eq("repo_id", req.params.id as string)
    .order("started_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data);
});

// Delete a repository (RLS-filtered — can only delete own repos)
router.delete("/repositories/:id", async (req: Request, res: Response) => {
  const sb = getUserDb(req);
  const repoId = req.params.id as string;

  // RLS ensures only the owner can see/delete this repo
  const { data: repo, error: fetchErr } = await sb
    .from("repositories")
    .select("url")
    .eq("id", repoId)
    .single();

  if (fetchErr || !repo) {
    res.status(404).json({ error: "Repository not found" });
    return;
  }

  try {
    // Stop any active watcher before purging
    stopWatcher(repoId);
    await purgeRepoFromNeo4j(repo.url);
    await purgeRepoFromSupabase(repoId);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── GitHub Webhook ──────────────────────────────────────────

router.post("/webhooks/github", handleGitHubWebhook);

// ─── Sync API ────────────────────────────────────────────────

// Update sync mode for a repository
router.put("/repos/:id/sync", async (req: Request, res: Response) => {
  const repoId = req.params.id as string;
  const { mode, config = {} } = req.body;

  if (!mode || !["off", "webhook", "watcher"].includes(mode)) {
    res.status(400).json({ error: "mode must be 'off', 'webhook', or 'watcher'" });
    return;
  }

  // Use user-scoped client to verify ownership via RLS
  const sb = getUserDb(req);
  const { data: repo, error: fetchErr } = await sb
    .from("repositories")
    .select("id, url, branch")
    .eq("id", repoId)
    .single();

  if (fetchErr || !repo) {
    res.status(404).json({ error: "Repository not found" });
    return;
  }

  try {
    // Stop existing watcher if switching away from watcher mode
    stopWatcher(repoId);

    if (mode === "watcher") {
      const localPath = config.local_path as string;
      if (!localPath) {
        res.status(400).json({ error: "local_path is required for watcher mode" });
        return;
      }

      // Validate path exists
      try {
        const stat = await fs.stat(localPath);
        if (!stat.isDirectory()) {
          res.status(400).json({ error: "local_path must be a directory" });
          return;
        }
      } catch {
        res.status(400).json({ error: `local_path does not exist: ${localPath}` });
        return;
      }

      const result = await syncManager.updateMode(repoId, mode, config);
      const debounceMs = (config.debounce_ms as number) || 30_000;
      startWatcher(repoId, repo.url, repo.branch, localPath, debounceMs);
      res.json({ status: "watching", ...result });
    } else if (mode === "webhook") {
      const result = await syncManager.updateMode(repoId, mode, config);
      res.json({ status: "webhook_enabled", ...result });
    } else {
      // mode === "off"
      await syncManager.updateMode(repoId, mode);
      res.json({ status: "sync_disabled" });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Get sync status for a repository (verify ownership via RLS first)
router.get("/repos/:id/sync/status", async (req: Request, res: Response) => {
  const repoId = req.params.id as string;
  const sb = getUserDb(req);
  const { error: fetchErr } = await sb
    .from("repositories")
    .select("id")
    .eq("id", repoId)
    .single();

  if (fetchErr) {
    res.status(404).json({ error: "Repository not found" });
    return;
  }

  try {
    const status = await syncManager.getStatus(repoId, sb);
    res.json({
      ...status,
      watcher_active: isWatching(repoId),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Get sync events for a repository (verify ownership via RLS first)
router.get("/repos/:id/sync/events", async (req: Request, res: Response) => {
  const repoId = req.params.id as string;
  const sb = getUserDb(req);
  const { error: fetchErr } = await sb
    .from("repositories")
    .select("id")
    .eq("id", repoId)
    .single();

  if (fetchErr) {
    res.status(404).json({ error: "Repository not found" });
    return;
  }

  try {
    const events = await syncManager.getEvents(repoId, undefined, sb);
    res.json(events);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Graph Explorer API ──────────────────────────────────────

router.get("/graph/:repoId", async (req: Request, res: Response) => {
  // Use user-scoped client to verify ownership via RLS
  const sb = getUserDb(req);
  const repoId = req.params.id ?? req.params.repoId;

  const { data: repo, error: fetchErr } = await sb
    .from("repositories")
    .select("url")
    .eq("id", repoId)
    .single();

  if (fetchErr || !repo) {
    res.status(404).json({ error: "Repository not found" });
    return;
  }

  const repoUrl = repo.url;
  const session = getSession();

  try {
    // Fetch all nodes for this repo
    const nodesResult = await session.run(
      `MATCH (n)
       WHERE n.repo_url = $repoUrl OR (n:Repository AND n.url = $repoUrl) OR (n:Package AND EXISTS {
         MATCH (:Repository {url: $repoUrl})-[:DEPENDS_ON]->(n)
       })
       RETURN id(n) AS id, labels(n) AS labels, properties(n) AS props`,
      { repoUrl }
    );

    // Fetch all relationships between those nodes
    const edgesResult = await session.run(
      `MATCH (a)-[r]->(b)
       WHERE (a.repo_url = $repoUrl OR (a:Repository AND a.url = $repoUrl) OR (a:Package AND EXISTS {
         MATCH (:Repository {url: $repoUrl})-[:DEPENDS_ON]->(a)
       }))
       AND (b.repo_url = $repoUrl OR (b:Repository AND b.url = $repoUrl) OR (b:Package AND EXISTS {
         MATCH (:Repository {url: $repoUrl})-[:DEPENDS_ON]->(b)
       }))
       RETURN id(a) AS source, id(b) AS target, type(r) AS type, properties(r) AS props`,
      { repoUrl }
    );

    const nodes = nodesResult.records.map((r) => ({
      id: r.get("id").toString(),
      label: r.get("labels")[0],
      props: r.get("props"),
    }));

    const edges = edgesResult.records.map((r) => ({
      source: r.get("source").toString(),
      target: r.get("target").toString(),
      type: r.get("type"),
      props: r.get("props"),
    }));

    res.json({ nodes, edges });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  } finally {
    await session.close();
  }
});

// Get file content for node detail panel (RLS-filtered)
router.get("/graph/:repoId/file-content", async (req: Request, res: Response) => {
  const repoId = req.params.repoId;
  const filePath = req.query.path as string;

  if (!filePath) {
    res.status(400).json({ error: "path query parameter is required" });
    return;
  }

  const sb = getUserDb(req);
  const { data, error } = await sb
    .from("file_contents")
    .select("content, language")
    .eq("repo_id", repoId)
    .eq("file_path", filePath)
    .single();

  if (error || !data) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  res.json(data);
});

// Browse local directories (for watcher path picker)
router.get("/browse-directory", async (req: Request, res: Response) => {
  const dirPath = (req.query.path as string) || "/";

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    res.json({ path: dirPath, directories: dirs });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Cannot read directory";
    res.status(400).json({ error: message });
  }
});

export default router;
