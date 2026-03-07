/**
 * Temporal Graph Routes — API for querying code evolution data.
 * Mounted at /api/temporal in index.ts.
 */

import { Router, type Request, type Response } from "express";
import { getUserDb, getSupabase } from "./db/supabase.js";
import { getSession } from "./db/neo4j.js";
import { runHistoricalBackfill } from "./pipeline/backfill.js";
import { cloneRepo } from "./pipeline/cloner.js";
import fs from "fs/promises";

const router = Router();

// ─── GET /api/temporal/:repoId/commits ──────────────────────
// List commits for a repo (from Supabase commits table)
router.get("/:repoId/commits", async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const limit = Math.min(200, parseInt(req.query.limit as string) || 50);

  const sb = getUserDb(req);
  try {
    const { data, error } = await sb
      .from("commits")
      .select("sha, author, author_email, message, timestamp")
      .eq("repo_id", repoId)
      .order("timestamp", { ascending: false })
      .limit(limit);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ commits: data || [] });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  }
});

// ─── GET /api/temporal/:repoId/symbol-history ───────────────
// Get version history for a named symbol from Neo4j
router.get("/:repoId/symbol-history", async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const { name, kind, since, limit: limitStr } = req.query as Record<string, string | undefined>;

  if (!name) {
    res.status(400).json({ error: "name parameter is required" });
    return;
  }

  // Verify repo ownership via Supabase RLS
  const sb = getUserDb(req);
  const { data: repo, error: repoErr } = await sb
    .from("repositories")
    .select("url")
    .eq("id", repoId)
    .single();

  if (repoErr || !repo) {
    res.status(404).json({ error: "Repository not found" });
    return;
  }

  const repoUrl = repo.url;
  const maxResults = Math.min(100, parseInt(limitStr || "20") || 20);

  const session = getSession();
  try {
    const kindFilter = kind
      ? `AND (sym:${kind.charAt(0).toUpperCase() + kind.slice(1)})`
      : "AND (sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant)";

    const sinceFilter = since ? "AND sym.valid_from_ts >= $since" : "";

    const result = await session.run(
      `MATCH (sym {repo_url: $repoUrl})
       WHERE sym.name = $name ${kindFilter} ${sinceFilter}
       OPTIONAL MATCH (sym)-[r:INTRODUCED_IN]->(c:Commit)
       RETURN sym.name AS name, sym.signature AS signature, sym.file_path AS filePath,
              sym.valid_from AS validFrom, sym.valid_from_ts AS validFromTs,
              sym.valid_to AS validTo, sym.valid_to_ts AS validToTs,
              sym.change_type AS changeType, sym.changed_by AS changedBy,
              c.message AS commitMessage, c.sha AS commitSha, c.author AS commitAuthor
       ORDER BY sym.valid_from_ts DESC
       LIMIT $limit`,
      { repoUrl, name, since: since || null, limit: maxResults }
    );

    const versions = result.records.map((r) => ({
      name: r.get("name"),
      signature: r.get("signature"),
      filePath: r.get("filePath"),
      validFrom: r.get("validFrom"),
      validFromTs: r.get("validFromTs"),
      validTo: r.get("validTo"),
      validToTs: r.get("validToTs"),
      changeType: r.get("changeType"),
      changedBy: r.get("changedBy"),
      commitMessage: r.get("commitMessage"),
      commitSha: r.get("commitSha"),
      commitAuthor: r.get("commitAuthor"),
    }));

    res.json({ versions });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  } finally {
    await session.close();
  }
});

// ─── GET /api/temporal/:repoId/complexity-trend ─────────────
// Time-series complexity metrics for a file
router.get("/:repoId/complexity-trend", async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const { file_path, metric, since } = req.query as Record<string, string | undefined>;

  if (!file_path) {
    res.status(400).json({ error: "file_path parameter is required" });
    return;
  }

  const metricName = metric || "coupling_score";
  const sb = getUserDb(req);

  try {
    let query = sb
      .from("complexity_metrics")
      .select("commit_sha, file_path, metric_name, metric_value, timestamp")
      .eq("repo_id", repoId)
      .eq("file_path", file_path)
      .eq("metric_name", metricName)
      .order("timestamp", { ascending: true });

    if (since) query = query.gte("timestamp", since);

    const { data, error } = await query;

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ data: data || [] });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  }
});

// ─── GET /api/temporal/:repoId/complexity-files ─────────────
// List files that have complexity metrics
router.get("/:repoId/complexity-files", async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const sb = getUserDb(req);

  try {
    const { data, error } = await sb
      .from("complexity_metrics")
      .select("file_path")
      .eq("repo_id", repoId)
      .limit(1000);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    // Deduplicate file paths
    const files = [...new Set((data || []).map((r) => r.file_path))].sort();
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  }
});

// ─── GET /api/temporal/:repoId/structural-blame ─────────────
// Find who introduced a symbol
router.get("/:repoId/structural-blame", async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const { name, kind } = req.query as Record<string, string | undefined>;

  if (!name) {
    res.status(400).json({ error: "name parameter is required" });
    return;
  }

  const sb = getUserDb(req);
  const { data: repo, error: repoErr } = await sb
    .from("repositories")
    .select("url")
    .eq("id", repoId)
    .single();

  if (repoErr || !repo) {
    res.status(404).json({ error: "Repository not found" });
    return;
  }

  const repoUrl = repo.url;
  const session = getSession();

  try {
    const kindFilter = kind
      ? `AND (sym:${kind.charAt(0).toUpperCase() + kind.slice(1)})`
      : "AND (sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant)";

    const result = await session.run(
      `MATCH (sym {repo_url: $repoUrl})-[:INTRODUCED_IN]->(c:Commit)
       WHERE sym.name = $name ${kindFilter}
         AND sym.change_type = "created"
       RETURN sym.name AS name, sym.file_path AS filePath, sym.signature AS signature,
              c.sha AS commitSha, c.author AS author, c.author_email AS authorEmail,
              c.message AS message, c.timestamp AS timestamp
       ORDER BY c.timestamp ASC
       LIMIT 1`,
      { repoUrl, name }
    );

    if (result.records.length === 0) {
      res.json({ blame: null });
      return;
    }

    const r = result.records[0];
    res.json({
      blame: {
        name: r.get("name"),
        filePath: r.get("filePath"),
        signature: r.get("signature"),
        commitSha: r.get("commitSha"),
        author: r.get("author"),
        authorEmail: r.get("authorEmail"),
        message: r.get("message"),
        timestamp: r.get("timestamp"),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  } finally {
    await session.close();
  }
});

// ─── GET /api/temporal/:repoId/diff ─────────────────────────
// Structural diff between two commits
router.get("/:repoId/diff", async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const { from_ref, to_ref } = req.query as Record<string, string | undefined>;

  if (!from_ref || !to_ref) {
    res.status(400).json({ error: "from_ref and to_ref parameters are required" });
    return;
  }

  const sb = getUserDb(req);
  const { data: repo, error: repoErr } = await sb
    .from("repositories")
    .select("url")
    .eq("id", repoId)
    .single();

  if (repoErr || !repo) {
    res.status(404).json({ error: "Repository not found" });
    return;
  }

  // Resolve commit SHAs to timestamps
  const { data: commits } = await sb
    .from("commits")
    .select("sha, timestamp")
    .eq("repo_id", repoId)
    .in("sha", [from_ref, to_ref]);

  if (!commits || commits.length < 2) {
    res.status(400).json({ error: "Could not resolve both commit SHAs" });
    return;
  }

  const fromCommit = commits.find((c) => c.sha === from_ref);
  const toCommit = commits.find((c) => c.sha === to_ref);

  if (!fromCommit || !toCommit) {
    res.status(400).json({ error: "Could not resolve both commit SHAs" });
    return;
  }

  const repoUrl = repo.url;
  const session = getSession();

  try {
    const result = await session.run(
      `MATCH (sym)-[r:INTRODUCED_IN]->(c:Commit {repo_url: $repoUrl})
       WHERE c.timestamp >= $fromTs AND c.timestamp <= $toTs
       RETURN sym.name AS name, labels(sym) AS labels, sym.file_path AS filePath,
              r.change_type AS changeType,
              c.sha AS commitSha, c.author AS author, c.message AS message,
              c.timestamp AS timestamp
       ORDER BY c.timestamp ASC`,
      { repoUrl, fromTs: fromCommit.timestamp, toTs: toCommit.timestamp }
    );

    const created: unknown[] = [];
    const modified: unknown[] = [];
    const deleted: unknown[] = [];

    for (const r of result.records) {
      const entry = {
        name: r.get("name"),
        kind: (r.get("labels") as string[]).find((l) =>
          ["Function", "Class", "TypeDef", "Constant"].includes(l)
        ) || "unknown",
        filePath: r.get("filePath"),
        commitSha: r.get("commitSha"),
        author: r.get("author"),
        message: r.get("message"),
        timestamp: r.get("timestamp"),
      };

      const changeType = r.get("changeType");
      if (changeType === "created") created.push(entry);
      else if (changeType === "modified") modified.push(entry);
      else if (changeType === "deleted") deleted.push(entry);
    }

    res.json({ created, modified, deleted });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  } finally {
    await session.close();
  }
});

// ─── POST /api/temporal/:repoId/backfill ────────────────────
// Trigger historical backfill (fire-and-forget)
router.post("/:repoId/backfill", async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const { maxCommits = 50 } = req.body || {};

  const sb = getUserDb(req);

  // Verify repo exists and user owns it
  const { data: repo, error: repoErr } = await sb
    .from("repositories")
    .select("id, url, name, branch")
    .eq("id", repoId)
    .single();

  if (repoErr || !repo) {
    res.status(404).json({ error: "Repository not found" });
    return;
  }

  // Check if a backfill is already running
  const { data: activeJob } = await sb
    .from("temporal_digest_jobs")
    .select("id, status")
    .eq("repo_id", repoId)
    .eq("status", "running")
    .limit(1)
    .maybeSingle();

  if (activeJob) {
    res.status(409).json({ error: "A backfill is already running", jobId: activeJob.id });
    return;
  }

  // Clone repo and start backfill in background
  const user = (req as any).user;
  const githubToken = user?.accessToken && user.accessToken !== "__service__" && user.accessToken !== "__dev__"
    ? user.accessToken
    : undefined;

  // Fire and forget — clone + backfill runs in background
  (async () => {
    let tmpDir: string | undefined;
    try {
      const cloneResult = await cloneRepo(
        repo.url,
        repo.branch,
        0, // full clone for backfill
        githubToken,
      );
      tmpDir = cloneResult.localPath;

      await runHistoricalBackfill(
        cloneResult.localPath,
        repo.url,
        repo.id,
        repo.name,
        repo.branch,
        { maxCommits }
      );
    } catch (err) {
      console.error(`[temporal] Backfill failed for ${repo.url}:`, err);
      // Update job status to failed
      const adminSb = getSupabase();
      await adminSb
        .from("temporal_digest_jobs")
        .update({ status: "failed", error_log: err instanceof Error ? err.message : String(err) })
        .eq("repo_id", repoId)
        .eq("status", "running");
    } finally {
      if (tmpDir) {
        try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  })();

  res.json({ status: "started", repoId });
});

// ─── GET /api/temporal/:repoId/backfill/status ──────────────
// Get latest backfill job status
router.get("/:repoId/backfill/status", async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const sb = getUserDb(req);

  try {
    const { data, error } = await sb
      .from("temporal_digest_jobs")
      .select("*")
      .eq("repo_id", repoId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ job: data || null });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  }
});

export default router;
