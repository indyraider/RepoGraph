# Phase 4 Dependency Audit
**Phase:** MCP Tool Updates
**Date:** 2026-03-06
**Status:** PASS

## Verified Connections

### 1. get_symbol — DIRECTLY_IMPORTS query added

- [x] **Cypher added (index.ts lines 262, 275):** `OPTIONAL MATCH (directImporter:File)-[di:DIRECTLY_IMPORTS]->(sym)`
  - Relationship type: `DIRECTLY_IMPORTS` -- matches loader.ts line 314 exactly
  - Direction: `(File)-[]->(sym)` -- correct, loader creates `(from:File)-[r:DIRECTLY_IMPORTS]->(sym)` at line 314
  - OPTIONAL MATCH used -- handles repos without DIRECTLY_IMPORTS edges (pre-resolution digests). If no edges exist, `directImporter` and `di` are null. Correct.
  - The `sym` variable is already bound from the earlier `MATCH (f:File)-[:CONTAINS]->(sym)` pattern, so this correctly finds files that directly import *this specific symbol*. No WHERE clause needed.

- [x] **RETURN clause (lines 269, 282):** `collect(DISTINCT {file: directImporter.path, kind: di.import_kind, alias: di.alias}) AS directly_imported_by`
  - `di.import_kind` -- matches loader.ts line 315: `r.import_kind = di.import_kind`
  - `di.alias` -- matches loader.ts line 315: `r.alias = di.alias`
  - `directImporter.path` -- File nodes have `.path` property (verified in loader.ts line 42: `file.path`)
  - `DISTINCT` used to deduplicate -- correct

- [x] **Result formatting (lines 317-324):** `r.get("directly_imported_by")` with `.filter((d) => d.file)`
  - Filters out null entries (from OPTIONAL MATCH producing `{file: null, kind: null, alias: null}`) -- correct
  - Accesses `d.file`, `d.kind`, `d.alias` -- matches the RETURN clause map keys exactly
  - `d.alias ? \` as \${d.alias}\` : ""` -- handles null alias gracefully
  - `d.kind || "named"` -- defaults to "named" if import_kind is null -- reasonable fallback

- [x] **Both repo-scoped and unscoped queries updated:** Lines 253-269 (with repo) and lines 270-282 (without repo) both include the identical OPTIONAL MATCH pattern. Consistent.

- [x] **Cartesian product risk:** The query has 4 OPTIONAL MATCH clauses (callers, cf, importer, directImporter). Neo4j collect(DISTINCT ...) handles the cross-product correctly since each collects independently with DISTINCT. However, this is a known Neo4j pattern that can produce inflated intermediate rows. Not a correctness bug, but a performance consideration for symbols with many callers AND many importers.

### 2. get_dependencies — inbound DIRECTLY_IMPORTS query added

- [x] **Separate query (index.ts lines 399-405):**
  ```
  MATCH (source:File)-[di:DIRECTLY_IMPORTS]->(sym)<-[:CONTAINS]-(f:File {path: $path})
  WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
  ```
  - Traversal pattern: `source:File -> DIRECTLY_IMPORTS -> sym <- CONTAINS <- f:File` -- correct. This finds files that directly import symbols contained in the target file.
  - `WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant` -- matches the exact same label filter used in loader.ts line 311
  - Parameter: `$path` passed as `{ path: filePath }` -- matches the parameter binding at line 404

- [x] **RETURN clause (lines 402-403):** `source.path AS source_path, sym.name AS symbol_name, di.import_kind AS import_kind, di.alias AS alias`
  - `di.import_kind` -- matches loader property name
  - `di.alias` -- matches loader property name
  - `sym.name` -- all symbol nodes (Function, Class, TypeDef, Constant) have `.name` property (loader.ts lines 103, 129, 154, 179)

- [x] **Result formatting (lines 407-413):**
  - `r.get("source_path")`, `r.get("symbol_name")`, `r.get("import_kind")`, `r.get("alias")` -- all match RETURN column aliases exactly
  - `r.get("alias") ? \` as \${r.get("alias")}\` : ""` -- handles null alias
  - `r.get("import_kind") || "named"` -- defaults to "named" if null

- [x] **Conditional execution:** Only runs when `direction === "in" || direction === "both"` (line 380) -- correct, this is an inbound query

- [x] **Graceful degradation:** This is a separate `session.run()` call (not part of a UNION or combined query). If no DIRECTLY_IMPORTS edges exist, `directInResult.records.length` is 0 and the section is simply skipped. No error thrown.

- [x] **Section header consistency:** Displays as `## Directly imports (symbol-level):` -- slightly misleading name since it shows what OTHER files directly import FROM this file's symbols. The label could be improved to "Directly imported by (symbol-level)" but this is a cosmetic nit, not a correctness issue.

### 3. trace_imports — UNION approach with separate queries

- [x] **File-level query (index.ts lines 450-461):**
  - Uses only `[:IMPORTS*1..${depth}]` -- correctly limited to IMPORTS relationship only
  - Does NOT use `[:IMPORTS|DIRECTLY_IMPORTS*1..]` as originally suggested in the plan. Instead uses two separate queries. This is the superior approach because DIRECTLY_IMPORTS points to symbol nodes (not File nodes), so a variable-length path mixing both types would traverse heterogeneous node types and produce confusing chains.
  - Chain formatting handles File and Package nodes: `CASE WHEN n:File THEN n.path WHEN n:Package THEN 'pkg:' + n.name ELSE n.name END`
  - Depth is validated: `Math.min(Math.max(Math.round(max_depth || 3), 1), 10)` -- capped at 1-10, safe for interpolation

- [x] **Symbol-level query (index.ts lines 464-476):** Separate query with direction handling:
  - Upstream: `MATCH (start:File {path: $startPath})-[di:DIRECTLY_IMPORTS]->(sym)` -- finds symbols this file directly imports
  - Downstream: `MATCH (source:File)-[di:DIRECTLY_IMPORTS]->(sym)<-[:CONTAINS]-(start:File {path: $startPath})` -- finds files that directly import symbols from this file
  - Both include `WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant` -- matches loader label filter
  - Upstream uses `OPTIONAL MATCH (f:File)-[:CONTAINS]->(sym)` to get the file that contains the symbol -- OPTIONAL is correct here since orphan symbols theoretically could exist
  - Returns: `sym.name`, `labels(sym)[0]`, `f.path`/`source.path`, `di.import_kind`, `di.alias` -- all properties verified against loader

- [x] **Result formatting (lines 508-523):**
  - Upstream: `r.get("target_file") || "(unknown file)"` -- gracefully handles null from OPTIONAL MATCH on CONTAINS
  - Downstream: `r.get("source_file")` -- no null guard, but this comes from a MATCH (not OPTIONAL MATCH) so it's always non-null. Correct.
  - Alias handling: `r.get("alias") ? \` as \${r.get("alias")}\` : ""` -- correct

- [x] **Empty result handling (line 478):** Checks both `importResult.records.length === 0 && directResult.records.length === 0` before returning "No import chains found". Correct.

### 4. trace_error — DIRECTLY_IMPORTS query added

- [x] **Cypher query (runtime-tools.ts lines 458-465):**
  ```
  MATCH (f:File {path: $filePath})-[di:DIRECTLY_IMPORTS]->(sym)
  WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
  OPTIONAL MATCH (tf:File)-[:CONTAINS]->(sym)
  RETURN sym.name AS symbol_name, labels(sym)[0] AS symbol_kind,
         tf.path AS target_file, di.import_kind AS import_kind, di.alias AS alias
  ```
  - Relationship type: `DIRECTLY_IMPORTS` -- correct
  - Direction: `(f:File)-[]->(sym)` -- correct, finds what the error file directly imports at symbol level
  - `WHERE` clause with 4 labels -- matches loader
  - `OPTIONAL MATCH (tf:File)-[:CONTAINS]->(sym)` -- handles potential orphan symbols
  - Parameter: `$filePath` passed as `{ filePath: topFrame.filePath }` -- matches binding at line 465. Correct.

- [x] **Property names in RETURN:** `di.import_kind`, `di.alias`, `sym.name`, `labels(sym)[0]`, `tf.path` -- all verified against loader and node schemas

- [x] **Result formatting (lines 467-474):**
  - `r.get("symbol_name")`, `r.get("symbol_kind")`, `r.get("target_file")`, `r.get("import_kind")`, `r.get("alias")` -- all match RETURN aliases
  - `r.get("alias") ? \` as \${r.get("alias")}\` : ""` -- null-safe
  - `r.get("target_file") || "unknown"` -- handles null from OPTIONAL MATCH

- [x] **Placement in execution flow:** Runs at lines 457-474, after the existing IMPORTS query (lines 438-455) and after the callers query. This is correct -- it's a separate, independent query that adds a new section to the output.

- [x] **Graceful degradation:** `if (directImportResult.records.length > 0)` guards the output section. If no DIRECTLY_IMPORTS edges exist, section is silently skipped. Correct.

## Broken Chains

None found.

## Missing Configuration

None found.

## Edge Cases Verified

### DIRECTLY_IMPORTS edges don't exist yet (repo hasn't been re-digested)

- **get_symbol:** Uses `OPTIONAL MATCH` -- produces null entries filtered out by `.filter((d) => d.file)`. PASS.
- **get_dependencies:** Separate `session.run()` call. Zero records returned, section skipped. PASS.
- **trace_imports:** Separate `session.run()` call. Zero records returned, section skipped. Combined empty check covers both queries. PASS.
- **trace_error:** Separate `session.run()` call. Zero records returned, section skipped. PASS.

### Orphan symbol (no CONTAINS edge from a file)

- **get_symbol:** The `sym` is bound from `MATCH (f:File)-[:CONTAINS]->(sym)`, so orphan symbols without a CONTAINS edge are never returned in the first place. PASS.
- **get_dependencies:** `MATCH ... (sym)<-[:CONTAINS]-(f:File)` -- orphan symbols excluded by MATCH. PASS.
- **trace_imports (upstream):** `OPTIONAL MATCH (f:File)-[:CONTAINS]->(sym)` -- if no file contains the symbol, `f.path` is null, output shows `(unknown file)`. PASS.
- **trace_imports (downstream):** `MATCH ... (sym)<-[:CONTAINS]-(start:File)` -- orphan symbols excluded. PASS.
- **trace_error:** `OPTIONAL MATCH (tf:File)-[:CONTAINS]->(sym)` -- null handled as `"unknown"`. PASS.

### Cartesian product / duplicate rows in get_symbol

The get_symbol query has 4 independent OPTIONAL MATCH clauses. Without intermediate WITH/collect steps, the intermediate result set can be M*N*O*P rows. Neo4j's `collect(DISTINCT ...)` handles deduplication correctly, but for symbols with many callers AND many importers AND many direct importers, this could produce large intermediate row counts. This is a pre-existing pattern (the callers/imported_by OPTIONAL MATCHes existed before Phase 4), and adding one more OPTIONAL MATCH extends the pattern. Not a correctness issue, but a known performance consideration.

## Consistency Cross-Check: Loader vs MCP Queries

| Property | Loader writes (loader.ts) | MCP reads | Match? |
|----------|--------------------------|-----------|--------|
| Edge type | `DIRECTLY_IMPORTS` (line 314) | All 4 tools use `DIRECTLY_IMPORTS` | YES |
| `import_kind` | `r.import_kind = di.import_kind` (line 315) | `di.import_kind` in all queries | YES |
| `alias` | `r.alias = di.alias` (line 315) | `di.alias` in all queries | YES |
| Target node labels | `WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant` (line 311) | Same WHERE in get_dependencies, trace_imports, trace_error; implicit via CONTAINS in get_symbol | YES |
| Symbol matching | `{name: ..., file_path: ..., repo_url: ...}` (line 310) | N/A (MCP queries traverse from File via edge, not by property match) | N/A |

## Summary

All four MCP tool updates are correctly implemented. Every Cypher query references the correct relationship type (`DIRECTLY_IMPORTS`), uses the correct property names (`import_kind`, `alias`), and handles the edge cases of missing edges (pre-resolution repos) and orphan symbols gracefully. The loader's DIRECTLY_IMPORTS edge schema (properties, direction, target node labels) is consistently reflected across all consuming queries. No broken chains, no missing configuration, no data flow mismatches found.
