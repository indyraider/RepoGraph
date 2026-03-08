# Build Plan: CodeQL Data Flow Integration
**Created:** 2026-03-07
**Brainstorm:** ../brainstorm/codeql-data-flow-brainstorm-2026-03-07.md
**PRD:** Feature Add/repograph-codeql-prd.md
**Status:** Draft

## Overview
Integrate the CodeQL CLI as an async post-Load pipeline stage that runs taint tracking and data flow analysis, stores results as `FLOWS_TO` edges and `DataFlowFinding` nodes in Neo4j, and exposes them via two new MCP tools (`trace_data_flow`, `get_data_flow_findings`). Existing MCP tools (`trace_error`, `get_symbol`) gain data flow context when available.

## Coordination: Multi-Language Support (Parallel Agent)
Another agent is actively building multi-language support (SCIP refactor + Rust/Python/Java/Go adapters). This has two important implications for CodeQL:

**1. CodeQL supports multiple languages too.** The PRD scopes to `--language=javascript` only, but CodeQL has query packs for Python, Java, Go, Ruby, C/C++, and more. The runner should use a **language adapter pattern** (mirroring the SCIP adapter pattern being built) so that adding `codeql/python-queries` later is just a config change, not a code change.

**2. The `codeql database create` command needs a `--language` flag.** For multi-language repos, CodeQL creates separate databases per language. The runner must:
- Accept a language parameter
- Create one database per detected language that CodeQL supports
- Run language-specific query suites against each database
- Merge all SARIF results before passing to the parser

**3. Shared pattern alignment.** The multi-language agent is establishing a `LanguageAdapter` pattern in `scip/runner.ts`. The CodeQL runner should follow the same pattern:
```typescript
interface CodeQLLanguageConfig {
  language: string;        // CodeQL language identifier (e.g., "javascript", "python")
  querySuite: string;      // Query pack (e.g., "codeql/javascript-security-queries")
  extensions: string[];    // File extensions this config covers
}
```

**Build order impact:** Phase 1 (Types + Config + Runner) should define this adapter interface even if we only implement the JavaScript/TypeScript config initially. This avoids a refactor when the multi-language agent's work lands.

**Current scope:** Build with JS/TS only. Design the interfaces to be multi-language-ready.

## Component Inventory

| Component | Location | Inputs | Outputs | External Deps |
|---|---|---|---|---|
| CodeQL config | `packages/backend/src/config.ts` | Env vars | Config object | None |
| CodeQL language configs | `packages/backend/src/pipeline/codeql/runner.ts` | Detected languages | CodeQLLanguageConfig[] | None |
| CodeQL runner | `packages/backend/src/pipeline/codeql/runner.ts` | Repo path, config, language | SARIF file on disk | `codeql` CLI on PATH |
| SARIF parser | `packages/backend/src/pipeline/codeql/sarif-parser.ts` | SARIF file path | `CodeQLFinding[]` | None |
| Node matcher | `packages/backend/src/pipeline/codeql/node-matcher.ts` | Findings, repo URL | `MatchedFinding[]` | Neo4j (queries Function nodes) |
| CodeQL loader | `packages/backend/src/pipeline/codeql/loader.ts` | Matched findings | FLOWS_TO edges, DataFlowFinding nodes | Neo4j (writes) |
| CodeQL types | `packages/backend/src/pipeline/codeql/types.ts` | — | Type definitions | None |
| CodeQL orchestrator | `packages/backend/src/pipeline/codeql/index.ts` | Stage input | Stage result + stats | All above |
| Async digest wiring | `packages/backend/src/pipeline/digest.ts` | Successful Load | Launches CodeQL async | Supabase (stats update) |
| `trace_data_flow` tool | `packages/mcp-server/src/codeql-tools.ts` | MCP call params | JSON response | Neo4j (reads) |
| `get_data_flow_findings` tool | `packages/mcp-server/src/codeql-tools.ts` | MCP call params | JSON response | Neo4j (reads) |
| Tool registration | `packages/mcp-server/src/index.ts` | — | — | codeql-tools module |
| Existing tool enrichment | `packages/mcp-server/src/index.ts` | Existing queries | +data_flow_count | Neo4j (reads) |

## Integration Contracts

### Contract 1: Config → Runner
```
config.ts → codeql/runner.ts
  What flows:     { enabled: bool, timeoutMs: number, maxDiskMb: number }
  How it flows:   Direct import of config object
  Auth/Config:    CODEQL_ENABLED, CODEQL_TIMEOUT_MS, CODEQL_MAX_DISK_MB env vars
  Error path:     If disabled, orchestrator skips immediately (no runner call)
```

### Contract 2: digest.ts → CodeQL Orchestrator
```
digest.ts (after Load completes) → codeql/index.ts runCodeQLStage()
  What flows:     CodeQLStageInput { repoPath, repoUrl, jobId, commitSha, detectedLanguages }
  How it flows:   Async fire-and-forget: digest.ts calls runCodeQLStage() without awaiting
  Auth/Config:    None (uses same Neo4j/Supabase connections)
  Error path:     All errors caught inside runCodeQLStage(). Updates digest_jobs.stats
                  with codeql stats on completion. Never throws to caller.
```

**Critical wiring detail:** `runDigest()` must NOT await the CodeQL stage. The pattern:
```typescript
// Fire and forget — digest returns immediately
runCodeQLStage(codeqlInput).catch(err => {
  console.error('[codeql] Unhandled error:', err);
});
```

### Contract 3: Runner → SARIF File
```
codeql/runner.ts → filesystem → codeql/sarif-parser.ts
  What flows:     SARIF JSON file at /tmp/repograph-jobs/{jobId}/results.sarif
  How it flows:   runner.ts spawns `codeql database create` then `codeql database analyze`,
                  writes SARIF to disk. sarif-parser.ts reads the file.
  Auth/Config:    CodeQL CLI must be on PATH
  Error path:     If codeql not on PATH → return { success: false, error: 'not_installed' }
                  If database create fails → return { success: false, error: stderr }
                  If analyze fails → return { success: false, error: stderr }
                  If timeout → kill process, return { success: false, error: 'timeout' }
```

### Contract 4: SARIF Parser → Node Matcher
```
codeql/sarif-parser.ts → codeql/node-matcher.ts
  What flows:     CodeQLFinding[] — each has:
                    { queryId, severity, message,
                      source: { file, line, column },
                      sink: { file, line, column },
                      pathSteps: [{ file, line, column, message }] }
  How it flows:   Direct function call, in-process
  Error path:     Malformed SARIF → throw with details, orchestrator catches
```

### Contract 5: Node Matcher → Loader
```
codeql/node-matcher.ts → codeql/loader.ts
  What flows:     MatchedFinding[] — each has:
                    { queryId, severity, message,
                      sourceNodeId: string | null, sinkNodeId: string | null,
                      sourceFile, sourceLine, sinkFile, sinkLine,
                      pathSteps, pathComplete: boolean }
  How it flows:   Direct function call
  Error path:     Findings with both sourceNodeId and sinkNodeId null are dropped.
                  Findings with one null get pathComplete: false.
```

**Matching logic:**
1. Query Neo4j: `MATCH (f:Function {repo_url: $repo, file_path: $file}) WHERE f.start_line <= $line AND f.end_line >= $line RETURN f`
2. If no match → try closest Function in same file
3. If still no match → log `unmatched_codeql_location`, skip

### Contract 6: Loader → Neo4j
```
codeql/loader.ts → Neo4j
  What flows:     FLOWS_TO edges + DataFlowFinding nodes
  How it flows:   Cypher MERGE/CREATE via neo4j-driver session
  Auth/Config:    Same Neo4j connection as rest of pipeline
  Error path:     Neo4j write failure → throw, orchestrator catches and logs

  Schema:
    (DataFlowFinding {
      query_id, severity, message, source_path, sink_path,
      repo_url, job_id, digest_id
    })

    (source:Function)-[:FLOWS_TO {
      query_id, sink_kind, severity, message,
      path_steps (JSON string), path_complete
    }]->(sink:Function)

  Before writing: DELETE all existing FLOWS_TO edges and DataFlowFinding nodes
  for this repo_url. (Full replacement on each run.)
```

### Contract 7: Orchestrator → Supabase (stats update)
```
codeql/index.ts → Supabase digest_jobs table
  What flows:     CodeQL stats merged into existing job stats JSON
  How it flows:   Read current stats → merge codeql stats → write back
  Auth/Config:    Same Supabase service client
  Error path:     If job has been superseded (new digest started), log warning and skip update

  Stats shape:
    { codeql: {
        status: 'success' | 'failed' | 'skipped' | 'timeout',
        durationMs: number,
        findingCount: number,
        flowEdgeCount: number,
        unmatchedLocations: number,
        queriesRun: string[],
        error?: string
      }
    }
```

### Contract 8: MCP Tools → Neo4j (reads)
```
codeql-tools.ts → Neo4j
  What flows:     Cypher queries for FLOWS_TO edges and DataFlowFinding nodes

  trace_data_flow:
    Input: { file, line, direction: 'from_source' | 'to_sink', repo, query_id? }
    Query: Match Function node at file:line, then traverse FLOWS_TO edges
    Output: Array of { source, sink, pathSteps, queryId, severity, message }

  get_data_flow_findings:
    Input: { repo, severity?, query_id?, file?, max_results? }
    Query: MATCH (f:DataFlowFinding {repo_url: $repo}) with optional filters
    Output: Array of { queryId, severity, message, source, sink }
```

### Contract 9: Tool Registration
```
codeql-tools.ts exports registerCodeQLTools(server, getSession, getSupabase, scopedRepo)
index.ts calls registerCodeQLTools(...) alongside registerRuntimeTools etc.
```

## End-to-End Flows

### Flow 1: Happy Path — Full Digest with CodeQL
```
1. User triggers digest via POST /digest or sync webhook
2. runDigest() runs: Clone → Scan → Parse → SCIP → Resolve → Deps → Load
3. Load completes → digest marks job "complete", returns DigestResult
4. ASYNC: runCodeQLStage() fires (not awaited)
   4a. Check config.codeql.enabled → if false, skip
   4b. Check if codeql CLI is on PATH → if not, log warning, skip
   4c. Check cache: same commitSha? → if yes, skip (already have results)
   4d. Create CodeQL database: spawn `codeql database create`
   4e. Run analysis: spawn `codeql database analyze` → SARIF output
   4f. Parse SARIF → CodeQLFinding[]
   4g. Match findings to Neo4j Function nodes → MatchedFinding[]
   4h. Clear old FLOWS_TO edges + DataFlowFinding nodes for this repo
   4i. Write new FLOWS_TO edges + DataFlowFinding nodes
   4j. Update digest_jobs.stats with codeql stats
   4k. Clean up CodeQL database from disk
5. User queries MCP tools → sees data flow findings
```

### Flow 2: CodeQL Not Installed
```
1. runDigest() completes normally (stages 1-6)
2. ASYNC: runCodeQLStage() fires
   2a. config.codeql.enabled → true
   2b. Check PATH for `codeql` → NOT FOUND
   2c. Log: "[codeql] CodeQL CLI not found on PATH — skipping"
   2d. Update digest_jobs.stats: { codeql: { status: 'skipped', error: 'not_installed' } }
3. MCP tools return empty results for data flow queries (graceful)
```

### Flow 3: CodeQL Analysis Timeout
```
1. Load completes, CodeQL fires async
2. `codeql database analyze` runs past timeoutMs
3. Runner kills process (SIGKILL)
4. Orchestrator catches timeout, logs it
5. Stats updated: { codeql: { status: 'timeout', durationMs: X } }
6. CodeQL database cleaned up from disk
7. No FLOWS_TO edges written (old findings remain cleared since purge happens before write)
```

**Issue detected:** The purge-then-write pattern means a timeout leaves the repo with NO findings — old ones were deleted, new ones weren't written. Options:
- (A) Purge only on successful write (current recommendation)
- (B) Purge first, accept gap on failure
- (C) Write to temp edges, swap atomically

**Recommendation: Option A** — purge after parsing succeeds but before writing, so stale data only goes away when replacement data is ready.

### Flow 4: MCP Query During CodeQL Run
```
1. Digest completes, CodeQL running async
2. User asks Claude "any security issues in this codebase?"
3. Claude calls get_data_flow_findings
4. Tool queries Neo4j for DataFlowFinding nodes
5. Returns previous run's findings (or empty if first run)
6. CodeQL finishes later → findings updated for next query
```

### Flow 5: Error — SARIF Parse Failure
```
1. CodeQL database create succeeds
2. CodeQL analyze succeeds, writes SARIF
3. SARIF parser fails (malformed output)
4. Orchestrator catches, logs error
5. Stats: { codeql: { status: 'failed', error: 'SARIF parse error: ...' } }
6. No purge, no write — previous findings remain intact
7. CodeQL database cleaned up
```

## Issues Found

### Issue 1: Async Stats Update Race
**Problem:** `runDigest()` writes job stats at line 543-557 and marks job "complete". The async CodeQL stage later reads those stats, merges its own, and writes back. If a new digest starts before CodeQL finishes, it creates a new job row — the stats update targets the old job ID, which is fine (no race). But the new digest will purge the CodeQL findings that were just being written.

**Fix:** The CodeQL orchestrator receives `jobId` as input. It updates only that specific job row. The purge-and-write in the loader is atomic within a single Neo4j transaction. No additional locking needed as long as:
1. Purge + write happen in a single Neo4j transaction
2. Stats update targets the specific `jobId`, not "latest job"

### Issue 2: Purge-Before-Write Data Loss on Failure
**Problem:** If we purge old findings then CodeQL fails mid-write, the repo has incomplete findings.

**Fix:** Restructure: parse and match first, then purge+write in one transaction. Only purge when we have replacement data ready.

### Issue 3: CodeQL CLI in Production
**Problem:** CodeQL CLI is ~500MB. Railway containers have limited disk. The `nixpacks.toml` doesn't mention CodeQL.

**Fix for now:** Feature is opt-in via `CODEQL_ENABLED=true`. In production on Railway, it's disabled by default. For self-hosted deployments with CodeQL installed, it works. Document the requirement clearly.

### Issue 4: MCP Tools Don't Indicate CodeQL Status
**Problem:** When a user queries data flow findings, they can't tell if CodeQL hasn't run yet vs. there are genuinely no findings.

**Fix:** `get_data_flow_findings` response includes a header line indicating CodeQL status: "CodeQL last ran at X" or "CodeQL has not run for this repo" or "CodeQL is currently running." Pull from `digest_jobs.stats.codeql.status`.

### Issue 5: Node Matcher — Anonymous Functions
**Problem:** CodeQL may report a line inside an anonymous arrow function. The parser may not have extracted that as a separate Function node — it may only exist as part of a parent function's range.

**Fix:** When matching, return the innermost Function node whose range contains the line. If the parser doesn't extract arrow functions as separate nodes, the match goes to the enclosing function. This is acceptable — the finding still connects to the right general area. Log as `matched_to_enclosing` for debugging.

### Issue 6: Clone Lifecycle vs Async CodeQL
**Problem:** `digest.ts:594-597` has a `finally` block that calls `cleanupClone(scanPath)`. CodeQL runs async AFTER digest returns, so the clone gets deleted while CodeQL still needs it. This is the most critical wiring bug in the plan.

**Fix options:**
- (a) **Delay cleanup** — pass a `Promise` or callback to CodeQL, let it signal when done. `finally` awaits CodeQL completion before cleanup. But this defeats the async purpose (digest doesn't return until CodeQL finishes).
- (b) **Create CodeQL database synchronously, analyze async** — `codeql database create` copies source into its own format. Once the database is created, the original clone can be deleted. Only the analysis (the slow part) runs async.
- (c) **Let CodeQL manage its own clone** — CodeQL gets the repo URL and clones separately. Wasteful but simple.

**Recommendation: Option B** — Create the CodeQL database synchronously (fast, ~30s), then let analysis run async. The database is a self-contained copy, so the clone can be cleaned up immediately after database creation. This adds ~30s to digest time but keeps the async benefit for the slow analysis step (2-10 min).

**Implementation:** In `digest.ts`, before the `finally` block:
```typescript
// Create CodeQL database synchronously (needs repo on disk)
const codeqlDbPath = await createCodeQLDatabaseIfEnabled(scanPath, jobId, detectedLanguages);
// Analysis runs async after digest returns — doesn't need the clone
if (codeqlDbPath) {
  runCodeQLAnalysis(codeqlDbPath, repoUrl, jobId, commitSha).catch(...);
}
```

### Issue 7: Multi-Language Agent Coordination
**Problem:** The multi-language agent is modifying `scip/runner.ts`, `scip/index.ts`, and `scip/types.ts` in parallel. The CodeQL build creates a new `codeql/` directory so there's no file-level conflict, but the `digest.ts` changes could collide if both agents add code to the same section.

**Fix:** The CodeQL stage wires into `digest.ts` at a different point than SCIP (post-Load vs pre-Resolve), so the edits target different line ranges. However, coordinate with the multi-language agent before Phase 4 (Digest Wiring) to ensure no merge conflicts.

## Wiring Checklist

### Infrastructure & Config
- [ ] Add `codeql` section to `config.ts`: `enabled`, `timeoutMs` (default 900000 = 15min), `maxDiskMb` (default 2048)
- [ ] Add env vars to .env.example: `CODEQL_ENABLED`, `CODEQL_TIMEOUT_MS`, `CODEQL_MAX_DISK_MB`

### Backend Pipeline — Types
- [ ] Create `packages/backend/src/pipeline/codeql/types.ts` with:
  - `CodeQLLanguageConfig` (language, querySuite, extensions) — adapter pattern for multi-language
  - `CodeQLStageInput` (repoPath, repoUrl, jobId, commitSha, detectedLanguages)
  - `CodeQLStageResult` (stats, skipped flag)
  - `CodeQLStats` (status, durationMs, findingCount, flowEdgeCount, unmatchedLocations, queriesRun, error?)
  - `CodeQLFinding` (queryId, severity, message, source/sink locations, pathSteps)
  - `MatchedFinding` (CodeQLFinding + sourceNodeId, sinkNodeId, pathComplete)

### Backend Pipeline — Runner
- [ ] Create `packages/backend/src/pipeline/codeql/runner.ts`:
  - Define `CODEQL_LANGUAGE_CONFIGS` registry: `Map<string, CodeQLLanguageConfig>` with JS/TS config initially
  - `getCodeQLConfigsForLanguages(languages: string[]): CodeQLLanguageConfig[]` — mirrors SCIP's `getAdaptersForLanguages()`
  - `isCodeQLAvailable()`: spawn `codeql --version`, return bool
  - `createCodeQLDatabase(repoPath, outputDir, language, timeoutMs)`: spawn `codeql database create --language=X`
  - `runCodeQLAnalysis(dbPath, sarifPath, querySuite, timeoutMs)`: spawn `codeql database analyze`
  - Follow SCIP runner.ts pattern: spawn, stderr capture, timeout, exit code handling
  - Clean up CodeQL database directory after analysis

### Backend Pipeline — SARIF Parser
- [ ] Create `packages/backend/src/pipeline/codeql/sarif-parser.ts`:
  - `parseSarif(filePath): CodeQLFinding[]`
  - Extract from SARIF: `runs[].results[]` → source/sink from `relatedLocations` or `codeFlows`
  - Map `level` to severity: `error` | `warning` | `note`
  - Extract `ruleId` as `queryId`

### Backend Pipeline — Node Matcher
- [ ] Create `packages/backend/src/pipeline/codeql/node-matcher.ts`:
  - `matchFindings(findings, repoUrl, session): MatchedFinding[]`
  - Query: `MATCH (f:Function {repo_url: $repo, file_path: $file}) WHERE f.start_line <= $line AND f.end_line >= $line RETURN f ORDER BY (f.end_line - f.start_line) ASC LIMIT 1`
  - Innermost function wins (smallest range containing the line)
  - Log unmatched locations

### Backend Pipeline — Loader
- [ ] Create `packages/backend/src/pipeline/codeql/loader.ts`:
  - `loadCodeQLFindings(repoUrl, findings, jobId, session)`:
    - In single transaction: purge old FLOWS_TO + DataFlowFinding for repo, then batch create new ones
    - `FLOWS_TO` edges between matched Function nodes
    - `DataFlowFinding` nodes with query_id, severity, message, source/sink paths

### Backend Pipeline — Orchestrator
- [ ] Create `packages/backend/src/pipeline/codeql/index.ts`:
  - `runCodeQLStage(input: CodeQLStageInput): Promise<CodeQLStageResult>`
  - Flow: check enabled → check CLI → check cache → create DB → analyze → parse → match → load → update stats → cleanup
  - All errors caught internally, never throws
  - Updates `digest_jobs.stats` with codeql stats on completion

### Backend Pipeline — Digest Wiring
- [ ] In `digest.ts`, after Load completes and before returning DigestResult:
  - Fire `runCodeQLStage()` without awaiting
  - Pass: `{ repoPath: scanPath, repoUrl: req.url, jobId: job.id, commitSha, detectedLanguages }`
  - `detectedLanguages` comes from `allFiles.map(f => f.language)` (already available in digest)
  - **Important:** Must pass `scanPath` before `cleanupClone()` runs in the `finally` block. If using a cloned repo (not localPath), CodeQL needs the repo on disk. Either:
    - (a) Delay `cleanupClone` until CodeQL finishes (preferred)
    - (b) Have CodeQL make its own clone
    - (c) Create CodeQL database synchronously before cleanup, run analysis async

### MCP Tools — CodeQL Tools
- [ ] Create `packages/mcp-server/src/codeql-tools.ts`:
  - `registerCodeQLTools(server, getSession, getSupabase, scopedRepo)`
  - `trace_data_flow` tool: params (file, line, direction, repo, query_id?)
  - `get_data_flow_findings` tool: params (repo, severity?, query_id?, file?, max_results?)

### MCP Tools — Registration
- [ ] In `packages/mcp-server/src/index.ts`:
  - Import `registerCodeQLTools` from `./codeql-tools.js`
  - Call `registerCodeQLTools(server, getSession, getUserSupabase, SCOPED_REPO)` after `registerCallChainTools`

### MCP Tools — Existing Tool Enrichment
- [ ] In `get_symbol` tool response: add `data_flow_findings_count` if Function has FLOWS_TO edges
- [ ] In `trace_error` tool: check if error location is a FLOWS_TO sink, add source context

## Build Order

### Phase 1: Types + Config + Runner
Create the type definitions, config section, and CodeQL subprocess runner. This is the foundation everything else depends on.

**Files:** `codeql/types.ts`, `codeql/runner.ts`, `config.ts` (edit)
**Validates:** `codeql --version` check works, runner can spawn processes
**Checkpoint gate:** Runner can detect CodeQL CLI presence, create a database, and run analysis on a test repo

### Phase 2: SARIF Parser + Node Matcher
Parse CodeQL's SARIF output and match findings to existing Neo4j nodes.

**Files:** `codeql/sarif-parser.ts`, `codeql/node-matcher.ts`
**Depends on:** Phase 1 types
**Validates:** Parser extracts findings from real SARIF output, matcher finds correct Function nodes
**Checkpoint gate:** Given a SARIF file and a populated Neo4j graph, produces MatchedFinding[] with correct node IDs

### Phase 3: Loader + Orchestrator
Write findings to Neo4j and wire up the full stage orchestration.

**Files:** `codeql/loader.ts`, `codeql/index.ts`
**Depends on:** Phase 1 + 2
**Validates:** FLOWS_TO edges appear in Neo4j, DataFlowFinding nodes created, stats recorded
**Checkpoint gate:** `runCodeQLStage()` completes end-to-end, findings visible in Neo4j

### Phase 4: Digest Wiring
Connect the CodeQL stage to the digest pipeline. Two-step approach: create CodeQL database synchronously (needs repo on disk), then fire async analysis.

**Files:** `digest.ts` (edit)
**Depends on:** Phase 3
**Validates:**
- CodeQL database created synchronously before clone cleanup
- Analysis runs async after digest returns
- Clone cleaned up immediately after database creation (not delayed)
- Stats appear in digest_jobs after async completion
**Checkpoint gate:** Full digest with CodeQL fires, clone cleaned up promptly, analysis completes in background

### Phase 5: MCP Tools
Create the two new MCP tools and register them.

**Files:** `codeql-tools.ts`, `index.ts` (edit)
**Depends on:** Phase 3 (data in Neo4j)
**Validates:** `trace_data_flow` and `get_data_flow_findings` return correct results
**Checkpoint gate:** MCP tools queryable, return findings from Neo4j

### Phase 6: Existing Tool Enrichment
Add data flow context to `get_symbol` and `trace_error`.

**Files:** `index.ts` (edit), `runtime-tools.ts` (edit)
**Depends on:** Phase 5
**Validates:** `get_symbol` shows finding count, `trace_error` shows data flow source
**Checkpoint gate:** Enriched responses visible in MCP tool output
