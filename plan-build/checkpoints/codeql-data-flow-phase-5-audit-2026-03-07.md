# Phase 5 Dependency Audit
**Phase:** 5 — MCP Tools (trace_data_flow + get_data_flow_findings)
**Date:** 2026-03-07
**Status:** PASS

## Verified Connections

- [x] **Import chain** — `index.ts:12` imports `registerCodeQLTools` from `./codeql-tools.js` → function exported at `codeql-tools.ts:65`. (source: local file read)

- [x] **Registration call** — `index.ts:1217` calls `registerCodeQLTools(server, getSession, getUserSupabase, SCOPED_REPO)` → matches signature `(server: McpServer, getSession: GetSessionFn, getSupabase: GetSupabaseFn, scopedRepo: string | null)`. Uses `getUserSupabase` (per-user client), matching the pattern of `registerCallChainTools`. (source: local file read)

- [x] **FLOWS_TO edge properties match loader** — `trace_data_flow` queries `r.query_id`, `r.sink_kind`, `r.severity`, `r.message`, `r.path_steps`, `r.path_complete`. Loader writes exactly these properties at `loader.ts:126-131`. (source: local file read)

- [x] **DataFlowFinding node properties match loader** — `get_data_flow_findings` queries `f.query_id`, `f.severity`, `f.message`, `f.source_path`, `f.sink_path`, `f.path_complete`, `f.job_id`. Loader writes these at `loader.ts:51-60`. (source: local file read)

- [x] **Repo URL resolution** — Both tools resolve repo name/URL via `MATCH (r:Repository) WHERE r.name = $repo OR r.url = $repo`, consistent with all other MCP tools. (source: local file read)

- [x] **Session lifecycle** — Both tools create session via `getSession()`, close in `finally` block. Matches call-chain-tools pattern. (source: local file read)

- [x] **CodeQL status header** — Both tools show CodeQL run status when no results found, querying `digest_jobs.stats.codeql` via Supabase. Addresses Plan Issue 4. (source: local file read)

- [x] **TypeScript compiles clean** — `npx tsc --noEmit` passes with no errors. (source: CLI)

## Stubs & Placeholders Found

None.

## Broken Chains

None.

## Missing Configuration

None — tools use existing Neo4j and Supabase connections.

## Summary

Phase 5 is clean. Both MCP tools correctly query the Neo4j schema written by the loader. Property names match exactly. Registration follows the established pattern. CodeQL status context addresses Plan Issue 4 (users can tell if CodeQL hasn't run vs. no findings).
