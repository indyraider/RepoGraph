# Phase 6 Dependency Audit
**Phase:** MCP Tool Updates
**Date:** 2026-03-06
**Status:** ISSUES FOUND

## Verified Connections

- [x] **New tool: `get_type_info` registered with McpServer** -- trigger: `server.tool("get_type_info", ...)` at index.ts:752 -> handler: index.ts:761 -> calls: Cypher query matching `(f:File)-[:CONTAINS]->(sym)` with optional repo scoping, OPTIONAL MATCH on CALLS edges with caller info -> effect: Returns formatted type info including resolved_signature, param_types, return_type, is_generic, type_params, and optionally callers with type mismatch flags. Schema matches: `name` (required string), `file` (optional string), `repo` (optional string), `include_callers` (optional boolean, default false). All z schema params are referenced in the handler. Empty results return `"No type info found for symbol: ${name}"`. Session is closed in finally block.

- [x] **`get_type_info` Cypher query references valid Neo4j properties** -- The query reads `sym.resolved_signature`, `sym.param_types`, `sym.return_type`, `sym.is_generic`, `sym.type_params`. Cross-referenced against loader.ts: `loadSymbolsToNeo4j` (line 112-116) writes `fn.resolved_signature`, `fn.param_types`, `fn.return_type`, `fn.is_generic`, `fn.type_params` on Function nodes, and `c.resolved_signature`, `c.is_generic`, `c.type_params` on Class nodes. The CALLS edge properties `c.call_site_line`, `c.has_type_mismatch`, `c.type_mismatch_detail` are written by `loadCallsToNeo4j` (loader.ts:556-559). All property references are valid.

- [x] **`get_type_info` `$includeCallers` parameter** -- Cypher uses `CASE WHEN $includeCallers THEN ... ELSE [] END`. The parameter is passed as `includeCallers: include_callers ?? false` (line 804). Neo4j supports boolean parameters in CASE WHEN. Correct.

- [x] **`get_type_info` result field access matches RETURN clause** -- RETURN aliases: `name`, `kind`, `signature`, `resolved_signature`, `param_types`, `return_type`, `is_generic`, `type_params`, `file_path`, `start_line`, `end_line`, `callers`. All accessed via `r.get(...)` with matching names. `end_line` is returned but not used in output (minor, not a bug).

- [x] **`get_symbol` handler modified with type fields** -- trigger: `server.tool("get_symbol", ...)` at index.ts:270 -> handler: index.ts:282 -> Cypher RETURN clause (lines 311-315) now includes `sym.resolved_signature AS resolved_signature`, `sym.param_types AS param_types`, `sym.return_type AS return_type`, `sym.is_generic AS is_generic`, `sym.type_params AS type_params` -> effect: Output formatting at lines 354-357 appends resolved type, param types, return type, and generic info when present. Null/undefined handled via truthiness checks.

- [x] **`get_dependencies` handler modified with `resolved_type` on DIRECTLY_IMPORTS** -- trigger: `server.tool("get_dependencies", ...)` at index.ts:419 -> handler: direct imports query at line 480 -> Cypher returns `di.resolved_type AS resolved_type` (line 485) -> effect: Output formatting at line 493 appends ` :: ${resolvedType}` when present. Property `resolved_type` on DIRECTLY_IMPORTS edges is written by `loadImportsToNeo4j` (loader.ts:333). Valid.

- [x] **`get_dependencies` handler modified with CALLS edge sections** -- trigger: same tool -> outgoing CALLS query at line 499 returns `caller.name`, `callee.name`, `tf.path`, `r.call_site_line` -> incoming CALLS query at line 515 returns `caller.name`, `sf.path`, `callee.name`, `r.call_site_line` -> effect: Output sections at lines 507-511 and 523-527 format outgoing and incoming call relationships. Properties reference `call_site_line` which is written by `loadCallsToNeo4j` (loader.ts:556). Valid.

- [x] **`trace_imports` handler modified with `resolved_type`** -- trigger: `server.tool("trace_imports", ...)` at index.ts:541 -> handler: direct import queries at lines 581 and 587 -> Cypher returns `di.resolved_type AS resolved_type` (lines 586, 591) -> effect: Output at line 639 appends ` :: ${resolvedType}` when present. Valid.

- [x] **`trace_error` handler modified with type info on containing function** -- trigger: `server.tool("trace_error", ...)` at runtime-tools.ts:354 -> handler: containing function query at line 422 -> Cypher RETURN now includes `fn.resolved_signature AS resolved_signature`, `fn.param_types AS param_types`, `fn.return_type AS return_type` (lines 427-428) -> effect: Output at lines 438-440 appends resolved type, param types, return type. Valid properties per loader.

- [x] **`trace_error` handler modified with CALLS edge type mismatch details** -- trigger: same tool -> callers query at line 447 -> Cypher RETURN includes `r.has_type_mismatch AS has_type_mismatch`, `r.type_mismatch_detail AS type_mismatch_detail` (lines 451-452) -> effect: Output at line 460 appends mismatch warning. Valid properties per `loadCallsToNeo4j` (loader.ts:558-559).

- [x] **All imports used in index.ts** -- `McpServer`, `StdioServerTransport`, `z`, `neo4j`/`Driver`/`Session`, `createClient`/`SupabaseClient`, `dotenv`, `fileURLToPath`, `path`, `registerRuntimeTools` -- all used. No unused imports.

- [x] **All imports used in runtime-tools.ts** -- `McpServer`, `z`, `Session`, `SupabaseClient`, `resolveRepoId` -- all used. No unused imports.

## Stubs & Placeholders Found

None. All handlers contain real Cypher queries and real response formatting logic. No TODO/FIXME comments in Phase 6 code. No hardcoded return values where real data should flow.

## Broken Chains

### 1. `get_symbol` callers missing CALLS edge type data (arg_types, has_type_mismatch)
- **The chain:** Plan Contract 12 says: "Include arg_types and has_type_mismatch on callers (from CALLS edges)"
- **Breaks at:** index.ts lines 302-303 and 319-320 -- the OPTIONAL MATCH uses `(caller:Function)-[:CALLS]->(sym)` without binding the relationship to a variable. The collect at line 316 only captures `{caller: caller.name, file: cf.path}`.
- **Evidence:** The CALLS relationship is not bound (no `[r:CALLS]`), so `r.arg_types`, `r.has_type_mismatch` etc. are inaccessible. The callers output at lines 363-365 shows only name and file, no type mismatch info.
- **Impact:** `get_symbol` callers section never shows arg types or type mismatch flags, even when the data exists on CALLS edges in Neo4j. Users must use `get_type_info` with `include_callers: true` to see this data.
- **Fix:** Change `OPTIONAL MATCH (caller:Function)-[:CALLS]->(sym)` to `OPTIONAL MATCH (caller:Function)-[callsRel:CALLS]->(sym)` and add `arg_types: callsRel.arg_types, has_mismatch: callsRel.has_type_mismatch` to the collect map. Update the output formatting to display mismatch info.

### 2. Neo4j Integer type not handled for `call_site_line` in multiple tools
- **The chain:** Neo4j stores `call_site_line` as an integer -> Neo4j driver returns it as a Neo4j Integer object -> code interpolates it into strings
- **Breaks at:** Multiple locations:
  - `get_type_info` (index.ts:845): `c.call_site_line` from collected map -- no `.toNumber()` call
  - `get_dependencies` (index.ts:510, 526): `r.get("call_line")` -- no `.toNumber()` call
  - `trace_error` (runtime-tools.ts:459): `r.get("call_site_line")` and `r.get("caller_line")` -- no `.toNumber()` call
- **Evidence:** In `get_type_info`, the callers come from a `collect()` call in Cypher. When Neo4j collects properties into a map, integer values remain as Neo4j Integer objects in the JavaScript driver. String interpolation of a Neo4j Integer produces `{"low":42,"high":0}` instead of `42`.
- **Impact:** Call site line numbers in output may display as JSON objects instead of numbers. The `get_dependencies` tool uses `r.get("call_line")` which returns a Neo4j Integer directly, producing the same garbled output.
- **Fix:** For `r.get()` calls: use `(r.get("call_line") as any)?.toNumber?.() ?? r.get("call_line")`. For collected map values in `get_type_info`: apply a post-processing step to convert integers in the callers array, or use `toInteger()` in the Cypher RETURN to force native int representation.

### 3. `get_type_info` dead code: `conditions` array built but never used
- **The chain:** Lines 766-768 build a `conditions` array with filter predicates
- **Breaks at:** Lines 770-774 construct `repoMatch` and `whereClause` independently, ignoring `conditions`
- **Evidence:** The `conditions` array is populated but never referenced in the query string construction.
- **Impact:** No functional impact -- the `repoMatch` and `whereClause` variables independently implement the same logic correctly. But the dead code creates a maintenance trap: a developer might modify `conditions` thinking it affects the query.
- **Fix:** Remove lines 766-768 (the `conditions` array construction).

### 4. `get_dependencies` CALLS queries missing `arg_types` on CALLS edges
- **The chain:** Plan Phase 6 checklist says: "Include arg_types on CALLS edges when direction='in'"
- **Breaks at:** index.ts lines 499-504 (outgoing CALLS query) and lines 515-519 (incoming CALLS query) -- neither query returns `r.arg_types` from the CALLS relationship
- **Evidence:** The RETURN clauses only include `caller.name`, `callee.name`, file paths, and `r.call_site_line`. `r.arg_types` is absent.
- **Impact:** `get_dependencies` shows call relationships but not the argument types passed at each call site. Users cannot see type flow through CALLS edges from this tool.
- **Fix:** Add `r.arg_types AS arg_types` to both CALLS queries' RETURN clauses. Update output formatting to display arg types when present.

### 5. `trace_error` callers query missing `arg_types`
- **The chain:** Plan Contract 13 says: "Modified callers query: ... c.arg_types"
- **Breaks at:** runtime-tools.ts line 447-453 -- the RETURN clause includes `r.call_site_line`, `r.has_type_mismatch`, `r.type_mismatch_detail` but NOT `r.arg_types`
- **Evidence:** The plan specifies showing "Args: [Order | null]" in the caller output, but `arg_types` is never fetched.
- **Impact:** The trace_error output shows type mismatch flags but not the actual argument types that caused the mismatch. Users see "TYPE MISMATCH" but not what types were passed.
- **Fix:** Add `r.arg_types AS arg_types` to the RETURN clause. Update the output at line 459-460 to include arg types: `if (r.get("arg_types")) callerLine += \` Args: [${r.get("arg_types").join(", ")}]\``.

### 6. `type_errors` not loaded to Neo4j and not queried by any MCP tool
- **The chain:** Plan Contract 8 says loader should SET `fn.type_errors = s.type_errors`. Contract 11 and 12 expect `sym.type_errors` to be queryable.
- **Breaks at:** loader.ts `loadSymbolsToNeo4j` -- the Function batch (lines 91-103) and Class batch (lines 127-138) do NOT include `type_errors` in the mapped data or SET clause. No MCP tool queries `sym.type_errors`.
- **Evidence:** `ParsedSymbol.typeErrors` is defined (parser.ts:21) and populated by node-enricher.ts:84-87, but loader.ts never writes it. `get_type_info` and `get_symbol` never read it.
- **Impact:** Type error diagnostics (e.g., TS2345 argument type mismatches) attached to functions by the SCIP stage are silently dropped at the loader boundary. The plan's example output showing "Type Errors: - TS2345: Argument of type 'null'..." will never appear.
- **Fix:** This spans Phase 5 (loader) and Phase 6 (MCP tools). In loader.ts, add `type_errors: s.typeErrors ? JSON.stringify(s.typeErrors) : null` to the batch map and `fn.type_errors = s.type_errors` to the SET clause. In `get_type_info`, add `sym.type_errors AS type_errors` to RETURN and format in output. (Note: Neo4j cannot store arrays of objects natively -- serialize as JSON string or flatten.)

## Missing Configuration

None identified for Phase 6 specifically. All required imports are present. The `get_type_info` tool's z schema params (`name`, `file`, `repo`, `include_callers`) are all referenced in the handler.

## Summary

Phase 6 successfully implements the core structure of all planned MCP tool modifications: `get_type_info` is a fully functional new tool with real Cypher queries, `get_symbol` and `trace_error` include type signature fields, `get_dependencies` includes `resolved_type` on DIRECTLY_IMPORTS and has CALLS edge sections, and `trace_imports` includes `resolved_type`. However, the implementation falls short of the plan in several ways: (1) `arg_types` from CALLS edges is never surfaced by any tool despite the plan requiring it in `get_symbol`, `get_dependencies`, and `trace_error`; (2) `get_symbol`'s callers section does not include type mismatch data because the CALLS relationship is not bound to a variable; (3) Neo4j Integer types for `call_site_line` are not converted to JavaScript numbers, which will produce garbled output in string interpolation; (4) `type_errors` is never written to Neo4j by the loader (Phase 5 gap) and never queried by MCP tools, making the diagnostic display feature from the plan non-functional; (5) dead code (`conditions` array) in `get_type_info` creates a maintenance risk. Issues 1, 2, 4, and 5 are moderate severity -- the tools work but deliver less type information than specified. Issue 3 (Neo4j integers) is a visible output corruption bug that should be fixed before shipping.
