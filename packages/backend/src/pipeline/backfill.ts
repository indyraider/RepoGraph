import { simpleGit } from "simple-git";
import { getSupabase } from "../db/supabase.js";
import { scanRepo } from "./scanner.js";
import { parseFile, isSupportedLanguage, ParsedSymbol, ParsedImport, ParsedExport, BarrelInfo } from "./parser.js";
import { resolveImports } from "./resolver.js";
import { loadToNeo4j } from "./loader.js";
import { ingestCommitHistory, CommitMeta } from "./commit-ingester.js";
import { diffGraph } from "./differ.js";
import { temporalLoad } from "./temporal-loader.js";
import { computeComplexityMetrics } from "./complexity.js";

// ─── Types ──────────────────────────────────────────────────────

export interface BackfillOptions {
  /** Maximum number of commits to process (default: 50). */
  maxCommits?: number;
  /** Skip complexity metrics computation per commit (faster). */
  skipMetrics?: boolean;
}

export interface BackfillResult {
  commitsProcessed: number;
  commitsTotal: number;
  durationMs: number;
  errors: string[];
}

// ─── Main entry point ───────────────────────────────────────────

/**
 * Run historical backfill: iterate through commit history oldest→newest,
 * running the parse→resolve→diff→temporalLoad pipeline for each commit.
 *
 * SCIP is skipped per-commit (too expensive). Only structural analysis
 * (symbols, imports) is performed.
 *
 * Prerequisites:
 * - `localPath` must be a full clone (not shallow) with history available.
 * - Commit nodes should already be ingested via `ingestCommitHistory()`.
 * - The repo must already have a Repository node in Neo4j.
 */
export async function runHistoricalBackfill(
  localPath: string,
  repoUrl: string,
  repoId: string,
  repoName: string,
  branch: string,
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  const startTime = Date.now();
  const maxCommits = options.maxCommits ?? 50;
  const skipMetrics = options.skipMetrics ?? false;
  const errors: string[] = [];

  const git = simpleGit(localPath);

  // Get commit list (oldest → newest)
  const log = await git.log({ maxCount: maxCommits });
  const commits: CommitMeta[] = log.all.map((entry) => ({
    sha: entry.hash,
    author: entry.author_name,
    authorEmail: entry.author_email,
    timestamp: new Date(entry.date),
    message: entry.message,
    parentShas: [],
  })).reverse(); // oldest first

  if (commits.length === 0) {
    return { commitsProcessed: 0, commitsTotal: 0, durationMs: 0, errors: [] };
  }

  console.log(`[backfill] Processing ${commits.length} commits (oldest → newest)`);

  // Ensure commit nodes exist in Neo4j
  await ingestCommitHistory(localPath, repoUrl, repoId, maxCommits);

  // Track progress in Supabase temporal_digest_jobs
  const sb = getSupabase();
  const { data: jobRow } = await sb
    .from("temporal_digest_jobs")
    .insert({
      repo_id: repoId,
      mode: "historical",
      commits_total: commits.length,
      commits_processed: 0,
      oldest_commit_sha: commits[0].sha,
      newest_commit_sha: commits[commits.length - 1].sha,
      status: "running",
    })
    .select("id")
    .single();

  const jobId = jobRow?.id;
  let commitsProcessed = 0;

  // Store the original HEAD so we can restore it
  const originalHead = (await git.revparse(["HEAD"])).trim();

  try {
    for (const commit of commits) {
      try {
        console.log(
          `[backfill] [${commitsProcessed + 1}/${commits.length}] Processing ${commit.sha.slice(0, 8)}: ${commit.message.slice(0, 60)}`
        );

        // Checkout this commit
        await git.checkout(commit.sha);

        // Scan all files at this commit
        const allFiles = await scanRepo(localPath);

        // Load File nodes (classic MERGE — files don't need versioning)
        await loadToNeo4j(repoUrl, repoName, branch, commit.sha, allFiles);

        // Parse all supported files
        const allSymbols: ParsedSymbol[] = [];
        const allImports: ParsedImport[] = [];
        const allExports: ParsedExport[] = [];
        const barrelMap = new Map<string, BarrelInfo>();

        for (const file of allFiles) {
          if (isSupportedLanguage(file.language)) {
            try {
              const result = parseFile(file.path, file.content, file.language);
              allSymbols.push(...result.symbols);
              allImports.push(...result.imports);
              allExports.push(...result.exports);
              if (result.barrel) barrelMap.set(file.path, result.barrel);
            } catch {
              // Skip unparseable files silently in backfill
            }
          }
        }

        // Resolve imports (no SCIP — too expensive per commit)
        const resolveResult = resolveImports(allImports, localPath, allExports, allSymbols, barrelMap);

        // Diff against previous graph state and apply temporal changes
        // This MUST be sequential — each diffGraph reads the state written by the previous temporalLoad
        const changeset = await diffGraph(repoUrl, allSymbols, resolveResult.imports, []);

        await temporalLoad(repoUrl, changeset, commit);

        // Compute complexity metrics for this commit
        if (!skipMetrics) {
          try {
            await computeComplexityMetrics(
              repoUrl, repoId, commit.sha, commit.timestamp.toISOString()
            );
          } catch (metricsErr) {
            const msg = metricsErr instanceof Error ? metricsErr.message : String(metricsErr);
            console.warn(`[backfill] Metrics failed for ${commit.sha.slice(0, 8)}: ${msg}`);
          }
        }

        commitsProcessed++;

        // Update progress
        if (jobId) {
          await sb
            .from("temporal_digest_jobs")
            .update({ commits_processed: commitsProcessed })
            .eq("id", jobId);
        }
      } catch (err) {
        const msg = `${commit.sha.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[backfill] Failed on commit ${msg}`);
        errors.push(msg);
        // Continue to next commit — don't abort the whole backfill
      }
    }
  } finally {
    // Restore original HEAD
    try {
      await git.checkout(originalHead);
    } catch {
      console.warn("[backfill] Could not restore original HEAD");
    }
  }

  const durationMs = Date.now() - startTime;

  // Mark job complete
  if (jobId) {
    await sb
      .from("temporal_digest_jobs")
      .update({
        status: errors.length > 0 ? "completed_with_errors" : "completed",
        commits_processed: commitsProcessed,
        completed_at: new Date().toISOString(),
        stats: { durationMs, errors: errors.length },
        error_log: errors.length > 0 ? errors.join("\n") : null,
      })
      .eq("id", jobId);
  }

  console.log(
    `[backfill] Complete: ${commitsProcessed}/${commits.length} commits in ${(durationMs / 1000).toFixed(1)}s` +
    (errors.length > 0 ? ` (${errors.length} errors)` : "")
  );

  return { commitsProcessed, commitsTotal: commits.length, durationMs, errors };
}
