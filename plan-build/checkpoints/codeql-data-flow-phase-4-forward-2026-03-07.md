# Phase 4 Forward Plan Review
**Phase completed:** 4 — Digest Wiring + Split Orchestrator
**Date:** 2026-03-07
**Plan updates needed:** YES (minor)

## Actual Interfaces Built

### Exports from `codeql/index.ts`

```typescript
// Interface
export interface CodeQLDatabaseResult {
  databases: { dbPath: string; langConfig: CodeQLLanguageConfig }[];
  hasWork: boolean;
  skipped: boolean;
  skipReason?: string;
}

// Sync phase — called in digest pipeline
export async function createCodeQLDatabasesIfEnabled(
  repoPath: string,
  jobId: string,
  detectedLanguages: string[]
): Promise<CodeQLDatabaseResult>

// Async phase — fired after digest returns
export async function runCodeQLAnalysisStage(
  dbResult: CodeQLDatabaseResult,
  repoUrl: string,
  jobId: string,
  commitSha: string
): Promise<CodeQLStageResult>

// Convenience wrapper (testing)
export async function runCodeQLStage(
  input: CodeQLStageInput
): Promise<CodeQLStageResult>
```

### Neo4j Schema Written by Loader

**DataFlowFinding nodes** (loader.ts:50-62):
- `repo_url`, `job_id`, `query_id`, `severity`, `message`, `source_path`, `sink_path`, `path_complete`

**FLOWS_TO edges** (loader.ts:122-133):
- `query_id` (MERGE key), `sink_kind`, `severity`, `message`, `path_steps` (JSON string), `path_complete`

### Stats Shape Written to Supabase

```json
{ "codeql": {
    "status": "success|partial|failed|skipped|timeout",
    "durationMs": number,
    "findingCount": number,
    "flowEdgeCount": number,
    "unmatchedLocations": number,
    "queriesRun": string[],
    "reason?": string,
    "error?": string
  }
}
```

## Mismatches with Plan

### 1. Plan Contract 2 references `runCodeQLStage()`
- **Plan says:** "digest.ts calls `runCodeQLStage()` without awaiting"
- **Code actually:** digest.ts calls `createCodeQLDatabasesIfEnabled()` + `runCodeQLAnalysisStage()` (split pattern)
- **Downstream impact:** None — the split was a deliberate improvement (Issue 6 fix). `runCodeQLStage()` still exists as a convenience wrapper.
- **Plan update:** Update Contract 2 to reference the split functions.

### 2. Plan Contract 9 references `registerCodeQLTools(server, getSession, getSupabase, scopedRepo)`
- **Plan says:** `codeql-tools.ts exports registerCodeQLTools(server, getSession, getSupabase, scopedRepo)`
- **Code actually:** Existing pattern in `index.ts` uses `registerCallChainTools(server, getSession, getUserSupabase, SCOPED_REPO)` — note `getUserSupabase` (a function), not `getSupabase`.
- **Downstream impact:** Phase 5 must use `getUserSupabase` (returns per-user Supabase client), not `getSupabase` (returns service-role client).
- **Plan update:** Change Contract 9 to `registerCodeQLTools(server, getSession, getUserSupabase, scopedRepo)`.

### 3. DataFlowFinding node missing `digest_id` field
- **Plan says:** DataFlowFinding nodes include `digest_id`
- **Code actually:** Uses `job_id` instead (loader.ts:53)
- **Downstream impact:** Phase 5 MCP queries should filter by `job_id`, not `digest_id`. For status checking, query `digest_jobs` table by `job_id`.
- **Plan update:** Update Contract 8 to use `job_id` instead of `digest_id`.

## Hook Points for Next Phase

### Phase 5: MCP Tools

**1. Tool registration point** — `packages/mcp-server/src/index.ts:1213`
```typescript
// After this line:
registerCallChainTools(server, getSession, getUserSupabase, SCOPED_REPO);
// Add:
registerCodeQLTools(server, getSession, getUserSupabase, SCOPED_REPO);
```

**2. Neo4j queries for `trace_data_flow`** — Target FLOWS_TO edges:
```cypher
-- From source: find what a function flows data to
MATCH (f:Function {repo_url: $repo, file_path: $file})
WHERE f.start_line <= $line AND f.end_line >= $line
MATCH (f)-[r:FLOWS_TO]->(sink)
RETURN sink.name, sink.file_path, r.query_id, r.sink_kind, r.severity, r.message, r.path_steps

-- To sink: find what flows data into a function
MATCH (f:Function {repo_url: $repo, file_path: $file})
WHERE f.start_line <= $line AND f.end_line >= $line
MATCH (source)-[r:FLOWS_TO]->(f)
RETURN source.name, source.file_path, r.query_id, r.sink_kind, r.severity, r.message, r.path_steps
```

**3. Neo4j queries for `get_data_flow_findings`** — Target DataFlowFinding nodes:
```cypher
MATCH (f:DataFlowFinding {repo_url: $repo})
WHERE ($severity IS NULL OR f.severity = $severity)
  AND ($queryId IS NULL OR f.query_id = $queryId)
  AND ($file IS NULL OR f.source_path STARTS WITH $file OR f.sink_path STARTS WITH $file)
RETURN f.query_id, f.severity, f.message, f.source_path, f.sink_path, f.path_complete
ORDER BY f.severity DESC
LIMIT $maxResults
```

**4. CodeQL status for response header** — Query from Supabase:
```typescript
const { data: job } = await supabase
  .from("digest_jobs")
  .select("stats")
  .eq("repo_url", repo)
  .order("created_at", { ascending: false })
  .limit(1)
  .single();
const codeqlStatus = (job?.stats as any)?.codeql?.status ?? "not_run";
```

**5. Existing function signatures to follow:**
- `registerCallChainTools` at `packages/mcp-server/src/call-chain-tools.ts` — follow this exact pattern for `registerCodeQLTools`
- Uses `server.tool(name, schema, handler)` pattern

### Phase 6: Existing Tool Enrichment

**1. `get_symbol` enrichment** — Add an OPTIONAL MATCH for FLOWS_TO edges on the matched symbol:
```cypher
OPTIONAL MATCH (sym)-[ft:FLOWS_TO]->(sink)
OPTIONAL MATCH (source)-[ft2:FLOWS_TO]->(sym)
```
Then add `data_flow_findings_count: (ft_count + ft2_count)` to the output.

**2. `trace_error` enrichment** — When tracing an error to a function, also check if that function is a FLOWS_TO source/sink to provide data flow context.

## Recommended Plan Updates

1. **Contract 2:** Replace `runCodeQLStage()` reference with the split pattern: `createCodeQLDatabasesIfEnabled()` (sync) + `runCodeQLAnalysisStage()` (async fire-and-forget).

2. **Contract 9:** Change `getSupabase` to `getUserSupabase` to match the existing tool registration pattern.

3. **Contract 8:** Replace `digest_id` with `job_id` in DataFlowFinding queries.

4. **Wiring Checklist — MCP Tools:** Add note that `registerCodeQLTools` should be placed after `registerCallChainTools` at line 1213 of `index.ts`.
