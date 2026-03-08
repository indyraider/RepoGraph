# Brainstorm: CodeQL Data Flow Integration
**Created:** 2026-03-07
**Status:** Draft
**PRD:** Feature Add/repograph-codeql-prd.md

## Vision
Add data flow analysis to RepoGraph by integrating the CodeQL CLI as an async post-Load pipeline stage. CodeQL analyzes taint tracking and cross-function value flow — answering questions like "could untrusted input reach this database query?" that the structural graph + SCIP type enrichment cannot answer. Results are stored as `FLOWS_TO` edges and `DataFlowFinding` nodes in Neo4j, exposed via two new MCP tools.

## Existing Context

### Pipeline Architecture (via RepoGraph)
The digest pipeline in `packages/backend/src/pipeline/digest.ts` (line 181, `runDigest`) orchestrates:
```
Clone → Scan → Parse → SCIP → Resolve → Deps → Load (temporal or classic)
```

CodeQL slots in as an **async post-Load stage** — the structural graph is queryable immediately while CodeQL runs in the background.

### SCIP as the Closest Analog
The SCIP subsystem (`packages/backend/src/pipeline/scip/`) is the closest pattern to follow:
- **runner.ts** — subprocess runner with adapter pattern, timeout, error handling via `spawn()`
- **index.ts** — orchestrator (`runScipStage`) with cache check, skip logic, fail-open behavior
- **parser.ts** — parses SCIP protobuf output into structured data
- **cache.ts** — commit-SHA-keyed caching
- **types.ts** — stage input/output types
- **node-enricher.ts** / **edge-enricher.ts** — writes enrichments to graph nodes/edges
- **calls-extractor.ts** — creates CALLS edges from SCIP occurrences

Key difference: SCIP is synchronous (runs between Parse and Resolve). CodeQL must be fully async.

### Configuration Pattern
`packages/backend/src/config.ts` has a `scip` section with `enabled`, `timeoutMs`, `maxMemoryMb`. CodeQL needs a parallel `codeql` config section.

### Neo4j Loader Pattern
`packages/backend/src/pipeline/loader.ts` handles all Neo4j writes with batch MERGE/CREATE patterns. New `FLOWS_TO` edges and `DataFlowFinding` nodes follow the same pattern.

### MCP Tool Registration
`packages/mcp-server/src/index.ts` registers tools via `server.tool()`. Feature-specific tools are split into files (`runtime-tools.ts`, `temporal-tools.ts`, `call-chain-tools.ts`) with a `register*Tools(server, ...)` pattern.

### Supabase Job Tracking
`digest_jobs` table tracks stage, status, stats, error_log. CodeQL stats merge into `jobStats` alongside SCIP stats.

## Components Identified

### 1. CodeQL Config (`config.ts` addition)
- **Responsibility**: Expose `codeql.enabled`, `codeql.timeoutMs`, `codeql.maxDiskMb`, `codeql.querySuite` settings
- **Upstream (receives from)**: Environment variables (`CODEQL_ENABLED`, `CODEQL_TIMEOUT_MS`, etc.)
- **Downstream (sends to)**: CodeQL runner, CodeQL orchestrator
- **External dependencies**: None
- **Hands test**: PASS — reads env vars, returns config object

### 2. CodeQL Runner (`packages/backend/src/pipeline/codeql/runner.ts`)
- **Responsibility**: Execute `codeql database create` and `codeql database analyze` as child processes
- **Upstream (receives from)**: Repo clone path, job ID, config settings
- **Downstream (sends to)**: SARIF output file on disk
- **External dependencies**: `codeql` CLI on PATH (installed via `gh extensions install github/gh-codeql`)
- **Hands test**: FAIL if CodeQL CLI not installed — must fail open with clear logging
- **Notes**: Follow SCIP runner.ts pattern: `spawn()`, timeout, stderr capture, exit code handling

### 3. SARIF Parser (`packages/backend/src/pipeline/codeql/sarif-parser.ts`)
- **Responsibility**: Parse SARIF JSON output into structured finding objects with source/sink locations and path steps
- **Upstream (receives from)**: SARIF file path from runner
- **Downstream (sends to)**: Node matcher
- **External dependencies**: None (SARIF is a standard JSON schema)
- **Hands test**: PASS — reads file, returns typed objects

### 4. Node Matcher (`packages/backend/src/pipeline/codeql/node-matcher.ts`)
- **Responsibility**: Match CodeQL source/sink locations (file:line) to existing Function/Parameter nodes in Neo4j
- **Upstream (receives from)**: Parsed SARIF findings, allSymbols from parse stage
- **Downstream (sends to)**: Edge writer
- **External dependencies**: Neo4j session (to query existing nodes by file path + line range)
- **Hands test**: PASS — queries Neo4j, returns matched node IDs
- **Risk**: Highest-risk component. CodeQL locations may not align exactly with parser-produced Function node ranges.

### 5. Edge & Finding Writer (`packages/backend/src/pipeline/codeql/loader.ts`)
- **Responsibility**: Write `FLOWS_TO` edges and `DataFlowFinding` nodes to Neo4j; clear stale findings on re-digest
- **Upstream (receives from)**: Matched findings from node matcher
- **Downstream (sends to)**: Neo4j graph (consumed by MCP tools)
- **External dependencies**: Neo4j session
- **Hands test**: PASS — follows existing loader.ts MERGE/CREATE pattern

### 6. CodeQL Orchestrator (`packages/backend/src/pipeline/codeql/index.ts`)
- **Responsibility**: Coordinate the full CodeQL stage: config check → cache check → runner → parser → matcher → writer. Report stats.
- **Upstream (receives from)**: `runDigest` in digest.ts (called after Load stage completes)
- **Downstream (sends to)**: Stats merged into `digest_jobs.stats`
- **External dependencies**: All sub-components above
- **Hands test**: PASS — but must be wired as async (not blocking digest completion)

### 7. Async Wiring in `digest.ts`
- **Responsibility**: Launch CodeQL stage asynchronously after Load, update job stats when complete
- **Upstream (receives from)**: Successful Load stage
- **Downstream (sends to)**: CodeQL orchestrator; updates `digest_jobs` with CodeQL stats
- **External dependencies**: None
- **Hands test**: CRITICAL — the digest must return `DigestResult` immediately while CodeQL runs in background. Need a mechanism to update job stats after async completion.
- **Risk**: Current `runDigest` is a single async function that returns when all stages complete. Need to fire-and-forget the CodeQL stage, then update Supabase job stats when it finishes. Cannot use the same `job.id` update pattern without a race condition.

### 8. `trace_data_flow` MCP Tool (`packages/mcp-server/src/codeql-tools.ts`)
- **Responsibility**: Query FLOWS_TO edges from a given file:line, in either direction
- **Upstream (receives from)**: MCP tool call from Claude Code
- **Downstream (sends to)**: JSON response to Claude Code
- **External dependencies**: Neo4j session
- **Hands test**: PASS — standard Cypher query, follows existing tool patterns

### 9. `get_data_flow_findings` MCP Tool (`packages/mcp-server/src/codeql-tools.ts`)
- **Responsibility**: List all CodeQL findings for a repo, with severity/query/file filters
- **Upstream (receives from)**: MCP tool call from Claude Code
- **Downstream (sends to)**: JSON response to Claude Code
- **External dependencies**: Neo4j session
- **Hands test**: PASS

### 10. Existing Tool Enrichment (`trace_error`, `get_symbol`, `get_dependencies`)
- **Responsibility**: Add data flow context to existing MCP tool responses
- **Upstream (receives from)**: Existing tool queries + additional FLOWS_TO edge lookups
- **Downstream (sends to)**: Enriched JSON responses
- **External dependencies**: CodeQL findings must exist in Neo4j
- **Hands test**: PASS if CodeQL has run; gracefully absent if not

## Rough Dependency Map

```
config.ts (codeql section)
    ↓
digest.ts (async launch after Load)
    ↓
codeql/index.ts (orchestrator)
    ├── codeql/runner.ts → [CodeQL CLI] → SARIF file
    ├── codeql/sarif-parser.ts → parsed findings
    ├── codeql/node-matcher.ts → matched findings (needs Neo4j + allSymbols)
    └── codeql/loader.ts → FLOWS_TO edges + DataFlowFinding nodes → Neo4j
                                                                      ↓
                                                        MCP tools query Neo4j
                                                        ├── trace_data_flow
                                                        ├── get_data_flow_findings
                                                        └── enriched trace_error/get_symbol
```

## Open Questions

1. **Async completion tracking.** How does the CodeQL stage report back to `digest_jobs`? Options:
   - (a) Separate `codeql_status` column in `digest_jobs`
   - (b) Re-read and merge stats into existing `stats` JSON column
   - (c) Separate `codeql_jobs` table

2. **Custom query config storage.** The PRD says per-repo `codeql_queries` in the `repositories` table. Does this need a Supabase migration? Current `repositories` table doesn't have this column.

3. **CodeQL CLI availability in Railway deployment.** The backend deploys on Railway. Is CodeQL CLI available in the nixpacks build? If not, this feature works in local dev but silently skips in production — a classic "no hands in prod" scenario.

4. **Node matcher accuracy.** CodeQL reports line numbers. The parser stores `startLine`/`endLine` on Function nodes. What happens when CodeQL reports a line inside an anonymous arrow function that the parser didn't extract as a separate node?

5. **Cache invalidation.** SCIP caches by `repoUrl:adapter` → commitSha. CodeQL should cache by `repoUrl` → commitSha. But if custom queries change, the cache is stale even with the same commit. Hash the query config too?

## Risks and Concerns

1. **Railway deployment.** CodeQL CLI is ~500MB+. Adding it to the Docker image significantly increases build time and image size. May need a separate "analysis worker" service.

2. **Memory pressure.** CodeQL needs 8GB+ for medium repos. Railway containers may not have this. Could cause OOM kills.

3. **Race condition on stats update.** If CodeQL finishes after the user triggers another digest, the stats update could conflict. Need to scope CodeQL stats writes to the specific job ID and handle the case where the job has been superseded.

4. **False positive noise.** CodeQL's default query suite may produce many low-severity findings on typical web apps. Need to validate signal-to-noise before exposing to users.

5. **The "async gap."** Between digest completion and CodeQL completion, MCP tools that check for FLOWS_TO edges will return empty. Users may query immediately after digest and conclude there are no data flow issues. Need a `codeql_status: running | complete | failed | skipped` indicator in tool responses.
