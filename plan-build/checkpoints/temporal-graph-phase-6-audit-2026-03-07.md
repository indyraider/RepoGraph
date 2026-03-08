# Phase 6 Audit: MCP Tools
**Date:** 2026-03-07
**Auditor:** Claude Opus 4.6
**Status:** PASS WITH ISSUES

## Files Audited

- `/Users/mattjones/Documents/RepoGraph/packages/mcp-server/src/temporal-tools.ts` (NEW, 389 lines)
- `/Users/mattjones/Documents/RepoGraph/packages/mcp-server/src/index.ts` (MODIFIED, 1078 lines)
- `/Users/mattjones/Documents/RepoGraph/supabase-temporal-migration.sql` (schema reference)

---

## 1. EXECUTION CHAINS

### 1.1 registerTemporalTools called in index.ts?
**PASS.** Line 10 imports: `import { registerTemporalTools } from "./temporal-tools.js";`
Line 1040 calls: `registerTemporalTools(server, getSession, getSupabase, SCOPED_REPO);`
Called after `registerRuntimeTools` (line 1037) and before `main()` (line 1043). Correct placement.

### 1.2 All 6 tools have complete handlers (not stubs)?
**PASS.** All 6 tools have full implementations:

| Tool | Lines | Cypher/Supabase | Empty result handling |
|------|-------|-----------------|----------------------|
| `get_symbol_history` | 24-86 | Cypher | Returns "No history found for symbol: {name}" |
| `diff_graph` | 89-153 | Cypher | Returns "No changes found between {from} and {to}" |
| `get_structural_blame` | 156-211 | Cypher | Returns "No creation record found for: {name}" |
| `get_complexity_trend` | 214-273 | Supabase | Returns "No complexity metrics found for: {path}" |
| `find_when_introduced` | 276-326 | Cypher | Returns "No introduction record found for: {name}" |
| `find_when_removed` | 329-382 | Cypher | Returns "No removal record found for: {name}" |

### 1.3 Cypher queries reference valid Neo4j node labels and relationship types?
**PASS.** All queries reference labels/relationships consistent with the existing graph schema:
- Labels used: `Repository`, `File`, `Function`, `Class`, `TypeDef`, `Constant`, `Commit`
- Relationships used: `CONTAINS`, `INTRODUCED_IN`, `CALLS`, `IMPORTS`, `DIRECTLY_IMPORTS`
- Dynamic label filter pattern (e.g., `:Function`, `:Class`, `:TypeDef`, `:Constant`) is consistent across all 5 Neo4j-querying tools.

### 1.4 get_complexity_trend Supabase table reference?
**PASS.** The tool queries `complexity_metrics` table with columns: `commit_sha, file_path, metric_name, metric_value, timestamp`. Cross-checked against `/Users/mattjones/Documents/RepoGraph/supabase-temporal-migration.sql` — table schema matches exactly (columns: `id, repo_id, commit_sha, file_path, metric_name, metric_value, timestamp, created_at`). Note: the build plan (line 302) listed `commit_id` but the actual migration and tool code both use `commit_sha` — consistent with each other.

---

## 2. DATA FLOW

### 2.1 Same session/supabase/scopedRepo pattern as existing tools?
**PASS.** The `registerTemporalTools` function signature accepts `(server, getSession, getSupabase, scopedRepo)` and uses them identically to `registerRuntimeTools`. Each Neo4j-using tool calls `getSession()` and closes the session in a `finally` block. The Supabase-using tool (`get_complexity_trend`) calls `getSupabase()`.

### 2.2 Neo4j integer types handled correctly?
**PARTIAL PASS.** The `toNum()` helper is defined (lines 386-388) and handles Neo4j integer-to-number conversion correctly. However, it is only used once — for `start_line` in `get_symbol_history` (line 73). Other Neo4j integer fields like `end_line` are not wrapped in `toNum()`, though they are not directly displayed as numbers in most tools (they appear in string interpolation where `.toString()` is implicit).

### 2.3 Results formatted consistently with existing tools?
**PASS.** Output uses markdown headings (`##`, `###`), inline formatting, and the `{ content: [{ type: "text" as const, text: ... }] }` return pattern — matching existing tools exactly.

---

## 3. STUBS AND PLACEHOLDERS

### 3.1 TODO/FIXME/HACK/PLACEHOLDER comments?
**PASS.** No TODO, FIXME, HACK, placeholder, or stub comments found in either `temporal-tools.ts` or `index.ts`.

---

## 4. CONFIGURATION

### 4.1 temporal-tools.ts imports correct types?
**PASS.** Imports:
- `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`
- `z` from `zod`
- `Session` from `neo4j-driver`
- `SupabaseClient` from `@supabase/supabase-js`

### 4.2 GetSessionFn/GetSupabaseFn types compatible?
**PASS.** `temporal-tools.ts` defines `type GetSessionFn = () => Session` and `type GetSupabaseFn = () => SupabaseClient`. In `index.ts`, `getSession()` returns `Session` (line 33-36) and `getSupabase()` returns `SupabaseClient` (line 39-47). Types are compatible.

### 4.3 TypeScript compilation?
**PASS.** `npx tsc --noEmit` completes with zero errors.

---

## 5. TEMPORAL FILTERS ON EXISTING QUERIES IN index.ts

### 5.1 Audit of every Cypher query with temporal filter verification

**Total temporal filters found in index.ts:** 38 occurrences of `valid_to IS NULL OR NOT EXISTS(valid_to)`.

| Tool | Query Location | Nodes/Edges Filtered | Verdict |
|------|---------------|---------------------|---------|
| `get_symbol` (exact, repo-scoped) | Lines 305-326 | sym, CALLS (c), caller, IMPORTS (imp), DIRECTLY_IMPORTS (di) | PASS |
| `get_symbol` (exact, unscoped) | Lines 327-348 | sym, CALLS (c), caller, IMPORTS (imp), DIRECTLY_IMPORTS (di) | PASS |
| `get_symbol` (fuzzy, repo-scoped) | Lines 357-385 | sym, CALLS (c), caller, IMPORTS (imp), DIRECTLY_IMPORTS (di) | PASS |
| `get_symbol` (fuzzy, unscoped) | Lines 386-411 | sym, CALLS (c), caller, IMPORTS (imp), DIRECTLY_IMPORTS (di) | PASS |
| `get_dependencies` (out) | Line 519 | IMPORTS (r) | PASS |
| `get_dependencies` (in) | Line 545 | IMPORTS (r) | PASS |
| `get_dependencies` (direct in) | Lines 565-566 | sym, DIRECTLY_IMPORTS (di) | PASS |
| `get_dependencies` (calls out) | Lines 586-588 | caller, CALLS (r), callee | PASS |
| `get_dependencies` (calls in) | Lines 606-608 | caller, CALLS (r), callee | PASS |
| `trace_imports` (file chains) | Line 659 | ALL relationships in path | PASS |
| `trace_imports` (direct, upstream) | Lines 676-677 | sym, DIRECTLY_IMPORTS (di) | PASS |
| `trace_imports` (direct, downstream) | Lines 684-685 | sym, DIRECTLY_IMPORTS (di) | PASS |
| `get_type_info` | Lines 872, 875-876 | sym, CALLS (c), caller | PASS |
| `get_upstream_dep` | Lines 768-801 | Package/PackageExport nodes | N/A (not temporal) |
| `search_code` | Lines 76-143 | Supabase only | N/A (not temporal) |
| `get_file` | Lines 146-200 | Supabase only | N/A (not temporal) |
| `query_graph` | Lines 960-1034 | Raw Cypher escape hatch | N/A (user responsibility) |

### 5.2 Filter pattern correctness
**PASS.** All filters use the pattern `(x.valid_to IS NULL OR NOT EXISTS(x.valid_to))` which correctly handles:
- Temporal nodes where `valid_to` is set to null (current version)
- Pre-temporal nodes where the `valid_to` property does not exist at all

---

## 6. ISSUES FOUND

### ISSUE 1: get_repo_structure missing temporal filter on File nodes (MEDIUM)
**Location:** `index.ts` lines 219-222
**Query:**
```cypher
MATCH (r:Repository)-[:CONTAINS_FILE]->(f:File)
WHERE r.name = $repo OR r.url = $repo
RETURN f.path AS path, f.language AS language, f.size_bytes AS size
ORDER BY f.path
```
**Problem:** No `(f.valid_to IS NULL OR NOT EXISTS(f.valid_to))` filter on File nodes. Once temporal versioning is active, this query will return historical (deleted/superseded) File nodes alongside current ones, causing duplicate file paths in the tree output.
**Fix:** Add `AND (f.valid_to IS NULL OR NOT EXISTS(f.valid_to))` to the WHERE clause, or filter on the `CONTAINS_FILE` relationship if that relationship also gets temporal fields.

### ISSUE 2: diff_graph scope filter doesn't actually filter results (LOW-MEDIUM)
**Location:** `temporal-tools.ts` lines 114-115
**Code:**
```typescript
OPTIONAL MATCH (f:File)-[:CONTAINS]->(sym)
${scope ? "WHERE f.path STARTS WITH $scope" : ""}
```
**Problem:** In Cypher, `WHERE` after `OPTIONAL MATCH` constrains the optional pattern match, not the overall result. When `scope` is set and a symbol's file doesn't match the scope prefix, the row is still returned but with `f.path = null`. The scope filter silently fails — symbols from ALL files appear in results, just with null file paths for non-matching ones.
**Fix:** Either:
1. Use a regular `MATCH` instead of `OPTIONAL MATCH` (this would exclude symbols without files entirely), or
2. Add a separate `WITH ... WHERE` clause after the OPTIONAL MATCH to actually filter the rows: `WITH * WHERE f IS NULL OR f.path STARTS WITH $scope`

### ISSUE 3: diff_graph — Commit nodes may lack `repo_url` property (LOW)
**Location:** `temporal-tools.ts` line 109
**Query pattern:** `MATCH (fromCommit:Commit {repo_url: repoUrl})`
**Problem:** The Commit node identity uses `{repo_url: repoUrl}` as an inline property match. This assumes Commit nodes have a `repo_url` property. The commit ingester (Phase 2) must ensure this property is set. If commits were ingested without `repo_url`, the query silently returns no results.
**Risk:** Low — this is a cross-phase consistency issue, not a Phase 6 code bug.

### ISSUE 4: diff_graph — timestamp comparison assumes comparable types (LOW)
**Location:** `temporal-tools.ts` lines 111-113
**Query:**
```cypher
WITH repoUrl, fromCommit.timestamp AS fromTs, toCommit.timestamp AS toTs
MATCH (sym)-[intro:INTRODUCED_IN]->(c:Commit {repo_url: repoUrl})
WHERE c.timestamp >= fromTs AND c.timestamp <= toTs
```
**Problem:** This does range comparison on `timestamp` properties. If timestamps are stored as ISO strings, string comparison works for ISO 8601 format. If stored as Neo4j datetime objects, comparison also works. But if there's any inconsistency in timestamp storage format between commits, the range filter could silently produce incorrect results.
**Risk:** Low — depends on Phase 2/3 ingestion consistency.

### ISSUE 5: get_complexity_trend — Supabase .or() filter may need escaping (LOW)
**Location:** `temporal-tools.ts` lines 235-236
**Code:**
```typescript
.or(`name.eq.${repo},url.eq.${repo}`)
```
**Problem:** If `repo` contains commas or special PostgREST filter characters, this filter string could break. The existing tools in `index.ts` use the same pattern (e.g., line 62: `.or(\`name.eq.${SCOPED_REPO},url.eq.${SCOPED_REPO}\`)`), so this is a pre-existing pattern, not a new issue.
**Risk:** Very low — repo names/URLs rarely contain commas.

---

## 7. ERROR PATHS

### 7.1 Temporal tool Cypher returns no results?
**PASS.** All 6 tools check `result.records.length === 0` and return a descriptive "not found" message. No tool crashes on empty results.

### 7.2 Supabase complexity_metrics table doesn't exist yet?
**PASS.** The `get_complexity_trend` tool handles this gracefully:
- If the `repositories` lookup fails (line 239): returns "Repository not found: {repo}"
- If the Supabase query errors (line 257): returns "Query error: {message}"
- If the table returns empty data (line 261): returns "No complexity metrics found for: {path}"
- Supabase client will return an error object (not throw) if the table doesn't exist, which is caught at line 257.

### 7.3 No repo specified?
**PASS.** All 6 tools check `const repo = repoParam || scopedRepo; if (!repo) return error`. Consistent error message: "Error: no repo specified."

### 7.4 Neo4j session cleanup?
**PASS.** All 5 Neo4j-using tools use `try/finally` with `await session.close()`. No session leaks.

---

## 8. CHECKLIST VERIFICATION

| Checklist Item | Status | Notes |
|---------------|--------|-------|
| Create temporal-tools.ts with 6 new MCP tools | PASS | All 6 tools implemented with full handlers |
| Register temporal tools in index.ts | PASS | Import at line 10, call at line 1040 |
| Add valid_to IS NULL temporal filters to all existing Cypher queries | **FAIL** | `get_repo_structure` (line 219) is missing the filter on File nodes |
| TypeScript compilation passes | PASS | `tsc --noEmit` returns zero errors |

---

## 9. SUMMARY

**Overall:** 1 blocking issue, 1 medium issue, 3 low-risk issues.

**Must fix before proceeding:**
1. **ISSUE 1 (MEDIUM):** Add temporal filter to `get_repo_structure` File node query in `index.ts` line 220.

**Should fix (non-blocking):**
2. **ISSUE 2 (LOW-MEDIUM):** Fix `diff_graph` scope filter — it doesn't actually filter results, just nullifies file paths.

**Accept / defer:**
3-5. Issues 3-5 are cross-phase consistency concerns or pre-existing patterns. Low risk.
