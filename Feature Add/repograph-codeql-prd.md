# RepoGraph — Feature Add-On PRD: Data Flow via CodeQL Integration

**Add-On To:** RepoGraph v1.0 PRD  
**Version:** 1.0  
**Date:** March 6, 2026  
**Status:** Draft  
**Phase:** 5 Extension (parallel to Runtime Context Layer)  
**Depends On:** Name Resolution PRD (Phase 2 Extension), Type Flow via SCIP PRD (Phase 3 Extension)

---

## 1. Overview

Data flow via CodeQL integration enriches the RepoGraph knowledge graph with path-level analysis — tracing how values travel through the codebase from their origin to where they are used. Where type flow tells Claude Code what a value is at any given point, data flow tells Claude Code where that value came from and where it can go.

CodeQL is GitHub's static analysis engine, open-sourced and available as a CLI. It has spent years solving the hard problem of inter-procedural data flow analysis — tracking values across function calls, module boundaries, and control flow branches. Rather than building this from scratch, RepoGraph runs the CodeQL CLI against the cloned repo at digest time, ingests the results as structured graph data, and stores them as enriched edges alongside the existing code graph.

The primary use case is answering the class of question that neither structural graph traversal nor type flow can answer: "could untrusted user input reach this database query?" or "what is every possible path a value from this API endpoint can take through the codebase?" These are security and correctness questions that require following values across file and function boundaries — which is precisely what CodeQL was built to do.

---

## 2. Problem Statement

After name resolution and type flow enrichment, the RepoGraph graph knows the structure of the codebase and the types of values at each node. What it does not know is how values flow between nodes — which sources feed which sinks, and which paths connect them.

Three gaps remain that CodeQL closes:

**Taint tracking is invisible.** If user input enters through an HTTP request handler and eventually reaches a database query without being sanitized, that path is invisible in the structural graph. The graph shows that the handler calls some functions and those functions call the database layer. It does not show whether the specific value from the request makes it to the query. CodeQL's taint analysis tracks this explicitly.

**Cross-function data paths are opaque.** A value that passes through five function calls across three files leaves no trace in the current graph beyond the `CALLS` edges. The graph knows A calls B calls C — it does not know that the specific value causing a production error was born in A and arrived in C unchanged and unvalidated.

**Security vulnerabilities require data flow to find.** SQL injection, XSS, path traversal, insecure deserialization — every major class of web application vulnerability is fundamentally a data flow problem. A value from an untrusted source reaches a sensitive sink without passing through a validator. The structural graph and type system cannot express this class of problem. CodeQL can find it at analysis time.

---

## 3. Goals & Non-Goals

### 3.1 Goals

1. Run the CodeQL CLI against the cloned repo at digest time and ingest query results as graph data.
2. Store data flow paths as `FLOWS_TO` edges between source nodes and sink nodes in Neo4j.
3. Execute a default suite of CodeQL queries covering common vulnerability classes for JavaScript and TypeScript.
4. Allow custom CodeQL queries to be configured per-repo, with results ingested as custom edge annotations.
5. Expose data flow paths through two new MCP tools and enrich existing tools with flow-aware context.
6. Run as an async post-Load stage — CodeQL analysis never blocks structural graph availability.
7. Fail open — if CodeQL is not installed or analysis fails, the digest completes with the full structural and type-enriched graph intact.

### 3.2 Non-Goals

- Building a custom data flow engine. CodeQL is the engine; RepoGraph is the consumer.
- Executing CodeQL queries at MCP query time. All analysis runs at digest time and results are stored.
- Supporting all CodeQL query packs. The default suite covers JavaScript/TypeScript security queries.
- Fixing or remediating vulnerabilities. RepoGraph surfaces findings to Claude Code; acting on them is the developer's responsibility.
- Real-time taint tracking. CodeQL runs once per digest.

---

## 4. How CodeQL Fits the Existing Pipeline

The enriched pipeline after type flow is:

```
Clone → Scan → Parse → Type-check → Resolve → Deps → Load
```

CodeQL runs as an async post-Load stage:

```
Clone → Scan → Parse → Type-check → Resolve → Deps → Load → CodeQL Analysis (async)
```

CodeQL runs after Load because it requires its own internal database format built separately from the Neo4j graph. Running it async means the full structural and type-enriched graph is queryable immediately while CodeQL analysis runs in the background.

### 4.1 CodeQL Database Creation

CodeQL requires its own database representation of the codebase, built using the CLI:

```bash
codeql database create /tmp/repograph-jobs/{job_id}/codeql-db \
  --language=javascript \
  --source-root /path/to/cloned/repo \
  --overwrite
```

The CodeQL database is a temporary artifact scoped to the current digest job and deleted after analysis completes.

---

## 5. Technical Specification

### 5.1 Default Query Suite

RepoGraph ships with a default set of CodeQL queries drawn from the official `codeql/javascript-queries` pack:

| Query | What it finds |
|---|---|
| `js/sql-injection` | User input reaching SQL query strings without sanitization |
| `js/xss` | User input reaching HTML output without encoding |
| `js/path-injection` | User input reaching file system path operations |
| `js/code-injection` | User input reaching `eval` or `Function` constructor |
| `js/command-injection` | User input reaching shell command execution |
| `js/unvalidated-dynamic-method-call` | User input controlling method dispatch |
| `js/missing-rate-limiting` | External endpoints without rate limiting |
| `js/prototype-pollution` | Object property assignment from untrusted input |

Each query produces source/sink pairs with the data flow path connecting them. RepoGraph stores each result as a `FLOWS_TO` edge in Neo4j.

### 5.2 Query Execution

Queries are executed against the CodeQL database using the CLI:

```bash
codeql database analyze /tmp/repograph-jobs/{job_id}/codeql-db \
  --format=sarif-latest \
  --output=/tmp/repograph-jobs/{job_id}/results.sarif \
  codeql/javascript-security-queries
```

Results are emitted in SARIF format (Static Analysis Results Interchange Format), a standard JSON schema for static analysis output. RepoGraph parses the SARIF output and maps each result to Neo4j nodes using file path and line number matching.

### 5.3 SARIF Ingestion

The ingestion loop processes results in two passes:

**Pass 1 — Source and sink node matching.**
For each CodeQL result, extract the source and sink locations (file path, line number). Query Neo4j for the Function node whose range contains each location. If a matching node is found, record the node ID. If not found, log as `unmatched_codeql_location` and skip.

**Pass 2 — Flow path construction.**
Each result contains the intermediate steps of the data flow path. For each step, attempt to match to an existing graph node. Construct a `FLOWS_TO` edge from source to sink with the intermediate path stored as a property.

### 5.4 Updated Graph Schema

**New relationship type:**

| Relationship | From | To | Properties |
|---|---|---|---|
| `FLOWS_TO` | Function \| Parameter | Function \| Parameter | `query_id`, `path_steps` (object[]), `sink_kind` (sql\|xss\|path\|etc), `severity` (error\|warning\|note), `message` (string), `path_complete` (bool) |

**New node label:**

| Label | Description | Key Properties |
|---|---|---|
| `DataFlowFinding` | A CodeQL analysis result | `query_id`, `severity`, `message`, `source_path`, `sink_path`, `repo_id`, `digest_id` |

`DataFlowFinding` nodes are connected to source and sink Function nodes via `FLOWS_TO` edges. They serve as a finding record independent of graph structure — useful for querying all findings by severity or type without traversing the full graph.

### 5.5 New MCP Tool: `trace_data_flow`

| Parameter | Type | Description |
|---|---|---|
| `file` | string | File path of the source or sink to trace from |
| `line` | int | Line number within the file |
| `direction` | enum | `from_source` or `to_sink` |
| `repo` | string | Repository identifier |
| `query_id` | string | Optional — filter to a specific CodeQL query |

Returns all data flow paths originating from or terminating at the specified location, with intermediate steps, sink kinds, and severity.

### 5.6 New MCP Tool: `get_data_flow_findings`

| Parameter | Type | Description |
|---|---|---|
| `repo` | string | Repository identifier |
| `severity` | enum | `error`, `warning`, `note`, or `all` |
| `query_id` | string | Optional filter |
| `file` | string | Optional — filter to a specific file |
| `max_results` | int | Default 20 |

Returns all CodeQL findings for the repo, optionally filtered. Primary tool for "are there security issues in this codebase?" queries.

### 5.7 Impact on Existing MCP Tools

**`trace_error`** — gains data flow context. When a production error occurs at a sink, `trace_error` can check whether a `FLOWS_TO` edge connects the error site to a known source. If it does, Claude can report not just where the error occurred but where the problematic value originated.

**`get_symbol`** — response includes a `data_flow_findings_count` if the function is involved in any CodeQL findings as a source or sink.

**`get_dependencies`** — `FLOWS_TO` edges are returned alongside `CALLS` edges when `direction: both` is specified, giving a combined structural and data-flow view of a function's connections.

### 5.8 Custom Query Support

Per-repo custom CodeQL queries are supported via a `codeql_queries` config field in the `repositories` table. The field accepts an array of query file paths relative to the repo root, or references to published CodeQL query packs. Custom query results are ingested identically to default suite results.

### 5.9 Incremental Re-Digest Behaviour

CodeQL must rerun whenever any source file changes. Like SCIP, there is no partial re-analysis path.

- Cache results by commit SHA — if HEAD has not changed, reuse the previous SARIF output.
- Skip CodeQL if only non-source files changed.
- Always run asynchronously — CodeQL analysis on a medium repo takes 2–10 minutes.
- Clear all previous `FLOWS_TO` edges and `DataFlowFinding` nodes before writing new results on each successful run.

### 5.10 Error Handling

| Failure | Handling |
|---|---|
| CodeQL CLI not installed | Log warning, skip stage, surface setup prompt in UI |
| `codeql database create` fails | Log stderr, mark stage `failed`, continue |
| `codeql database analyze` fails | Log stderr, mark stage `failed`, continue |
| SARIF parse error | Log error, skip ingestion, continue |
| Source/sink location has no matching Neo4j node | Log `unmatched_codeql_location`, skip finding, continue |
| Analysis exceeds timeout (default: 15 minutes) | Kill process, log timeout, mark stage `timed_out`, continue |

---

## 6. Infrastructure Requirements

**CodeQL CLI** must be installed and available on PATH:

```bash
gh extensions install github/gh-codeql
```

The Docker Compose setup should include CodeQL CLI installation in the app server Dockerfile. The web UI should surface a warning if CodeQL is not detected during startup health check.

**Disk space:** approximately 2–5x the size of source files for the CodeQL database. Deleted immediately after analysis.

**Memory:** minimum 8GB available RAM recommended for medium repos.

---

## 7. Implementation Plan

### 7.1 Subtasks

| Subtask | Implementation | Validation |
|---|---|---|
| CodeQL subprocess runner (database create + analyze) | 2 hours | 1 hour |
| SARIF parser and result extractor | 2 hours | 1 hour |
| Source/sink node matcher | 2 hours | 2 hours |
| `FLOWS_TO` edge writer | 2 hours | 1 hour |
| `DataFlowFinding` node writer | 1 hour | 30 minutes |
| `trace_data_flow` MCP tool | 2 hours | 1 hour |
| `get_data_flow_findings` MCP tool | 1 hour | 30 minutes |
| Custom query config support | 2 hours | 1 hour |
| Dockerfile update | 30 minutes | 30 minutes |
| **Total** | **~14.5 hours** | **~8.5 hours** |

Approximately **3 focused days** end-to-end. The source/sink node matcher is the highest-risk subtask — matching CodeQL's SARIF locations to existing Neo4j nodes requires robust file path and line number correlation.

---

## 8. Testing Strategy

### 8.1 Unit Tests

- **SARIF parser:** valid SARIF output, empty results, malformed SARIF, results with no intermediate steps.
- **Node matcher:** exact line match, line within function range, unmatched location, location in a generated file.
- **`FLOWS_TO` writer:** single-step path, multi-step path, duplicate finding, finding with no intermediate nodes.
- **`trace_data_flow`:** source direction, sink direction, filtered by query ID, location with no findings.

### 8.2 Integration Test Repos

**Fixture J — SQL injection repo.** A synthetic Express.js API that constructs SQL queries directly from request parameters. Validates that `js/sql-injection` findings produce correct `FLOWS_TO` edges from the request handler parameter to the database query call.

**Fixture K — clean repo.** A synthetic repo with no known vulnerabilities. Validates that `get_data_flow_findings` returns zero results.

**Fixture L — custom query repo.** A synthetic repo with a custom CodeQL query in the repo configuration. Validates that custom query results are ingested alongside default suite results.

### 8.3 Acceptance Criteria

- The SQL injection finding in Fixture J produces a `FLOWS_TO` edge from the request handler parameter to the database query function.
- `get_data_flow_findings` returns zero results for Fixture K.
- Custom query results in Fixture L appear in the graph with the correct `query_id`.
- `trace_data_flow` on the SQL injection sink in Fixture J returns the correct source location and intermediate path steps.
- CodeQL analysis completes within 15 minutes on a repo of 5,000 TypeScript files.
- Zero digests fail due to CodeQL errors — structural graph remains intact.
- `trace_error` responses include data flow context when a production error occurs at a CodeQL-identified sink.

---

## 9. Performance Considerations

CodeQL is the most time-consuming stage in the pipeline and must always run asynchronously.

- **Always async.** Unlike SCIP and the Compiler API which have configurable thresholds, CodeQL should always run asynchronously. Never block structural graph availability on CodeQL completion.
- **Database cleanup.** Delete the CodeQL database immediately after SARIF ingestion.
- **Query suite scope.** Each additional query adds analysis time. Trim the default suite to queries relevant to your application's architecture.
- **Timeout.** The 15-minute hard timeout catches runaway analysis. Log and surface the event rather than leaving the stage in a perpetually running state.
- **Disk monitoring.** Monitor temp directory size during database creation. Abort and log if it exceeds the configured limit (default: 2GB). Generated files and `node_modules` should be excluded via CodeQL configuration.

---

## 10. Success Criteria

1. The default CodeQL query suite runs successfully on the target codebase and produces structured findings in `digest_jobs.stats`.
2. Known data flow paths in the target codebase are correctly represented as `FLOWS_TO` edges in Neo4j.
3. `trace_data_flow` returns accurate source-to-sink paths for findings in the target codebase.
4. `trace_error` includes data flow context for production errors at CodeQL-identified sinks.
5. All CodeQL failures are surfaced in `digest_jobs.stats` and the structural graph remains intact.
6. Custom query results are correctly ingested and queryable via `get_data_flow_findings`.
7. The async flow works correctly — structural data queryable immediately, findings available when analysis completes.

---

## 11. Decision Map

### 11.1 Before CodeQL Runs

**Is the CodeQL CLI installed?**
Yes → proceed. No → log warning, surface setup instructions in UI, skip stage. Do not fail the digest.

**Has the repo changed since the last digest?**
Check HEAD commit SHA. Unchanged → reuse cached SARIF results, skip database creation and analysis. Changed → run in full.

**Are the only changed files non-source?**
If the Scan diff shows only non-TypeScript and non-JavaScript changes, skip CodeQL and reuse cached findings.

**Is there sufficient disk space?**
Estimate 3x source file size. If the estimate exceeds the configured limit (default: 2GB), log a warning and skip. Surface the issue in the UI with the estimated space required.

### 11.2 During Database Creation

**Does `codeql database create` fail?**
Log the full stderr output to `digest_jobs.stats`. Mark the CodeQL stage `failed`. Continue — the structural graph is not affected.

**Are generated files inflating the database?**
Monitor database directory size during creation. If it exceeds the disk limit, abort and log. Pass CodeQL configuration to exclude known generated directories (build output, `node_modules`, `.d.ts` files from external packages).

### 11.3 Query Execution Decisions

**Which queries run by default?**
The 8 queries listed in section 5.1. Do not run the full CodeQL security query pack by default — it contains hundreds of queries and would make analysis prohibitively slow. Trim to queries relevant to the target architecture.

**Should warnings be stored alongside errors?**
Store all three severity levels but default MCP tool responses to errors only. Expose a `severity` filter parameter so Claude Code can request warnings when needed.

**Does analysis exceed the timeout?**
Kill the subprocess, log the timeout with elapsed time, mark stage `timed_out`. Do not retry automatically — repeated timeouts indicate a configuration issue that needs developer attention.

### 11.4 SARIF Ingestion Decisions

**Does a finding location match a Function node?**
Match by exact file path and line number within the function's `start_line` to `end_line` range. Found → attach the finding. Not found by range → try matching the closest Function node in the same file. No Function node in the file → log `unmatched_codeql_location`, skip. Do not create orphaned `FLOWS_TO` edges.

**Do intermediate path steps match graph nodes?**
Use the same matching logic. Unmatched steps are skipped — the `FLOWS_TO` edge is still created between matched source and sink, but `path_steps` will have gaps. Flag with `path_complete: false`.

**Are there duplicate findings?**
Deduplicate by `query_id + source_location + sink_location`. If the same source/sink pair appears from multiple queries, merge findings and include all matching `query_id` values rather than creating duplicate edges.

### 11.5 Data Flow Edge Decisions

**Are `FLOWS_TO` edges directional?**
Yes, strictly directional from source to sink. `trace_data_flow` with `direction: from_source` traverses forward; `direction: to_sink` traverses backward.

**What if source and sink are in the same function?**
Valid — create the `FLOWS_TO` edge as normal with `source_node_id` and `sink_node_id` pointing to the same Function node, differentiated by path step line numbers.

**Should stale findings be deleted before writing new ones?**
Yes. On every successful CodeQL run, delete all existing `FLOWS_TO` edges and `DataFlowFinding` nodes for the repo before writing new results. Stale findings from resolved issues should not persist.

### 11.6 MCP Tool Response Decisions

**How many path steps should `trace_data_flow` return?**
Return all steps up to a configurable maximum (default: 20 steps). Paths longer than 20 steps are truncated with a `path_truncated: true` flag.

**Should `get_data_flow_findings` return full path steps by default?**
No — return source, sink, severity, and message by default. Full path steps are available via `include_path: true`. The path data is verbose and unnecessary for most findings overview queries.

### 11.7 Custom Query Decisions

**Where are custom queries stored?**
Accept either a path to a `.ql` file within the repo (for team-specific queries committed to the codebase) or a reference to a published CodeQL query pack. Validate that files exist during digest config parsing, before CodeQL runs.

**Should custom query failures block the default suite?**
No. Run default and custom queries in separate analysis invocations. Custom query failures are logged and continue. Default suite findings are never blocked by custom query problems.

### 11.8 Decisions Requiring Product Judgment

**Default query suite scope.** The 8 queries listed in section 5.1 are a reasonable starting point for a web application security focus. Review them against the target codebase before shipping — if the codebase has no shell execution paths, `js/command-injection` will never fire and adds analysis time for no benefit. Trim to queries that match your application's architecture.

**Severity filtering in MCP responses.** The recommendation to default to errors-only is conservative. On a codebase with strict input validation, there may be very few errors and the warnings may be the most actionable findings. Validate signal-to-noise ratio at each severity level against the target codebase before choosing a default.

**Timeout limit.** 15 minutes is a generous default. If CodeQL is consistently completing in 3–4 minutes, lower the timeout to catch runaway analysis earlier. If the target codebase exceeds 15 minutes, raise the limit or reduce the query suite.

**Stale findings retention.** Deleting all previous findings on each successful run is correct for accuracy but means that if CodeQL fails on a digest, the UI shows no findings rather than the previous run's findings. Retaining previous findings with a `stale: true` flag is a reasonable alternative — it keeps context available while making staleness explicit. Choose based on whether "no findings shown" is more confusing than "potentially stale findings shown."

**Custom query authorization.** Allowing custom queries committed to the repo means any developer can add analysis that runs on every digest. Decide whether custom queries should require explicit opt-in from the repo owner in the RepoGraph UI, or whether presence in the repo config is sufficient authorization.
