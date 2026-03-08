import { mkdir } from "fs/promises";
import path from "path";
import { config } from "../../config.js";
import { getSession } from "../../db/neo4j.js";
import { getSupabase } from "../../db/supabase.js";
import {
  CodeQLStageInput,
  CodeQLStageResult,
  CodeQLStats,
  CodeQLLanguageConfig,
  CodeQLFinding,
} from "./types.js";
import {
  isCodeQLAvailable,
  getCodeQLConfigsForLanguages,
  createCodeQLDatabase,
  runCodeQLAnalysis as runAnalysis,
  cleanupCodeQLDatabase,
  getCodeQLDbPath,
  getSarifOutputPath,
} from "./runner.js";
import { parseSarif } from "./sarif-parser.js";
import { matchFindings } from "./node-matcher.js";
import { loadCodeQLFindings } from "./loader.js";

/** Result of the synchronous database creation phase. */
export interface CodeQLDatabaseResult {
  /** Per-language database paths that were successfully created */
  databases: { dbPath: string; langConfig: CodeQLLanguageConfig }[];
  /** Whether any databases were created */
  hasWork: boolean;
  /** Whether CodeQL was skipped entirely (disabled, not installed, no languages) */
  skipped: boolean;
  skipReason?: string;
}

function makeSkippedResult(
  status: CodeQLStats["status"],
  reason: string,
  durationMs: number = 0
): CodeQLStageResult {
  return {
    stats: {
      status,
      durationMs,
      findingCount: 0,
      flowEdgeCount: 0,
      unmatchedLocations: 0,
      queriesRun: [],
      reason,
    },
    skipped: true,
  };
}

/**
 * Update the digest_jobs row with CodeQL stats.
 * Reads existing stats, merges codeql stats, writes back.
 */
async function updateJobStats(
  jobId: string,
  codeqlStats: CodeQLStats
): Promise<void> {
  const sb = getSupabase();

  const { data: job } = await sb
    .from("digest_jobs")
    .select("stats")
    .eq("id", jobId)
    .single();

  if (!job) {
    console.warn(`[codeql] Job ${jobId} not found — skipping stats update`);
    return;
  }

  const existingStats = (job.stats as Record<string, unknown>) ?? {};
  const updatedStats = { ...existingStats, codeql: codeqlStats };

  await sb
    .from("digest_jobs")
    .update({ stats: updatedStats })
    .eq("id", jobId);
}

// ── Phase 1: Synchronous database creation (needs repo on disk) ──

/**
 * Create CodeQL databases for all supported languages in the repo.
 * This runs SYNCHRONOUSLY in the digest pipeline before clone cleanup.
 *
 * After this function returns, the original repo can be safely deleted.
 * The CodeQL databases are self-contained copies.
 *
 * @returns Database paths for the async analysis phase, or null if skipped
 */
export async function createCodeQLDatabasesIfEnabled(
  repoPath: string,
  jobId: string,
  detectedLanguages: string[]
): Promise<CodeQLDatabaseResult> {
  if (!config.codeql.enabled) {
    return { databases: [], hasWork: false, skipped: true, skipReason: "CodeQL disabled via config" };
  }

  const available = await isCodeQLAvailable();
  if (!available) {
    console.warn("[codeql] CodeQL CLI not found on PATH — skipping");
    return { databases: [], hasWork: false, skipped: true, skipReason: "CodeQL CLI not installed" };
  }

  const langConfigs = getCodeQLConfigsForLanguages(detectedLanguages);
  if (langConfigs.length === 0) {
    return { databases: [], hasWork: false, skipped: true, skipReason: "No CodeQL-supported languages detected" };
  }

  console.log(
    `[codeql] Creating databases for: ${langConfigs.map((c) => c.label).join(", ")}`
  );

  const databases: CodeQLDatabaseResult["databases"] = [];

  for (const langConfig of langConfigs) {
    const dbPath = getCodeQLDbPath(jobId, langConfig.language);
    await mkdir(path.dirname(dbPath), { recursive: true });

    const result = await createCodeQLDatabase(
      repoPath,
      dbPath,
      langConfig.language
    );

    if (result.success) {
      databases.push({ dbPath, langConfig });
    } else {
      console.error(
        `[codeql] Database creation failed for ${langConfig.label}: ${result.error}`
      );
      await cleanupCodeQLDatabase(dbPath);
    }
  }

  return {
    databases,
    hasWork: databases.length > 0,
    skipped: false,
  };
}

// ── Phase 2: Async analysis (does NOT need repo on disk) ──

/**
 * Run CodeQL analysis on pre-created databases, parse results,
 * match to graph nodes, and load findings into Neo4j.
 *
 * This runs ASYNCHRONOUSLY after the digest returns.
 * The repo clone can already be deleted — databases are self-contained.
 *
 * This function NEVER throws — all errors are caught and reported via stats.
 */
export async function runCodeQLAnalysisStage(
  dbResult: CodeQLDatabaseResult,
  repoUrl: string,
  jobId: string,
  commitSha: string
): Promise<CodeQLStageResult> {
  const startTime = Date.now();

  try {
    // Handle skip cases (record in stats)
    if (dbResult.skipped) {
      const result = makeSkippedResult("skipped", dbResult.skipReason ?? "skipped");
      await updateJobStats(jobId, result.stats);
      return result;
    }

    if (!dbResult.hasWork) {
      const result = makeSkippedResult("failed", "All database creations failed");
      await updateJobStats(jobId, result.stats);
      return result;
    }

    // Analyze each database, parse SARIF, collect findings
    const allFindings: CodeQLFinding[] = [];
    const queriesRun: string[] = [];
    let anySuccess = false;
    let anyFailed = false;

    for (const { dbPath, langConfig } of dbResult.databases) {
      const sarifPath = getSarifOutputPath(jobId, langConfig.language);

      const analyzeResult = await runAnalysis(
        dbPath,
        sarifPath,
        langConfig.querySuite
      );

      if (!analyzeResult.success) {
        const status =
          analyzeResult.error?.startsWith("timeout") ? "timeout" : "failed";
        console.error(
          `[codeql] Analysis failed for ${langConfig.label} (${status}): ${analyzeResult.error}`
        );
        anyFailed = true;
        await cleanupCodeQLDatabase(dbPath);
        continue;
      }

      queriesRun.push(langConfig.querySuite);

      try {
        const findings = await parseSarif(sarifPath);
        allFindings.push(...findings);
        anySuccess = true;
      } catch (err) {
        console.error(
          `[codeql] SARIF parse failed for ${langConfig.label}:`,
          err instanceof Error ? err.message : err
        );
        anyFailed = true;
      }

      // Clean up database and SARIF file
      await cleanupCodeQLDatabase(dbPath);
      await cleanupCodeQLDatabase(sarifPath);
    }

    if (!anySuccess && anyFailed) {
      const durationMs = Date.now() - startTime;
      const result: CodeQLStageResult = {
        stats: {
          status: "failed",
          durationMs,
          findingCount: 0,
          flowEdgeCount: 0,
          unmatchedLocations: 0,
          queriesRun,
          error: "All language analyses failed",
        },
        skipped: false,
      };
      await updateJobStats(jobId, result.stats);
      return result;
    }

    // Match findings to Neo4j graph nodes
    const session = getSession();
    try {
      const { matched, unmatchedCount } = await matchFindings(
        allFindings,
        repoUrl,
        session
      );

      // Load findings into Neo4j (purge + write)
      const { findingCount, flowEdgeCount } = await loadCodeQLFindings(
        repoUrl,
        matched,
        jobId,
        session
      );

      const durationMs = Date.now() - startTime;
      const status: CodeQLStats["status"] = anyFailed ? "partial" : "success";

      console.log(
        `[codeql] Done (${status}): ${findingCount} findings, ${flowEdgeCount} FLOWS_TO edges, ` +
          `${unmatchedCount} unmatched locations (${durationMs}ms)`
      );

      const result: CodeQLStageResult = {
        stats: {
          status,
          durationMs,
          findingCount,
          flowEdgeCount,
          unmatchedLocations: unmatchedCount,
          queriesRun,
        },
        skipped: false,
      };
      await updateJobStats(jobId, result.stats);
      return result;
    } finally {
      await session.close();
      // Clean up the job-level temp directory
      const jobDir = path.join(config.tempDir, "codeql-jobs", jobId);
      await cleanupCodeQLDatabase(jobDir);
    }
  } catch (err) {
    // Top-level catch — this function must never throw
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[codeql] Unhandled error:", errorMsg);

    const durationMs = Date.now() - startTime;
    const result: CodeQLStageResult = {
      stats: {
        status: "failed",
        durationMs,
        findingCount: 0,
        flowEdgeCount: 0,
        unmatchedLocations: 0,
        queriesRun: [],
        error: errorMsg,
      },
      skipped: false,
    };

    try {
      await updateJobStats(jobId, result.stats);
    } catch (statsErr) {
      console.error(
        "[codeql] Failed to update job stats:",
        statsErr instanceof Error ? statsErr.message : statsErr
      );
    }

    return result;
  }
}

/**
 * Convenience: run the full CodeQL stage in one call (for testing or non-split use).
 * Creates databases then immediately runs analysis.
 */
export async function runCodeQLStage(
  input: CodeQLStageInput
): Promise<CodeQLStageResult> {
  const dbResult = await createCodeQLDatabasesIfEnabled(
    input.repoPath,
    input.jobId,
    input.detectedLanguages
  );

  return runCodeQLAnalysisStage(
    dbResult,
    input.repoUrl,
    input.jobId,
    input.commitSha
  );
}
