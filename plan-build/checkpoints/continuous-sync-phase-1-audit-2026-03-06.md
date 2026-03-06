# Phase 1 Dependency Audit
**Phase:** Pipeline Refactor (Foundation)
**Date:** 2026-03-06
**Status:** ISSUES FOUND

## Verified Connections

### Schema Migration (`supabase-sync-migration.sql`)

- [x] **Add columns to `repositories` table: `sync_mode`, `sync_config`, `last_synced_at`, `last_synced_sha`** — trigger: SQL ALTER TABLE (lines 5-9) -> effect: four columns added with correct types (TEXT DEFAULT 'off', JSONB DEFAULT '{}', TIMESTAMPTZ, TEXT). Uses `ADD COLUMN IF NOT EXISTS` for idempotency.
- [x] **Create `sync_events` table** — trigger: CREATE TABLE IF NOT EXISTS (lines 12-24) -> effect: table with all required columns (id UUID PK, repo_id UUID FK with CASCADE, trigger TEXT, started_at, completed_at, files_changed, files_added, files_removed, duration_ms, status TEXT DEFAULT 'running', error_log TEXT). FK references `repositories(id)` with `ON DELETE CASCADE`.
- [x] **Disable RLS on `sync_events`** — trigger: ALTER TABLE sync_events DISABLE ROW LEVEL SECURITY (line 31) -> effect: RLS disabled. Matches pattern used for other tables in the project.
- [x] **Indexes created** — `idx_sync_events_repo` on `repo_id` and `idx_sync_events_started` on `started_at DESC` (lines 27-28). Good for the query patterns described in the plan (filter by repo, order by time).

### Install chokidar (`packages/backend/package.json`)

- [x] **chokidar in package.json dependencies** — `"chokidar": "^5.0.0"` at line 13 of package.json. Also present in root `package-lock.json` (resolved to 5.0.0). However, `node_modules/chokidar` does not exist on disk — `npm install` has not been run since the dependency was added. See Missing Configuration section.

### DigestRequest Interface Extension (`digest.ts:9-16`)

- [x] **Extend `DigestRequest` with optional `localPath` and `trigger`** — trigger: interface definition at lines 9-16 -> effect: `localPath?: string` (line 13) and `trigger?: "manual" | "webhook" | "watcher"` (line 15). Both optional, backward-compatible with existing callers.

### localPath Skip Clone Path (`digest.ts:139-160`)

- [x] **Skip `cloneRepo()` when `localPath` provided** — trigger: `isLocalPath = !!req.localPath` (line 139) -> handler: if branch (line 145) sets `scanPath = req.localPath!` (line 146) -> else branch (line 156) calls `cloneRepo(req.url, req.branch)` which returns `{ localPath, commitSha }` (verified in `cloner.ts:7-10`) -> effect: `scanPath` is set in both paths.
- [x] **Get commit SHA from local .git via simple-git** — trigger: `isLocalPath` is true (line 145) -> handler: dynamic import `simple-git` (line 149), `simpleGit(scanPath)` (line 150), `git.log({ maxCount: 1 })` (line 151) -> effect: `commitSha = log.latest?.hash || "unknown"` (line 152). Error caught silently with fallback to `"unknown"` (lines 153-154).
- [x] **Skip `cleanupClone()` when localPath provided** — trigger: finally block (line 355) -> handler: `if (!isLocalPath && scanPath)` (line 357) -> effect: `cleanupClone(scanPath)` only called for cloned repos. Confirmed `cleanupClone` does `fs.rm(localPath, { recursive: true, force: true })` — correctly NOT called for user's working directory.

### Incremental Neo4j Update (`digest.ts:248-302`)

- [x] **`removeFilesFromNeo4j` called with correct args** — trigger: `useIncrementalNeo4j` is true (line 257) -> handler: builds `pathsToRemove` from `filesToProcess.map(f => f.path)` + `deletedPaths` (lines 259-262) -> calls: `removeFilesFromNeo4j(req.url, pathsToRemove)` (line 264) -> effect: in `loader.ts:420-438`, runs Cypher `UNWIND $paths ... MATCH (f:File {path: filePath, repo_url: $repoUrl}) OPTIONAL MATCH (f)-[:CONTAINS]->(sym) DETACH DELETE sym, f`. DETACH DELETE removes all relationships (CONTAINS, CONTAINS_FILE, EXPORTS, IMPORTS) connected to both the File node and its child symbol nodes.
- [x] **Re-insert only changed files** — trigger: after removal -> calls: `loadToNeo4j(req.url, repoName, req.branch, commitSha, filesToProcess)` (lines 268-270) with only changed files (not `allFiles`). MERGE on File nodes creates them fresh. Repository node is upserted (idempotent).
- [x] **Filter symbols/exports to changed files** — trigger: `changedPaths = new Set(filesToProcess.map(f => f.path))` (line 273) -> handler: `allSymbols.filter(s => changedPaths.has(s.filePath))` (line 274), `allExports.filter(e => changedPaths.has(e.filePath))` (line 275). Verified `ParsedSymbol.filePath` exists (parser.ts:16) and `ParsedExport.filePath` exists (parser.ts:29). -> calls: `loadSymbolsToNeo4j(req.url, changedSymbols, changedExports)` (lines 276-277). Function signature matches: `(repoUrl: string, symbols: ParsedSymbol[], exportsList: ParsedExport[])` at loader.ts:64-68.

### Import Edge Consistency (`digest.ts:279-282, loader.ts:400-418`)

- [x] **Purge all import edges then re-insert all** — trigger: incremental path (line 279) -> calls: `purgeImportEdges(req.url)` (line 281) -> effect: in `loader.ts:400-418`, two Cypher queries: (1) delete outgoing IMPORTS from files with `repo_url`, (2) delete incoming IMPORTS to files with `repo_url`. This is thorough — covers both directions. -> then calls: `loadImportsToNeo4j(req.url, resolvedImports)` (line 282) with ALL resolved imports (not filtered to changed files). Correct: import resolution is global.

### Large-Diff Fallback (`digest.ts:250`)

- [x] **>500 files triggers full purge+reload** — trigger: `useIncrementalNeo4j = incremental && (filesToProcess.length + deletedPaths.length) < 500` (line 250). When false (>=500 changes), falls through to else branch (line 287) which calls `purgeRepoFromNeo4j(req.url)` followed by full reload of all files, symbols, imports, and dependencies. Threshold is hardcoded at 500.

### Data Flow Verification

- [x] **`filesToProcess` populated correctly in both modes** — First digest: `filesToProcess = allFiles` (lines 209, 212). Incremental: `filesToProcess = diff.changed` (line 202). Empty stored hashes edge case: falls back to `filesToProcess = allFiles` (line 209).
- [x] **`scanPath` set in both paths** — localPath: line 146. Clone: line 158. Both feed into `scanRepo(scanPath)` at line 191 and `resolveImports(allImports, scanPath)` at line 232.
- [x] **`resolvedImports` uses correct scanPath** — `resolveImports(allImports, scanPath)` at line 232. Verified `resolveImports(parsedImports: ParsedImport[], repoPath: string)` signature at resolver.ts:137-140.
- [x] **Supabase upload respects incremental mode** — `loadToSupabase(repo.id, incremental ? filesToProcess : allFiles)` at line 305. Changed files only in incremental mode, all files in full mode.
- [x] **Deleted files removed from Supabase** — `removeFilesFromSupabase(repo.id, deletedPaths)` at lines 244-246. Verified function at loader.ts:440-455 deletes by `repo_id` + `file_path` in batches.

### Error Path Verification

- [x] **simpleGit failure handled** — try/catch at lines 148-155. Falls back to `commitSha = "unknown"`. Error is silently swallowed (no logging).
- [x] **removeFilesFromNeo4j failure propagates** — No try/catch around the call at line 264. If it throws, the error propagates to the outer try/catch at line 344, which marks the job as "failed" and the repo as "error", then re-throws. Error path is clean.
- [x] **purgeImportEdges failure propagates** — Same as above. No local catch. Propagates correctly.

## Stubs & Placeholders Found

None. No TODO, FIXME, HACK, PLACEHOLDER, STUB, or XXX markers found in any of the four audited files.

## Broken Chains

### 1. Incremental mode skips dependency re-indexing on package.json changes

- **The chain:** File change in `package.json` -> detected as changed file -> incremental Neo4j update path -> `depNodes = 0; depEdges = 0` (digest.ts:285-286)
- **Breaks at:** digest.ts:285-286. Dependencies are hardcoded to skip in incremental mode.
- **Evidence:** Lines 284-286: `// Dependencies don't change on file edits — skip unless first digest` followed by `depNodes = 0; depEdges = 0;`. No check for whether `package.json` (or `go.mod`, `requirements.txt`, etc.) is among the changed files.
- **Impact:** LOW for Phase 1. If a user adds a new npm dependency and the watcher triggers an incremental digest, the new Package nodes and DEPENDS_ON edges will not be created. The dependency graph will be stale until a full re-digest (manual or >500 file change). This is a known limitation per the plan's design, not an implementation bug.
- **Fix:** Optional: check if any manifest file (`package.json`, `go.mod`, `requirements.txt`) is in `filesToProcess`. If so, re-run `indexDependencies` and `loadDependenciesToNeo4j`. Defer to Phase 2 or later.

### 2. `commit_sha` set to "unknown" on simpleGit failure breaks future same-commit skip

- **The chain:** localPath mode -> simpleGit fails -> `commitSha = "unknown"` -> stored to `repositories.commit_sha` (line 339) -> next digest checks `repo.commit_sha === commitSha` (line 165)
- **Breaks at:** If simpleGit consistently fails (e.g., path is not a git repo), every digest stores `"unknown"` as the SHA. The `sameCommit` check at line 165 would match (`"unknown" === "unknown"`) BUT this is protected by the `!isLocalPath` guard: `const sameCommit = !isLocalPath && !isFirstDigest && repo.commit_sha === commitSha`. For watcher-triggered digests (which always have `isLocalPath`), the same-commit skip is always bypassed. So this does NOT cause a bug.
- **Impact:** NONE for correctness. The silent error swallowing at line 153 means no visibility into why SHA detection failed.
- **Fix:** Add `console.warn` in the catch block at line 153 for observability.

## Missing Configuration

- [ ] **`npm install` not run** — chokidar is in `package.json` (line 13) and `package-lock.json` but NOT installed in `node_modules`. Run `npm install` in the project root before building or testing. This is a setup step, not a code defect.
- [ ] **500-file threshold is hardcoded** — digest.ts:250 hardcodes the incremental/full-purge threshold at 500. Referenced as a design constant, not configurable. Consider making this a config value if it needs tuning.

## Summary

Phase 1 is solid. All eleven checklist items are correctly implemented with proper execution chains from trigger to effect. The SQL migration is idempotent and complete. The digest pipeline correctly branches between clone and localPath modes, skips cleanup for local paths, retrieves SHA from local git, and implements truly incremental Neo4j updates with the correct deletion-then-reinsertion order. The import edge consistency strategy (purge all + re-insert all) is the right call given that import resolution is global. The large-diff fallback at 500 files works correctly. There are no stubs, no TODOs, and no broken import chains. The two issues found are low-severity: (1) dependency re-indexing is skipped in incremental mode even when manifest files change, and (2) simpleGit failures are silently swallowed. Neither blocks Phase 2. The only action item before testing is running `npm install` to materialize chokidar in `node_modules`.
