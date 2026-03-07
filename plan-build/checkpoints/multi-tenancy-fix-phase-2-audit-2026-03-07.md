# Phase 2 Dependency Audit
**Phase:** MCP Server Tenant Isolation
**Date:** 2026-03-07
**Status:** CONDITIONAL PASS

## Verified Connections

| Item | Status | Verification |
|------|--------|-------------|
| 2.1 REPOGRAPH_USER_TOKEN + SUPABASE_ANON_KEY env vars | PASS | Read at index.ts:52-53, used in getUserSupabase() |
| 2.2 getUserSupabase() function | PASS | index.ts:54-69 — user-scoped client with anon key + Bearer token, lazy singleton, falls back to service key with warning |
| 2.3 Replace getSupabase() in tool handlers | PASS | search_code, get_file, get_symbol source fetch, getScopedRepoId all use getUserSupabase() |
| 2.4 resolveRepoId uses user-scoped client | PASS | repo-resolver.ts accepts SupabaseClient param, all callers pass user-scoped client via DI |
| 2.5 Neo4j guard verification | PASS (with caveat) | Neo4j-only tools have no Supabase ownership check — acknowledged gap documented in plan as HIGH-1 |
| 2.6 Startup warning | PASS | Lines 1154-1158 emit warning when no user token set |

## DI Injection Verified
- registerRuntimeTools (line 1128): receives getUserSupabase — all 5 runtime tools use user-scoped client
- registerTemporalTools (line 1131): receives getUserSupabase — get_complexity_trend uses user-scoped client
- Startup connectivity check (line 1146): correctly still uses getSupabase() (service key)

## Issues Found

### ISSUE 1 (Medium): get_complexity_trend inlines repo lookup
- **Location:** temporal-tools.ts:229-237
- **Detail:** Inlines its own repo query instead of using resolveRepoId(). Works correctly (RLS applies via DI), but maintenance hazard.
- **Action:** Non-blocking. Can be refactored later.

### ISSUE 2 (Low): DI parameter naming
- **Location:** runtime-tools.ts:58, temporal-tools.ts:20
- **Detail:** DI parameter named getSupabase but injected function is getUserSupabase. Misleading when reading in isolation.
- **Action:** Non-blocking. Cosmetic.

### ISSUE 3 (Info/Expected): Neo4j tools lack Supabase ownership pre-check
- **Location:** 10+ tools including get_repo_structure, get_symbol, get_dependencies, trace_imports, query_graph
- **Detail:** Query Neo4j directly by repo name/URL without verifying ownership via Supabase. query_graph highest risk (accepts arbitrary Cypher).
- **Action:** Acknowledged gap (plan HIGH-1). To be documented in Phase 3.

## Summary
Phase 2 correctly implemented. All Supabase queries in MCP tool handlers now use user-scoped client when REPOGRAPH_USER_TOKEN is set. DI injection cleanly propagates to runtime and temporal tools. No blocking issues.
