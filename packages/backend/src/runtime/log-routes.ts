/**
 * Runtime Log Query Routes — read-only API for browsing ingested runtime logs.
 * Mounted at /api/runtime-logs in index.ts.
 */

import { Router, type Request, type Response } from "express";
import { getUserDb } from "../db/supabase.js";

const router = Router();

// GET /api/runtime-logs/:repoId — paginated log entries with filters
router.get("/:repoId", async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const {
    level,
    source,
    search,
    since,
    until,
    page: pageStr,
    pageSize: pageSizeStr,
  } = req.query as Record<string, string | undefined>;

  const page = Math.max(1, parseInt(pageStr || "1", 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(pageSizeStr || "50", 10) || 50));
  const offset = (page - 1) * pageSize;

  const sb = getUserDb(req);

  try {
    // Build the query
    let query = sb
      .from("runtime_logs")
      .select("*", { count: "exact" })
      .eq("repo_id", repoId)
      .order("timestamp", { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (level) query = query.eq("level", level);
    if (source) query = query.eq("source", source);
    if (since) query = query.gte("timestamp", since);
    if (until) query = query.lte("timestamp", until);

    if (search) {
      // Try full-text search first; fall back to ilike
      const ftsQuery = sb
        .from("runtime_logs")
        .select("*", { count: "exact" })
        .eq("repo_id", repoId)
        .textSearch("message", search, { type: "websearch" })
        .order("timestamp", { ascending: false })
        .range(offset, offset + pageSize - 1);

      // Apply same filters to FTS query
      let fts = ftsQuery;
      if (level) fts = fts.eq("level", level);
      if (source) fts = fts.eq("source", source);
      if (since) fts = fts.gte("timestamp", since);
      if (until) fts = fts.lte("timestamp", until);

      const { data: ftsData, count: ftsCount, error: ftsError } = await fts;

      if (!ftsError && ftsData) {
        res.json({ entries: ftsData, total: ftsCount || 0, page, pageSize });
        return;
      }

      // Fallback to ilike
      query = query.ilike("message", `%${search}%`);
    }

    const { data, count, error } = await query;

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ entries: data || [], total: count || 0, page, pageSize });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  }
});

// GET /api/runtime-logs/:repoId/stats — aggregated counts
router.get("/:repoId/stats", async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const { since, until } = req.query as Record<string, string | undefined>;

  const sb = getUserDb(req);
  const sinceTs = since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    // Run parallel count queries instead of fetching all rows
    const baseFilter = (level?: string) => {
      let q = sb
        .from("runtime_logs")
        .select("*", { count: "exact", head: true })
        .eq("repo_id", repoId)
        .gte("timestamp", sinceTs);
      if (until) q = q.lte("timestamp", until);
      if (level) q = q.eq("level", level);
      return q;
    };

    // Get distinct sources with counts (limit to avoid fetching all rows)
    let sourcesQuery = sb
      .from("runtime_logs")
      .select("source")
      .eq("repo_id", repoId)
      .gte("timestamp", sinceTs)
      .limit(10000);
    if (until) sourcesQuery = sourcesQuery.lte("timestamp", until);

    const [totalRes, errorRes, warnRes, infoRes, sourcesRes] = await Promise.all([
      baseFilter(),
      baseFilter("error"),
      baseFilter("warn"),
      baseFilter("info"),
      sourcesQuery,
    ]);

    if (totalRes.error) {
      res.status(500).json({ error: totalRes.error.message });
      return;
    }

    // Count sources from the lightweight source-only query
    const bySource: Record<string, number> = {};
    for (const row of sourcesRes.data || []) {
      bySource[row.source] = (bySource[row.source] || 0) + 1;
    }

    res.json({
      total: totalRes.count || 0,
      byLevel: {
        info: infoRes.count || 0,
        warn: warnRes.count || 0,
        error: errorRes.count || 0,
      },
      bySource,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  }
});

export default router;
