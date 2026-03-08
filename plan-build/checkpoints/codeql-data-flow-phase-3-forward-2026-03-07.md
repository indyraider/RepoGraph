# Forward Checkpoint: CodeQL Data Flow — Phase 3 Complete
**Date:** 2026-03-07
**Phase completed:** Phase 3 — Loader + Orchestrator
**Remaining phases:** Phase 4 (Digest Wiring), Phase 5 (MCP Tools), Phase 6 (Existing Tool Enrichment)

---

## 1. Extracted Interfaces (Actual Code)

### `runCodeQLStage()` — Orchestrator (`codeql/index.ts`)

```typescript
export async function runCodeQLStage(
  input: CodeQLStageInput
): Promise<CodeQLStageResult>
```

Where:
```typescript
interface CodeQLStageInput {
  repoPath: string;
  repoUrl: string;
  jobId: string;
  commitSha: string;
  detectedLanguages: string[];
}

interface CodeQLStageResult {
  stats: CodeQLStats;
  skipped: boolean;
}

interface CodeQLStats {
  status: "success" | "partial" | "failed" | "skipped" | "timeout";
  durationMs: number;
  findingCount: number;
  flowEdgeCount: number;
  unmatchedLocations: number;
  queriesRun: string[];
  reason?: string;   // used for skipped status
  error?: string;    // used for failed/timeout status
}
```

**Behaviour:** Never throws. All errors caught internally. Updates `digest_jobs.stats` with codeql sub-object before returning. Manages its own Neo4j session (calls `getSession()` internally, closes in `finally`).

### `loadCodeQLFindings()` — Loader (`codeql/loader.ts`)

```typescript
export async function loadCodeQLFindings(
  repoUrl: string,
  findings: MatchedFinding[],
  jobId: string,
  session: Session
): Promise<{ findingCount: number; flowEdgeCount: number }>
```

**Note:** The loader does NOT manage its own session — it receives one from the orchestrator. The orchestrator creates the session and closes it.

### `matchFindings()` — Node Matcher (`codeql/node-matcher.ts`)

```typescript
export async function matchFindings(
  findings: CodeQLFinding[],
  repoUrl: string,
  session: Session
): Promise<{ matched: MatchedFinding[]; unmatchedCount: number }>
```

### Runner exports used by orchestrator

```typescript
export function isCodeQLAvailable(): Promise<boolean>
export function getCodeQLConfigsForLanguages(languages: string[]): CodeQLLanguageConfig[]
export function createCodeQLDatabase(repoPath, dbOutputDir, language, timeoutMs?): Promise<CodeQLRunResult>
export function runCodeQLAnalysis(dbPath, sarifOutputPath, querySuite, timeoutMs?): Promise<CodeQLRunResult>
export function cleanupCodeQLDatabase(dbPath): Promise<void>
export function getCodeQLDbPath(jobId, language): string
export function getSarifOutputPath(jobId, language): string
```

---

## 2. Mismatch Detection: Phase 4 (Digest Wiring)

### MISMATCH: Orchestrator does NOT support sync/async split

**Plan says (Issue 6, Option B recommendation):** Create CodeQL database synchronously before `cleanupClone()`, then run analysis async. The plan envisions two separate exported functions:
```typescript
const codeqlDbPath = await createCodeQLDatabaseIfEnabled(scanPath, jobId, detectedLanguages);
if (codeqlDbPath) {
  runCodeQLAnalysis(codeqlDbPath, repoUrl, jobId, commitSha).catch(...);
}
```

**Actual code:** `runCodeQLStage()` is a single monolithic function that runs the entire pipeline sequentially: check availability -> per-language loop (create DB -> analyze -> parse SARIF -> cleanup DB) -> match -> load -> update stats. There is no `createCodeQLDatabaseIfEnabled()` export, and the DB creation + analysis are tightly coupled inside a `for` loop.

**Impact:** Phase 4 cannot call `runCodeQLStage()` as fire-and-forget before `cleanupClone()` because the clone directory will be deleted while CodeQL still needs it for `codeql database create`.

**Required fix for Phase 4 — two options:**

**(A) Refactor orchestrator into two functions (recommended, matches plan):**
- Export `createCodeQLDatabases(input: CodeQLStageInput): Promise<CodeQLDbSet | null>` — runs synchronously before clone cleanup. Creates all per-language databases. Returns the paths or null if skipped/unavailable.
- Export `runCodeQLAnalysisStage(dbSet: CodeQLDbSet, input: CodeQLStageInput): Promise<CodeQLStageResult>` — runs async after clone cleanup. Analyzes, parses, matches, loads.
- This keeps digest responsive (only adds ~30s for DB creation) while protecting against clone deletion.

**(B) Simple fire-and-forget with delayed cleanup:**
- Call `runCodeQLStage()` as-is, fire-and-forget.
- Move `cleanupClone()` into CodeQL's completion callback (or use a reference-counted cleanup).
- Problem: if CodeQL takes 15 minutes, clone sits on disk for 15 minutes.

### MISMATCH: `detectedLanguages` source

**Plan says:** `detectedLanguages` comes from `allFiles.map(f => f.language)`.

**Actual `configRegistry` in `runner.ts` maps:** `"typescript"`, `"tsx"`, `"javascript"`.

**Actual `allFiles` structure in `digest.ts`:** Each scanned file has a `.language` property (seen at line 335: `file.language`). The language values come from `scanRepo()`.

**Action for Phase 4:** Verify that `scanRepo()` returns language strings matching the keys in `configRegistry` (`"typescript"`, `"tsx"`, `"javascript"`). If `scanRepo()` returns e.g. `"TypeScript"` (capitalized) or `"ts"` (abbreviated), the mapping will silently fail and CodeQL will skip with "No CodeQL-supported languages detected."

**Recommendation:** Add a normalization step or case-insensitive lookup in `getCodeQLConfigsForLanguages()`, or verify the exact strings from `scanRepo()` before Phase 4 wiring.

### INFO: Stats merge pattern is compatible

The orchestrator calls `updateJobStats()` internally, which reads `digest_jobs.stats`, merges `{ codeql: ... }`, and writes back. This is compatible with the existing pattern in `digest.ts` (lines 542-557) which writes `{ ...stats, scip: ..., temporal: ... }`. The codeql key will be added later by the async function. No conflict.

### INFO: `commitSha` is available in digest.ts

`commitSha` is declared at line 230 and populated by line 248 (clone) or line 241 (local path). It will be available at the point where CodeQL fires.

---

## 3. Mismatch Detection: Phase 5 (MCP Tools)

### Neo4j Schema Actually Written by Loader

**DataFlowFinding nodes:**
```
(:DataFlowFinding {
  repo_url: string,
  job_id: string,
  query_id: string,
  severity: "error" | "warning" | "note",
  message: string,
  source_path: string,     // format: "file/path.ts:42"
  sink_path: string,       // format: "file/path.ts:99"
  path_complete: boolean
})
```

**FLOWS_TO edges:**
```
(:Function)-[:FLOWS_TO {
  query_id: string,
  sink_kind: string,       // derived from queryId (e.g., "sql", "xss", "command")
  severity: "error" | "warning" | "note",
  message: string,
  path_steps: string,      // JSON-stringified CodeQLPathStep[]
  path_complete: boolean
}]->(:Function)
```

### Schema vs Plan Comparison

| Property | Plan (Contract 6) | Actual Loader | Match? |
|---|---|---|---|
| DataFlowFinding.query_id | Yes | Yes | OK |
| DataFlowFinding.severity | Yes | Yes | OK |
| DataFlowFinding.message | Yes | Yes | OK |
| DataFlowFinding.source_path | Yes | Yes (format: "file:line") | OK |
| DataFlowFinding.sink_path | Yes | Yes (format: "file:line") | OK |
| DataFlowFinding.repo_url | Yes | Yes | OK |
| DataFlowFinding.job_id | Yes | Yes | OK |
| DataFlowFinding.digest_id | **Plan says yes** | **NOT written** | MISMATCH |
| DataFlowFinding.path_complete | Not in plan | Written | Extra property (harmless) |
| FLOWS_TO.query_id | Yes | Yes | OK |
| FLOWS_TO.sink_kind | Yes | Yes | OK |
| FLOWS_TO.severity | Yes | Yes | OK |
| FLOWS_TO.message | Yes | Yes | OK |
| FLOWS_TO.path_steps | Yes (JSON string) | Yes (JSON string) | OK |
| FLOWS_TO.path_complete | Yes | Yes | OK |

**MISMATCH: `digest_id` not written.** The plan's Contract 6 specifies `DataFlowFinding` should have a `digest_id` property, but the loader only writes `job_id`. The MCP tools that might filter by digest will need to use `job_id` instead. This is a minor naming difference — `job_id` effectively serves the same role.

### Cypher Queries MCP Tools Will Need

**`trace_data_flow` tool (Contract 8):**
```cypher
-- Find Function node at file:line
MATCH (f:Function {repo_url: $repo, file_path: $file})
WHERE f.start_line <= $line AND f.end_line >= $line

-- Then traverse FLOWS_TO based on direction
-- from_source:
MATCH (f)-[ft:FLOWS_TO]->(sink:Function)
-- to_sink:
MATCH (source:Function)-[ft:FLOWS_TO]->(f)
```
This will work with the actual schema. The FLOWS_TO edges are between Function nodes with query_id, severity, message, path_steps, sink_kind properties — all available for the response.

**`get_data_flow_findings` tool (Contract 8):**
```cypher
MATCH (f:DataFlowFinding {repo_url: $repo})
WHERE ($severity IS NULL OR f.severity = $severity)
  AND ($query_id IS NULL OR f.query_id = $query_id)
  AND ($file IS NULL OR f.source_path STARTS WITH $file OR f.sink_path STARTS WITH $file)
RETURN f
LIMIT $max_results
```
Note: `source_path` and `sink_path` are stored as `"file:line"` strings, so filtering by file requires `STARTS WITH` or `CONTAINS`, not exact match. Phase 5 builder should be aware of this format.

### INFO: No `created_at` timestamp on DataFlowFinding

The plan's Issue 4 says `get_data_flow_findings` should include "CodeQL last ran at X". The DataFlowFinding nodes have no timestamp. The MCP tool will need to query `digest_jobs.stats.codeql` from Supabase (via `job_id`) to get timing info.

---

## 4. Mismatch Detection: Phase 6 (Existing Tool Enrichment)

### `get_symbol` enrichment

**Plan says:** Add `data_flow_findings_count` to get_symbol response if Function has FLOWS_TO edges.

**Required Cypher addition to existing get_symbol query (index.ts:438-474):**
```cypher
OPTIONAL MATCH (sym)-[dff:FLOWS_TO]-()
RETURN ..., count(DISTINCT dff) AS data_flow_count
```
This is straightforward. The existing query already has multiple OPTIONAL MATCH clauses. Adding one more is compatible.

### `trace_error` enrichment

**Plan says:** Check if error location is a FLOWS_TO sink, add source context.

**Required:** After resolving the error function node, run:
```cypher
OPTIONAL MATCH (source:Function)-[ft:FLOWS_TO]->(errorFunc)
RETURN source, ft
```
The trace_error tool (runtime-tools.ts:411+) resolves error locations to Function nodes, so this addition is compatible.

---

## 5. Summary of Required Actions Before Each Phase

### Before Phase 4 (Digest Wiring) — 2 BLOCKING issues:
1. **BLOCKING:** Refactor `runCodeQLStage()` into sync DB creation + async analysis, OR choose a different clone-lifecycle strategy. The current monolithic function cannot be called fire-and-forget before `cleanupClone()`.
2. **VERIFY:** Confirm `scanRepo()` language strings match `configRegistry` keys (`"typescript"`, `"tsx"`, `"javascript"`). Mismatch causes silent skip.

### Before Phase 5 (MCP Tools) — 0 blocking, 2 notes:
1. **NOTE:** `source_path`/`sink_path` are `"file:line"` format strings, not separate fields. MCP queries filtering by file need `STARTS WITH` or string splitting.
2. **NOTE:** No `digest_id` on DataFlowFinding — use `job_id` instead. No `created_at` timestamp — pull timing from Supabase `digest_jobs.stats.codeql`.

### Before Phase 6 (Existing Tool Enrichment) — 0 blocking:
1. **NOTE:** FLOWS_TO edges connect Function nodes. Both `get_symbol` and `trace_error` already resolve to Function nodes, so the join is straightforward.

---

## 6. Purge Safety Assessment

The plan identified a purge-before-write data loss risk (Issue 2) and recommended Option A (purge only when replacement data is ready).

**Actual implementation status:** The loader purges BEFORE writing, but only after all findings have been parsed and matched (the orchestrator calls `loadCodeQLFindings()` only after `matchFindings()` succeeds). However, the purge and writes are NOT in a single Neo4j transaction — they are separate `session.run()` calls. A crash between purge and write would lose data.

**Risk level:** Low (transient — next CodeQL run restores data), but worth noting. If transactional safety is desired, wrap `purgeCodeQLData()` + `writeFindingNodes()` + `writeFlowEdges()` in an explicit Neo4j transaction.
