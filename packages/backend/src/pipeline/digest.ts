import { getSupabase } from "../db/supabase.js";
import { cloneRepo, cleanupClone } from "./cloner.js";
import { scanRepo, ScannedFile } from "./scanner.js";
import { parseFile, isSupportedLanguage, ParsedSymbol, ParsedImport, ParsedExport } from "./parser.js";
import { resolveImports } from "./resolver.js";
import { loadToNeo4j, loadToSupabase, loadSymbolsToNeo4j, loadImportsToNeo4j, loadDependenciesToNeo4j, purgeRepoFromNeo4j, removeFilesFromNeo4j, removeFilesFromSupabase, purgeImportEdges } from "./loader.js";
import { indexDependencies } from "./deps/indexer.js";

export interface DigestRequest {
  url: string;
  branch: string;
  /** If provided, skip cloning and scan this path directly. */
  localPath?: string;
  /** What triggered this digest. */
  trigger?: "manual" | "webhook" | "watcher";
  /** Supabase Auth user ID — set as owner_id on the repository. */
  ownerId?: string;
}

export interface DigestResult {
  repoId: string;
  jobId: string;
  incremental: boolean;
  stats: {
    fileCount: number;
    symbolCount: number;
    importCount: number;
    packageCount: number;
    exportedSymbolCount: number;
    nodeCount: number;
    edgeCount: number;
    durationMs: number;
    changedFiles?: number;
    deletedFiles?: number;
  };
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

export async function runDigest(req: DigestRequest): Promise<DigestResult> {
  const sb = getSupabase();
  const startTime = Date.now();
  const repoName = extractRepoName(req.url);

  // Upsert repository record (include owner_id if provided)
  const repoRow: Record<string, unknown> = {
    url: req.url, name: repoName, branch: req.branch, status: "digesting",
  };
  if (req.ownerId) repoRow.owner_id = req.ownerId;

  const { data: repo, error: repoErr } = await sb
    .from("repositories")
    .upsert(repoRow, { onConflict: "url" })
    .select("id, commit_sha")
    .single();

  if (repoErr || !repo) throw new Error(`Failed to create repo: ${repoErr?.message}`);

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
      const cloneResult = await cloneRepo(req.url, req.branch);
      scanPath = cloneResult.localPath;
      commitSha = cloneResult.commitSha;
    }

    // Check if this is an incremental digest (same commit = skip entirely)
    // For watcher-triggered digests, skip this check — files may have changed without a commit
    const isFirstDigest = !repo.commit_sha;
    const sameCommit = !isLocalPath && !isFirstDigest && repo.commit_sha === commitSha;

    if (sameCommit) {
      // No changes — mark complete immediately
      const durationMs = Date.now() - startTime;
      const stats = {
        fileCount: 0, symbolCount: 0, importCount: 0,
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

      return { repoId: repo.id, jobId: job.id, incremental: true, stats };
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

    let parseFailures = 0;
    for (const file of allFiles) {
      if (isSupportedLanguage(file.language)) {
        try {
          const result = parseFile(file.path, file.content, file.language);
          allSymbols.push(...result.symbols);
          allImports.push(...result.imports);
          allExports.push(...result.exports);
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

    // Stage 4: Resolve imports
    console.log("[digest] Stage: resolving imports");
    await updateJobStage(job.id, "resolving");
    const resolvedImports = resolveImports(allImports, scanPath);

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

    // Decide: incremental Neo4j update vs full purge+reload
    // Use incremental if this is not the first digest AND fewer than 500 files changed
    const useIncrementalNeo4j = incremental && (filesToProcess.length + deletedPaths.length) < 500;

    let fileNodes: number, fileEdges: number;
    let symbolNodes: number, symbolEdges: number;
    let importEdges: number;
    let depNodes: number, depEdges: number;

    if (useIncrementalNeo4j) {
      // Incremental: remove only changed+deleted file nodes, then re-insert changed+all imports
      const pathsToRemove = [
        ...filesToProcess.map((f) => f.path),
        ...deletedPaths,
      ];
      if (pathsToRemove.length > 0) {
        await removeFilesFromNeo4j(req.url, pathsToRemove);
      }

      // Re-insert only changed files as File nodes
      ({ nodeCount: fileNodes, edgeCount: fileEdges } = await loadToNeo4j(
        req.url, repoName, req.branch, commitSha, filesToProcess
      ));

      // Re-insert symbols only for changed files
      const changedPaths = new Set(filesToProcess.map((f) => f.path));
      const changedSymbols = allSymbols.filter((s) => changedPaths.has(s.filePath));
      const changedExports = allExports.filter((e) => changedPaths.has(e.filePath));
      ({ nodeCount: symbolNodes, edgeCount: symbolEdges } =
        await loadSymbolsToNeo4j(req.url, changedSymbols, changedExports));

      // Re-insert ALL import edges (global — a changed export affects other files' edges)
      // First purge all existing import edges for this repo, then reload
      await purgeImportEdges(req.url);
      importEdges = await loadImportsToNeo4j(req.url, resolvedImports);

      // Dependencies don't change on file edits — skip unless first digest
      depNodes = 0;
      depEdges = 0;
    } else {
      // Full purge and reload
      await purgeRepoFromNeo4j(req.url);

      ({ nodeCount: fileNodes, edgeCount: fileEdges } = await loadToNeo4j(
        req.url, repoName, req.branch, commitSha, allFiles
      ));

      ({ nodeCount: symbolNodes, edgeCount: symbolEdges } =
        await loadSymbolsToNeo4j(req.url, allSymbols, allExports));

      importEdges = await loadImportsToNeo4j(req.url, resolvedImports);

      ({ nodeCount: depNodes, edgeCount: depEdges } =
        await loadDependenciesToNeo4j(req.url, indexedPackages));
    }

    // Load file contents to Supabase (only changed files in incremental mode)
    await loadToSupabase(repo.id, incremental ? filesToProcess : allFiles);

    const nodeCount = fileNodes + symbolNodes + depNodes;
    const edgeCount = fileEdges + symbolEdges + importEdges + depEdges;

    // Mark complete
    const durationMs = Date.now() - startTime;
    const stats = {
      fileCount: allFiles.length,
      symbolCount: allSymbols.length,
      importCount: resolvedImports.length,
      packageCount: indexedPackages.length,
      exportedSymbolCount: indexedPackages.reduce((sum, p) => sum + p.exports.length, 0),
      nodeCount,
      edgeCount,
      durationMs,
      ...(incremental ? { changedFiles: filesToProcess.length, deletedFiles: deletedPaths.length } : {}),
    };

    await sb
      .from("digest_jobs")
      .update({
        status: "complete",
        stage: "done",
        completed_at: new Date().toISOString(),
        stats,
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

    return { repoId: repo.id, jobId: job.id, incremental, stats };
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
