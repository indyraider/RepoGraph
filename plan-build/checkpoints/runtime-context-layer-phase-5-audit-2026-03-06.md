# Phase 5 Dependency Audit
**Phase:** MCP Runtime Tools
**Date:** 2026-03-06
**Status:** ISSUES FOUND

## Verified Connections

### repo-resolver.ts

- [x] **resolveRepoId(sb, repoNameOrUrl) helper exists and has real logic** -- Takes a `SupabaseClient` and a string, queries `repositories` table with `.or()` on `name` and `url` columns, returns `data?.id ?? null`. Both `name` (TEXT NOT NULL) and `url` (TEXT NOT NULL UNIQUE) columns confirmed in `supabase-migration.sql` lines 7-8. The `id` column (UUID PK) confirmed at line 6. Returns `Promise<string | null>` as expected.

- [x] **Import of SupabaseClient type** -- `@supabase/supabase-js` is in package.json dependencies (`^2.98.0`). Import is correct.

### runtime-tools.ts — registerRuntimeTools

- [x] **Function signature matches caller** -- `registerRuntimeTools(server: McpServer, getSession: GetSessionFn, getSupabase: GetSupabaseFn): void`. In index.ts line 632: `registerRuntimeTools(server, getSession, getSupabase)` -- `server` is `McpServer`, `getSession` returns `Session`, `getSupabase` returns `SupabaseClient`. Types match.

- [x] **Import of resolveRepoId** -- `import { resolveRepoId } from "./repo-resolver.js"` -- file exists at `src/repo-resolver.ts`, .js extension is correct for ESM TypeScript.

- [x] **All 5 imports are valid** -- `McpServer` from SDK (installed), `z` from zod (installed), `Session` from neo4j-driver (installed), `SupabaseClient` from supabase-js (installed), `resolveRepoId` from local module.

### Tool 1: get_recent_logs

- [x] **resolveRepoId called correctly** -- `resolveRepoId(sb, repo)` where `sb = getSupabase()` (SupabaseClient) and `repo` is the string param. Matches function signature.
- [x] **Null handling** -- Returns `Repository not found: ${repo}` error in MCP format when repoId is null.
- [x] **Supabase query correctness** -- Queries `runtime_logs` table with columns `id, timestamp, source, level, message, function_name, file_path, line_number`. All columns confirmed in `supabase-runtime-migration.sql` lines 44-57.
- [x] **Filters** -- `.eq("repo_id", repoId)`, `.gte("timestamp", since)`, optional `.eq("source", source)`, optional `.eq("level", level)`. All column names match schema.
- [x] **Response shape** -- `{ content: [{ type: "text", text: ... }] }` -- correct MCP format.
- [x] **Error propagation** -- Supabase error returned as text to user.

### Tool 2: search_logs

- [x] **resolveRepoId + null handling** -- Same pattern, correct.
- [x] **Full-text search** -- `.textSearch("message", searchQuery, { type: "websearch" })`. The `message` column exists (TEXT NOT NULL). GIN index `idx_runtime_logs_message_fts` exists on `to_tsvector('english', message)`. The Supabase `.textSearch()` with `type: "websearch"` should work with this index.
- [x] **Fallback on error** -- If textSearch fails, falls back to `.ilike("message", ...)`. Good defensive coding.
- [x] **formatLogEntries helper** -- Defined at bottom of file (lines 488-500). Accepts `Record<string, unknown>[]`, accesses `.timestamp`, `.source`, `.level`, `.message`, `.file_path`, `.line_number`. All valid columns.

### Tool 3: get_deploy_errors

- [x] **resolveRepoId + null handling** -- Correct.
- [x] **Deployment lookup** -- Queries `deployments` table for `deployment_id` column, filtered by `repo_id`, ordered by `started_at DESC`. All columns confirmed in migration lines 25-39.
- [x] **Error log query** -- Queries `runtime_logs` with `.eq("level", "error")` and `.in("deployment_id", deploymentIds)`. Correct columns.
- [x] **Deployment context enrichment** -- Second query fetches `deployment_id, source, status, branch, commit_sha, started_at` from `deployments`. All columns exist.
- [x] **Error propagation** -- Supabase errors returned to user.

### Tool 4: get_deployment_history

- [x] **resolveRepoId + null handling** -- Correct.
- [x] **Deployments query** -- `.select("*")` from `deployments`, ordered by `started_at DESC`. Correct.
- [x] **Error/warn count aggregation** -- Queries `runtime_logs` for `deployment_id, level` where level IN `["error", "warn"]`. Counts in-memory. Correct column names.
- [x] **Markdown table output** -- Uses deployment fields `started_at`, `source`, `status`, `branch`, `commit_sha`. All exist in schema.

### Tool 5: trace_error

- [x] **resolveRepoId + null handling** -- Correct.
- [x] **Input validation** -- Returns error if neither `log_id` nor `stack_trace` provided.
- [x] **Step 1: Log fetch** -- Queries `runtime_logs` by `id` with `.single()`. Uses `stack_trace` or `message` as fallback. Correct columns.
- [x] **Step 2: Stack parse** -- `parseStackTrace(rawStack)` is defined locally (lines 23-47). Handles Node.js and Python frames. Strips path prefixes. Filters node_modules and node: builtins. Returns `ParsedFrame[]`. Never throws (returns empty array on bad input).
- [x] **Step 3: Neo4j function lookup** -- Cypher: `MATCH (f:File {path: $filePath})-[:CONTAINS]->(fn:Function) WHERE fn.start_line <= $line AND fn.end_line >= $line`. Node labels `File` and `Function`, relationship `CONTAINS`, properties `path`, `start_line`, `end_line`, `name`, `signature`, `docstring` -- these match the existing code graph schema used by other tools in the same file (e.g., `get_symbol` in index.ts uses the same labels/relationships).
- [x] **Step 4: Callers** -- `MATCH (fn:Function {name: $fnName})<-[:CALLS]-(caller:Function)<-[:CONTAINS]-(f:File)`. Relationship `CALLS` and `CONTAINS` used. Same pattern as `get_symbol` tool. Correct.
- [x] **Step 5: Imports** -- `MATCH (f:File {path: $filePath})-[r:IMPORTS]->(target)`. Same pattern as `get_dependencies` tool in index.ts. Correct.
- [x] **Step 6: File source from Supabase** -- Queries `file_contents` table for `content, language` by `file_path`. The `file_contents` table (confirmed in `supabase-migration.sql`) has `content` (TEXT), `language` (TEXT), and `file_path` (TEXT). Correct.
- [x] **Neo4j session cleanup** -- Session created at line 399, closed in `finally` block at line 457. Correct -- session is always closed even if Neo4j queries throw.
- [x] **Graceful degradation** -- If no function found at file:line, outputs "No function found..." and continues. If no callers found, silently skips. If no imports found, silently skips. Partial results always returned.

### index.ts Registration

- [x] **Import** -- `import { registerRuntimeTools } from "./runtime-tools.js"` at line 9. File exists.
- [x] **Registration call** -- `registerRuntimeTools(server, getSession, getSupabase)` at line 632. Called after all existing tool registrations and before `main()`. Arguments match the function signature.
- [x] **Placement** -- Called at module level (not inside main()), which is fine since `server.tool()` is a synchronous registration that doesn't need DB connections to be established.

## Stubs & Placeholders Found

None. All 5 tool handlers contain complete logic. No TODO/FIXME comments. No `console.log("not implemented")`. No hardcoded return values where real data should flow. The `parseStackTrace` function is fully implemented with Node.js and Python frame support.

## Broken Chains

### ISSUE 1: trace_error Neo4j `$line` parameter type mismatch (MEDIUM)

**Location:** `runtime-tools.ts` line 407

The `lineNumber` parsed from stack frames is a JavaScript `number` (from `parseInt(nm[3], 10)` at line 33). It's passed to Neo4j as `{ filePath: topFrame.filePath, line: topFrame.lineNumber }`. The Cypher query does `fn.start_line <= $line AND fn.end_line >= $line`.

Neo4j integer comparison with JavaScript numbers *usually* works via the driver, but if `start_line` and `end_line` are stored as Neo4j `Integer` types (which is common), the comparison should still work because the driver auto-converts JS numbers to Neo4j integers for parameters. **This is likely fine but worth noting** -- if the graph was populated with `neo4j.int()` values, there could be a type coercion edge case on very large line numbers (> 2^53), which is unrealistic for source code.

**Verdict:** Low risk, no action needed.

### ISSUE 2: trace_error callers query scoped only by function name, not by file (MEDIUM)

**Location:** `runtime-tools.ts` lines 420-424

The callers query uses `MATCH (fn:Function {name: $fnName})<-[:CALLS]-(caller:Function)`. This matches ANY function with that name across ALL files in the graph. If multiple files define a function with the same name (e.g., `handler`, `index`, `get`), this will return callers of all of them.

The build plan's Cypher (Contract 8, query 2) has the same pattern, so this matches the spec -- but the spec itself has this ambiguity. The function lookup in Step 3 correctly scopes by file+line, but the callers query loses that scoping.

**Impact:** Could return false-positive callers for common function names. A more precise query would be:
```cypher
MATCH (f:File {path: $filePath})-[:CONTAINS]->(fn:Function)
WHERE fn.start_line <= $line AND fn.end_line >= $line
WITH fn
MATCH (fn)<-[:CALLS]-(caller:Function)<-[:CONTAINS]-(cf:File)
RETURN caller.name AS caller_name, cf.path AS caller_file, caller.start_line AS caller_line
```

**Verdict:** Functional but imprecise. Matches the build plan spec. Flag for future improvement.

### ISSUE 3: file_contents query not scoped by repo_id (LOW)

**Location:** `runtime-tools.ts` lines 461-466

The file source fetch queries `file_contents` by `file_path` alone, without filtering by `repo_id`. If multiple repositories have files with the same relative path (e.g., `src/index.ts`), this could return the wrong file's content. The `file_contents` table has a `UNIQUE(repo_id, file_path)` constraint, but `file_path` alone is not unique.

The `repoId` is available in scope and could be added: `.eq("repo_id", repoId)`.

**Impact:** Could return wrong file content in multi-repo setups.

**Verdict:** Bug. Should add `.eq("repo_id", repoId)` to the query.

## Missing Configuration

None. All dependencies are installed:
- `@modelcontextprotocol/sdk` -- in package.json
- `@supabase/supabase-js` -- in package.json
- `neo4j-driver` -- in package.json
- `zod` -- in package.json
- `dotenv` -- in package.json

All imports resolve:
- `./repo-resolver.js` -- exists as `src/repo-resolver.ts`
- `./runtime-tools.js` -- exists as `src/runtime-tools.ts`

TypeScript config extends base config; `rootDir: "src"` and `outDir: "dist"` are correct.

## Schema Verification Summary

| Code Reference | Table | Columns Used | Schema Match |
|---|---|---|---|
| get_recent_logs | runtime_logs | id, timestamp, source, level, message, function_name, file_path, line_number, repo_id | All exist |
| search_logs | runtime_logs | id, timestamp, source, level, message, file_path, line_number, stack_trace, repo_id | All exist |
| get_deploy_errors | runtime_logs | id, timestamp, source, level, message, function_name, file_path, line_number, stack_trace, deployment_id, repo_id | All exist |
| get_deploy_errors | deployments | deployment_id, source, status, branch, commit_sha, started_at, repo_id | All exist |
| get_deployment_history | deployments | *, deployment_id, source, status, branch, commit_sha, started_at, repo_id | All exist |
| get_deployment_history | runtime_logs | deployment_id, level, repo_id | All exist |
| trace_error | runtime_logs | *, id, stack_trace, message | All exist |
| trace_error | file_contents | content, language, file_path | All exist |
| resolveRepoId | repositories | id, name, url | All exist |

## Summary

**Overall: ISSUES FOUND -- 1 bug, 1 imprecision, both low-severity**

The Phase 5 implementation is solid and comprehensive. All 5 tools are fully implemented with real logic (no stubs). The `registerRuntimeTools` function is correctly wired into `index.ts`. The `resolveRepoId` helper is correctly used by all 5 tools with proper null handling. Stack trace parsing covers Node.js and Python formats. Neo4j session management uses `try/finally` for proper cleanup. Error paths propagate to users via MCP response format. All Supabase table/column references match the migration schema.

**Bug to fix:**
1. `trace_error` file_contents query (line 461-466) should add `.eq("repo_id", repoId)` to avoid returning wrong file in multi-repo setups.

**Design note for future:**
2. `trace_error` callers query matches by function name globally rather than scoping to the specific function node found in Step 3. This matches the build plan spec but could return false positives for common names like `handler` or `get`.
