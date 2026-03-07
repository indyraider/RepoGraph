import { getSupabase } from "../db/supabase.js";
import { cloneRepo, cleanupClone, RepoOwnedError } from "./cloner.js";
import { scanRepo, ScannedFile } from "./scanner.js";
import { parseFile, isSupportedLanguage, ParsedSymbol, ParsedImport, ParsedExport, BarrelInfo } from "./parser.js";
import { resolveImports, ResolveResult } from "./resolver.js";
import { loadToNeo4j, loadToSupabase, loadSymbolsToNeo4j, loadImportsToNeo4j, loadDependenciesToNeo4j, loadCallsToNeo4j, purgeRepoFromNeo4j, removeFilesFromNeo4j, removeFilesFromSupabase, purgeImportEdges, purgeCallsEdges, countRepoGraph } from "./loader.js";
import { runScipStage } from "./scip/index.js";
import { enrichDirectImports } from "./scip/edge-enricher.js";
import { CallsEdge } from "./scip/types.js";
import { SymbolTableEntry } from "./scip/symbol-table.js";
import { indexDependencies } from "./deps/indexer.js";
import { ingestCommitHistory, CommitMeta } from "./commit-ingester.js";
import { diffGraph } from "./differ.js";
import { temporalLoad, TemporalLoadResult } from "./temporal-loader.js";
import { computeComplexityMetrics } from "./complexity.js";

export interface DigestRequest {
  url: string;
  branch: string;
  /** If provided, skip cloning and scan this path directly. */
  localPath?: string;
  /** What triggered this digest. */
  trigger?: "manual" | "webhook" | "watcher";
  /** Supabase Auth user ID — set as owner_id on the repository. */
  ownerId?: string;
  /** Skip same-commit check and force a full re-digest. */
  force?: boolean;
  /** Clone depth for git history access. 0 = full clone, 1 = shallow (default). */
  historyDepth?: number;
  /** Per-user GitHub token for cloning private repos. */
  githubToken?: string;
}

/** Numeric keys from stats that we track deltas for. */
const DELTA_KEYS = [
  "fileCount", "symbolCount", "importCount", "directImportCount",
  "resolvedImports", "unresolvedImports", "nodeCount", "edgeCount",
  "packageCount", "exportedSymbolCount",
] as const;

export type DigestStats = {
  fileCount: number;
  symbolCount: number;
  importCount: number;
  directImportCount: number;
  resolvedImports: number;
  unresolvedImports: number;
  dynamicImports: number;
  externalImports: number;
  unresolvedSymbols: number;
  barrelCycles: number;
  barrelDepthExceeded: number;
  packageCount: number;
  exportedSymbolCount: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
  changedFiles?: number;
  deletedFiles?: number;
};

/** Per-field difference: positive = enriched, negative = reduced. */
export type DigestDelta = {
  [K in (typeof DELTA_KEYS)[number]]?: number;
};

export interface DigestResult {
  repoId: string;
  jobId: string;
  incremental: boolean;
  stats: DigestStats;
  /** Difference vs. the previous completed digest (null on first digest). */
  delta: DigestDelta | null;
  /** Paths that were changed/added in this digest (incremental only). */
  changedPaths?: string[];
  /** Paths that were deleted in this digest (incremental only). */
  deletedPaths?: string[];
}

function extractRepoName(url: string): string {
  // Handle HTTPS: https://github.com/user/repo.git
  // Handle SSH: git@github.com:user/repo.git
  // Handle local paths: /path/to/repo
  const match = url.match(/\/([^/]+?)(?:\.git)?$/);
  return match?.[1] || url;
}

async function updateJobStage(
  jobId: string,
  stage: string,
  extra?: Record<string, unknown>
): Promise<void> {
  const sb = getSupabase();
  await sb
    .from("digest_jobs")
    .update({ stage, ...extra })
    .eq("id", jobId);
}

/**
 * Fetch stored content hashes from Supabase for a repo.
 * Returns a map of file_path → content_hash.
 */
async function getStoredHashes(repoId: string): Promise<Map<string, string>> {
  const sb = getSupabase();
  const hashes = new Map<string, string>();

  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data } = await sb
      .from("file_contents")
      .select("file_path, content_hash")
      .eq("repo_id", repoId)
      .range(offset, offset + pageSize - 1);

    if (!data || data.length === 0) break;
    for (const row of data) {
      if (row.content_hash) hashes.set(row.file_path, row.content_hash);
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return hashes;
}

/**
 * Diff scanned files against stored hashes to find changed, new, and deleted files.
 */
function diffFiles(
  scanned: ScannedFile[],
  storedHashes: Map<string, string>
): { changed: ScannedFile[]; deleted: string[] } {
  const changed: ScannedFile[] = [];
  const scannedPaths = new Set<string>();

  for (const file of scanned) {
    scannedPaths.add(file.path);
    const storedHash = storedHashes.get(file.path);
    if (!storedHash || storedHash !== file.contentHash) {
      changed.push(file);
    }
  }

  const deleted: string[] = [];
  for (const storedPath of storedHashes.keys()) {
    if (!scannedPaths.has(storedPath)) {
      deleted.push(storedPath);
    }
  }

  return { changed, deleted };
}

/**
 * Fetch the stats from the most recent completed digest job for a repo.
 */
async function getPreviousStats(repoId: string): Promise<DigestStats | null> {
  const sb = getSupabase();
  const { data } = await sb
    .from("digest_jobs")
    .select("stats")
    .eq("repo_id", repoId)
    .eq("status", "complete")
    .order("completed_at", { ascending: false })
    .limit(1)
    .single();
  return (data?.stats as DigestStats) ?? null;
}

function computeDelta(current: DigestStats, previous: DigestStats): DigestDelta {
  const delta: DigestDelta = {};
  for (const key of DELTA_KEYS) {
    const diff = (current[key] ?? 0) - (previous[key] ?? 0);
    if (diff !== 0) delta[key] = diff;
  }
  return delta;
}

export async function runDigest(req: DigestRequest): Promise<DigestResult> {
  const sb = getSupabase();
  const startTime = Date.now();
  const repoName = extractRepoName(req.url);

  // Check ownership before upserting — prevent one user from stealing another's repo
  const { data: existingRepo } = await sb
    .from("repositories")
    .select("id, commit_sha, owner_id")
    .eq("url", req.url)
    .single();

  if (existingRepo && existingRepo.owner_id && req.ownerId && existingRepo.owner_id !== req.ownerId) {
    throw new RepoOwnedError(req.url);
  }

  // Upsert repository record (include owner_id if provided)
  const repoRow: Record<string, unknown> = {
    url: req.url, name: repoName, branch: req.branch, status: "digesting",
  };
  if (req.ownerId) repoRow.owner_id = req.ownerId;
  // Claim unowned repos
  if (existingRepo && !existingRepo.owner_id && req.ownerId) {
    repoRow.owner_id = req.ownerId;
  }

  const { data: repo, error: repoErr } = await sb
    .from("repositories")
    .upsert(repoRow, { onConflict: "url" })
    .select("id, commit_sha")
    .single();

  if (repoErr || !repo) throw new Error(`Failed to create repo: ${repoErr?.message}`);

  // Fetch previous digest stats for delta comparison
  const previousStats = await getPreviousStats(repo.id);

  // Create digest job
  const { data: job, error: jobErr } = await sb
    .from("digest_jobs")
    .insert({ repo_id: repo.id, status: "running", stage: "cloning" })
    .select("id")
    .single();

  if (jobErr || !job) throw new Error(`Failed to create job: ${jobErr?.message}`);

  // Determine if we're using a user-provided local path (watcher mode)
  const isLocalPath = !!req.localPath;
  let scanPath: string | null = null;
  let commitSha = "unknown";

  try {
    // Stage 1: Clone (skip if localPath provided)
    if (isLocalPath) {
      scanPath = req.localPath!;
      // Get commit SHA from local .git
      try {
        const { simpleGit } = await import("simple-git");
        const git = simpleGit(scanPath);
        const log = await git.log({ maxCount: 1 });
        commitSha = log.latest?.hash || "unknown";
      } catch (gitErr) {
        console.warn("[digest] Failed to read local git SHA:", gitErr instanceof Error ? gitErr.message : gitErr);
        commitSha = "unknown";
      }
    } else {
      const cloneResult = await cloneRepo(req.url, req.branch, req.historyDepth ?? 1, req.githubToken);
      scanPath = cloneResult.localPath;
      commitSha = cloneResult.commitSha;
    }

    // Check if this is an incremental digest (same commit = skip entirely)
    // For watcher-triggered digests, skip this check — files may have changed without a commit
    const isFirstDigest = !repo.commit_sha;
    const sameCommit = !req.force && !isLocalPath && !isFirstDigest && repo.commit_sha === commitSha;

    if (sameCommit) {
      // No changes — mark complete immediately
      const durationMs = Date.now() - startTime;
      const stats = {
        fileCount: 0, symbolCount: 0, importCount: 0,
        directImportCount: 0, resolvedImports: 0, unresolvedImports: 0,
        dynamicImports: 0, externalImports: 0, unresolvedSymbols: 0,
        barrelCycles: 0, barrelDepthExceeded: 0,
        packageCount: 0, exportedSymbolCount: 0,
        nodeCount: 0, edgeCount: 0, durationMs,
        changedFiles: 0, deletedFiles: 0,
      };

      await sb.from("digest_jobs").update({
        status: "complete", stage: "done",
        completed_at: new Date().toISOString(), stats,
      }).eq("id", job.id);

      await sb.from("repositories").update({
        status: "idle", last_digest_at: new Date().toISOString(),
      }).eq("id", repo.id);

      return { repoId: repo.id, jobId: job.id, incremental: true, stats, delta: null };
    }

    // Stage 1.5: Ingest commit history (if history depth > 0)
    const historyDepth = req.historyDepth ?? 1;
    let headCommit: CommitMeta | undefined;
    if (scanPath && historyDepth > 0) {
      try {
        const ingestionResult = await ingestCommitHistory(scanPath, req.url, repo.id, historyDepth);
        // Keep the HEAD commit for temporal loader attribution
        if (ingestionResult.commits.length > 0) {
          headCommit = ingestionResult.commits[0];
        }
      } catch (err) {
        console.warn("[digest] Commit history ingestion failed (non-fatal):", err instanceof Error ? err.message : err);
      }
    }

    // Stage 2: Scan
    console.log(`[digest] Stage: scanning ${scanPath}`);
    await updateJobStage(job.id, "scanning");
    const allFiles = await scanRepo(scanPath);
    console.log(`[digest] Scanned ${allFiles.length} files`);

    // Determine if incremental: compare content hashes
    let filesToProcess: ScannedFile[];
    let deletedPaths: string[] = [];
    let incremental = false;

    if (!isFirstDigest) {
      const storedHashes = await getStoredHashes(repo.id);
      if (storedHashes.size > 0) {
        const diff = diffFiles(allFiles, storedHashes);
        filesToProcess = diff.changed;
        deletedPaths = diff.deleted;
        incremental = true;
        console.log(
          `[digest] Incremental: ${diff.changed.length} changed, ${diff.deleted.length} deleted, ${allFiles.length - diff.changed.length} unchanged`
        );
      } else {
        filesToProcess = allFiles;
      }
    } else {
      filesToProcess = allFiles;
    }

    // Stage 3: Parse — always parse all files (import resolution needs full set)
    console.log("[digest] Stage: parsing");
    await updateJobStage(job.id, "parsing");
    const allSymbols: ParsedSymbol[] = [];
    const allImports: ParsedImport[] = [];
    const allExports: ParsedExport[] = [];
    const barrelMap = new Map<string, BarrelInfo>();

    let parseFailures = 0;
    for (const file of allFiles) {
      if (isSupportedLanguage(file.language)) {
        try {
          const result = parseFile(file.path, file.content, file.language);
          allSymbols.push(...result.symbols);
          allImports.push(...result.imports);
          allExports.push(...result.exports);
          if (result.barrel) {
            barrelMap.set(file.path, result.barrel);
          }
        } catch (parseErr) {
          parseFailures++;
          console.warn(`[digest] Parse skipped ${file.path} (${file.language}):`, parseErr instanceof Error ? parseErr.message : parseErr);
        }
      }
    }
    if (parseFailures > 0) {
      console.warn(`[digest] ${parseFailures} file(s) failed to parse — skipped`);
    }
    console.log(`[digest] Parsed ${allSymbols.length} symbols, ${allImports.length} imports`);

    // Stage 3.5: SCIP type analysis (between Parse and Resolve)
    console.log("[digest] Stage: SCIP type analysis");
    await updateJobStage(job.id, "scip");
    const scipResult = await runScipStage({
      repoPath: scanPath,
      repoUrl: req.url,
      jobId: job.id,
      commitSha,
      allFiles,
      allSymbols,
      allExports,
      directImports: [], // populated after Resolve
    });
    let scipSymbolTable: Map<string, SymbolTableEntry> | undefined = scipResult.symbolTable;
    let callsEdges: CallsEdge[] = scipResult.callsEdges;
    if (scipResult.skipped) {
      console.log(`[digest] SCIP skipped: ${scipResult.stats.reason || scipResult.stats.scipStatus}`);
    } else {
      console.log(`[digest] SCIP: ${scipResult.stats.callsEdgeCount} CALLS edges, ${scipResult.stats.scipSymbolCount} symbols`);
    }

    // Stage 4: Resolve imports
    console.log("[digest] Stage: resolving imports");
    await updateJobStage(job.id, "resolving");
    const resolveResult = resolveImports(allImports, scanPath, allExports, allSymbols, barrelMap);

    // Post-Resolve: enrich DirectlyImportsEdge with SCIP type info
    if (scipSymbolTable && !scipResult.skipped) {
      enrichDirectImports(resolveResult.directImports, scipSymbolTable);
    }

    // Stage 5: Index upstream dependencies
    await updateJobStage(job.id, "deps");
    const indexedPackages = await indexDependencies(scanPath, (msg) => {
      console.log(`[deps] ${msg}`);
    });

    // Stage 6: Load
    console.log("[digest] Stage: loading to Neo4j + Supabase");
    await updateJobStage(job.id, "loading");

    // Remove deleted files from Supabase
    if (deletedPaths.length > 0) {
      await removeFilesFromSupabase(repo.id, deletedPaths);
    }

    // Decide loading strategy: temporal vs classic
    const useTemporal = !!headCommit;
    let nodeCount: number;
    let edgeCount: number;
    let temporalResult: TemporalLoadResult | undefined;

    if (useTemporal) {
      // ── Temporal path: diff → versioned load ──
      console.log("[digest] Using temporal loading path");
      await updateJobStage(job.id, "diffing");

      const changeset = await diffGraph(req.url, allSymbols, resolveResult.imports, callsEdges);

      // Load File nodes with classic MERGE (files don't need versioning)
      await loadToNeo4j(req.url, repoName, req.branch, commitSha, allFiles);

      // Load symbols, imports, and calls edges via temporal versioning
      await updateJobStage(job.id, "loading");
      temporalResult = await temporalLoad(req.url, changeset, headCommit!);

      // Load dependencies (non-temporal, packages don't version)
      await loadDependenciesToNeo4j(req.url, indexedPackages);

      // External imports (File→Package) and DIRECTLY_IMPORTS edges:
      // Not temporally versioned — use classic load.
      // Internal IMPORTS (File→File) are handled by temporalLoad() above.
      // Pass only external imports to avoid MERGE conflicts with temporal edges.
      const externalOnlyImports = resolveResult.imports.filter((imp) => imp.toFile === null);
      await loadImportsToNeo4j(req.url, {
        imports: externalOnlyImports,
        directImports: resolveResult.directImports,
        stats: resolveResult.stats,
      } as ResolveResult);

      // Load EXPORTS edges (non-temporal, symbol-level)
      await loadSymbolsToNeo4j(req.url, [], allExports);

      // Compute complexity metrics (non-fatal)
      try {
        await computeComplexityMetrics(
          req.url, repo.id, commitSha, headCommit!.timestamp.toISOString()
        );
      } catch (metricsErr) {
        console.warn("[digest] Complexity metrics failed (non-fatal):", metricsErr instanceof Error ? metricsErr.message : metricsErr);
      }

      // Query actual totals
      const totals = await countRepoGraph(req.url);
      nodeCount = totals.nodeCount;
      edgeCount = totals.edgeCount;
    } else {
      // ── Classic path: MERGE-based load (no commit metadata available) ──
      const useIncrementalNeo4j = incremental && (filesToProcess.length + deletedPaths.length) < 500;

      let fileNodes: number, fileEdges: number;
      let symbolNodes: number, symbolEdges: number;
      let importEdges: number;
      let depNodes: number, depEdges: number;
      let callsEdgeCount = 0;

      if (useIncrementalNeo4j) {
        const pathsToRemove = [
          ...filesToProcess.map((f) => f.path),
          ...deletedPaths,
        ];
        if (pathsToRemove.length > 0) {
          await removeFilesFromNeo4j(req.url, pathsToRemove);
        }

        ({ nodeCount: fileNodes, edgeCount: fileEdges } = await loadToNeo4j(
          req.url, repoName, req.branch, commitSha, filesToProcess
        ));

        const changedPaths = new Set(filesToProcess.map((f) => f.path));
        const changedSymbols = allSymbols.filter((s) => changedPaths.has(s.filePath));
        const changedExports = allExports.filter((e) => changedPaths.has(e.filePath));
        ({ nodeCount: symbolNodes, edgeCount: symbolEdges } =
          await loadSymbolsToNeo4j(req.url, changedSymbols, changedExports));

        await purgeImportEdges(req.url);
        importEdges = await loadImportsToNeo4j(req.url, resolveResult);

        await purgeCallsEdges(req.url);
        callsEdgeCount = await loadCallsToNeo4j(req.url, callsEdges);

        depNodes = 0;
        depEdges = 0;

        const totals = await countRepoGraph(req.url);
        fileNodes = totals.nodeCount;
        fileEdges = totals.edgeCount;
        symbolNodes = 0;
        symbolEdges = 0;
        importEdges = 0;
        callsEdgeCount = 0;
      } else {
        await purgeRepoFromNeo4j(req.url);

        ({ nodeCount: fileNodes, edgeCount: fileEdges } = await loadToNeo4j(
          req.url, repoName, req.branch, commitSha, allFiles
        ));

        ({ nodeCount: symbolNodes, edgeCount: symbolEdges } =
          await loadSymbolsToNeo4j(req.url, allSymbols, allExports));

        importEdges = await loadImportsToNeo4j(req.url, resolveResult);
        callsEdgeCount = await loadCallsToNeo4j(req.url, callsEdges);

        ({ nodeCount: depNodes, edgeCount: depEdges } =
          await loadDependenciesToNeo4j(req.url, indexedPackages));
      }

      nodeCount = fileNodes + symbolNodes + depNodes;
      edgeCount = fileEdges + symbolEdges + importEdges + depEdges + callsEdgeCount;
    }

    // Load file contents to Supabase (only changed files in incremental mode)
    await loadToSupabase(repo.id, incremental ? filesToProcess : allFiles);

    // Mark complete
    const durationMs = Date.now() - startTime;
    const stats = {
      fileCount: allFiles.length,
      symbolCount: allSymbols.length,
      importCount: resolveResult.imports.length,
      directImportCount: resolveResult.directImports.length,
      resolvedImports: resolveResult.stats.resolved,
      unresolvedImports: resolveResult.stats.unresolvable,
      dynamicImports: resolveResult.stats.dynamic,
      externalImports: resolveResult.stats.external,
      unresolvedSymbols: resolveResult.stats.unresolvedSymbols,
      barrelCycles: resolveResult.stats.barrelCycles,
      barrelDepthExceeded: resolveResult.stats.barrelDepthExceeded,
      packageCount: indexedPackages.length,
      exportedSymbolCount: indexedPackages.reduce((sum, p) => sum + p.exports.length, 0),
      nodeCount,
      edgeCount,
      durationMs,
      ...(incremental ? { changedFiles: filesToProcess.length, deletedFiles: deletedPaths.length } : {}),
    };

    // Include SCIP and temporal stats in persisted job stats
    const jobStats = {
      ...stats,
      scip: scipResult.stats,
      ...(temporalResult ? { temporal: temporalResult } : {}),
    };

    await sb
      .from("digest_jobs")
      .update({
        status: "complete",
        stage: "done",
        completed_at: new Date().toISOString(),
        stats: jobStats,
      })
      .eq("id", job.id);

    await sb
      .from("repositories")
      .update({
        status: "idle",
        last_digest_at: new Date().toISOString(),
        commit_sha: commitSha,
      })
      .eq("id", repo.id);

    const delta = previousStats ? computeDelta(stats, previousStats) : null;
    if (delta && Object.keys(delta).length > 0) {
      const parts = Object.entries(delta).map(([k, v]) => `${k}: ${v! > 0 ? "+" : ""}${v}`);
      console.log(`[digest] Delta vs previous: ${parts.join(", ")}`);
    } else if (delta) {
      console.log("[digest] Delta vs previous: no changes");
    }

    return {
      repoId: repo.id, jobId: job.id, incremental, stats, delta,
      ...(incremental ? { changedPaths: filesToProcess.map(f => f.path), deletedPaths } : {}),
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await sb
      .from("digest_jobs")
      .update({ status: "failed", error_log: errorMsg })
      .eq("id", job.id);
    // For sync-triggered digests, keep repo status as "idle" so auto-sync can retry.
    // For manual digests, mark as "error" so the user sees the failure.
    const failureStatus = (req.trigger === "webhook" || req.trigger === "watcher") ? "idle" : "error";
    await sb
      .from("repositories")
      .update({ status: failureStatus })
      .eq("id", repo.id);
    throw err;
  } finally {
    // Only clean up if we cloned (not if using user's local path)
    if (!isLocalPath && scanPath) await cleanupClone(scanPath);
  }
}
