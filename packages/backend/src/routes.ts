import { Router, Request, Response } from "express";
import { getSupabase } from "./db/supabase.js";
import { verifyNeo4jConnection, getSession } from "./db/neo4j.js";
import { verifySupabaseConnection } from "./db/supabase.js";
import { runDigest } from "./pipeline/digest.js";
import { PrivateRepoError } from "./pipeline/cloner.js";
import { purgeRepoFromNeo4j, purgeRepoFromSupabase } from "./pipeline/loader.js";
import { syncManager } from "./sync/manager.js";
import { handleGitHubWebhook } from "./sync/webhook.js";
import { startWatcher, stopWatcher, isWatching } from "./sync/watcher.js";
import fs from "fs/promises";

const router = Router();

// Track active digests to prevent double-submits for the same URL
const activeDigests = new Set<string>();

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
  const { url, branch = "main" } = req.body;

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
    const result = await runDigest({ url, branch, trigger: "manual" });
    res.json({
      jobId: result.jobId,
      repoId: result.repoId,
      incremental: result.incremental,
      stats: result.stats,
      status: "complete",
    });
  } catch (err) {
    if (err instanceof PrivateRepoError) {
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

// List all repositories
router.get("/repositories", async (_req: Request, res: Response) => {
  const sb = getSupabase();
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

// Get a specific job
router.get("/jobs/:id", async (req: Request, res: Response) => {
  const sb = getSupabase();
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

// Get jobs for a repository
router.get("/repositories/:id/jobs", async (req: Request, res: Response) => {
  const sb = getSupabase();
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

// Delete a repository
router.delete("/repositories/:id", async (req: Request, res: Response) => {
  const sb = getSupabase();
  const repoId = req.params.id as string;

  // Get repo URL for Neo4j purge
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

  const sb = getSupabase();
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

// Get sync status for a repository
router.get("/repos/:id/sync/status", async (req: Request, res: Response) => {
  const repoId = req.params.id as string;
  try {
    const status = await syncManager.getStatus(repoId);
    res.json({
      ...status,
      watcher_active: isWatching(repoId),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Get sync events for a repository
router.get("/repos/:id/sync/events", async (req: Request, res: Response) => {
  const repoId = req.params.id as string;
  try {
    const events = await syncManager.getEvents(repoId);
    res.json(events);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Graph Explorer API ──────────────────────────────────────

router.get("/graph/:repoId", async (req: Request, res: Response) => {
  const sb = getSupabase();
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

// Get file content for node detail panel
router.get("/graph/:repoId/file-content", async (req: Request, res: Response) => {
  const repoId = req.params.repoId;
  const filePath = req.query.path as string;

  if (!filePath) {
    res.status(400).json({ error: "path query parameter is required" });
    return;
  }

  const sb = getSupabase();
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

export default router;
