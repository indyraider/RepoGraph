# Forward Planning Checkpoint: SCIP TypeFlow Phase 5 -> Phases 6 & 7

**Date:** 2026-03-06
**Phase completed:** 5 (Pipeline Integration & Loader Extensions)
**Remaining:** Phase 6 (MCP Tool Updates), Phase 7 (Testing & Validation)

---

## INTERFACE EXTRACTION: What Phase 5 Actually Built

### Neo4j Properties on Function Nodes

Loaded in `loadSymbolsToNeo4j()` (loader.ts:90-118):

| Neo4j Property         | Source (ParsedSymbol field) | Type        |
|------------------------|-----------------------------|-------------|
| `resolved_signature`   | `s.resolvedSignature`       | string/null |
| `param_types`          | `s.paramTypes`              | string[]/null |
| `return_type`          | `s.returnType`              | string/null |
| `is_generic`           | `s.isGeneric`               | boolean/null |
| `type_params`          | `s.typeParams`              | string[]/null |

**NOT stored on Function nodes:** `type_errors`. The `ParsedSymbol.typeErrors` field is populated by `attachDiagnostics()` (node-enricher.ts:84-91) but is **never written to Neo4j** by the loader. The loader maps only the 5 properties above.

### Neo4j Properties on Class Nodes

Loaded in `loadSymbolsToNeo4j()` (loader.ts:126-155):

| Neo4j Property         | Source (ParsedSymbol field) | Type        |
|------------------------|-----------------------------|-------------|
| `resolved_signature`   | `s.resolvedSignature`       | string/null |
| `is_generic`           | `s.isGeneric`               | boolean/null |
| `type_params`          | `s.typeParams`              | string[]/null |

**NOT on Class nodes:** `param_types`, `return_type` (intentionally omitted -- classes don't have these).

### Neo4j Properties on CALLS Edges

Loaded in `loadCallsToNeo4j()` (loader.ts:527-572):

| Neo4j Property          | Source (CallsEdge field)   | Type         |
|-------------------------|----------------------------|--------------|
| `call_site_line`        | `e.callSiteLine`           | number       |
| `arg_types`             | `e.argTypes`               | string[]/null |
| `has_type_mismatch`     | `e.hasTypeMismatch`        | boolean/null |
| `type_mismatch_detail`  | `e.typeMismatchDetail`     | string/null  |

### Exact Cypher Pattern for CALLS Edge Creation

```cypher
UNWIND $calls AS c
MATCH (caller {name: c.caller_name, file_path: c.caller_file, repo_url: $repoUrl})
WHERE caller:Function OR caller:Class
MATCH (callee {name: c.callee_name, file_path: c.callee_file, repo_url: $repoUrl})
WHERE callee:Function OR callee:Class
MERGE (caller)-[r:CALLS]->(callee)
SET r.call_site_line = c.call_site_line,
    r.arg_types = c.arg_types,
    r.has_type_mismatch = c.has_type_mismatch,
    r.type_mismatch_detail = c.type_mismatch_detail
RETURN count(r) AS cnt
```

**Key detail:** CALLS edges can go from/to both `Function` and `Class` nodes. The plan (Contract 7) only mentioned `Function` nodes, but the implementation broadened this. MCP tools querying CALLS edges must account for this.

### Neo4j Properties on DIRECTLY_IMPORTS Edges

Loaded in `loadImportsToNeo4j()` (loader.ts:310-339):

| Neo4j Property    | Source (DirectlyImportsEdge field) | Type        |
|-------------------|------------------------------------|-------------|
| `import_kind`     | `di.importKind`                    | string      |
| `alias`           | `di.alias`                         | string/null |
| `resolved_type`   | `di.resolvedType`                  | string/null |

---

## MISMATCH DETECTION: Phase 5 vs. Phase 6 Plan

### MISMATCH 1 (CRITICAL): `type_errors` NOT in Neo4j

**Plan says (Contract 8):**
> `SET fn.type_errors = s.type_errors`

**Actual:** The loader does NOT write `type_errors` to Neo4j. The `ParsedSymbol.typeErrors` field is populated in memory by `attachDiagnostics()`, but `loadSymbolsToNeo4j()` does not include it in the batch object or the SET clause.

**Impact on Phase 6:**
- `get_type_info` (Contract 11) queries `sym.type_errors` -- this will always return null.
- `get_symbol` (Contract 12) references `sym.type_errors?.length` -- will always be falsy.
- `trace_error` (Contract 13) intends to show type error context -- no data available.

**Fix options:**
1. Add `type_errors` to the loader's Function node SET clause (requires serializing the object array -- Neo4j can store lists of strings but not lists of objects, so it would need JSON.stringify or separate properties).
2. Store as `type_error_codes: string[]` and `type_error_messages: string[]` parallel arrays.
3. Store as a single `type_errors_json: string` property (JSON stringified).

**Recommendation:** Option 3 is simplest. Add to loader.ts Function batch:
```ts
type_errors_json: s.typeErrors ? JSON.stringify(s.typeErrors) : null,
```
And in the SET clause: `fn.type_errors_json = s.type_errors_json`
MCP tools parse it back with `JSON.parse()`.

### MISMATCH 2 (MODERATE): `get_symbol` query does not return type properties

**Plan says (Contract 12):**
> Add to RETURN clause: `sym.resolved_signature, sym.param_types, sym.return_type, sym.type_errors`

**Actual (`get_symbol` in index.ts:307-313 / 322-326):** The RETURN clause is:
```cypher
RETURN sym.name AS name, labels(sym)[0] AS kind,
       sym.signature AS signature, sym.docstring AS docstring,
       sym.start_line AS start_line, sym.end_line AS end_line,
       f.path AS file_path,
       collect(DISTINCT {caller: caller.name, file: cf.path}) AS callers,
       collect(DISTINCT importer.path) AS imported_by,
       collect(DISTINCT {file: directImporter.path, kind: di.import_kind, alias: di.alias}) AS directly_imported_by
```

Missing from RETURN: `sym.resolved_signature`, `sym.param_types`, `sym.return_type`, `sym.is_generic`, `sym.type_params`.

Also, the callers `collect()` does not include CALLS edge properties (`c.arg_types`, `c.has_type_mismatch`). The current query uses `[:CALLS]` without binding the relationship to a variable, so it can't access edge properties.

**Fix for Phase 6:** Add type fields to RETURN and bind the CALLS relationship:
```cypher
OPTIONAL MATCH (caller:Function)-[c:CALLS]->(sym)
...
collect(DISTINCT {caller: caller.name, file: cf.path, arg_types: c.arg_types, has_mismatch: c.has_type_mismatch}) AS callers
```
And add to RETURN: `sym.resolved_signature, sym.param_types, sym.return_type, sym.is_generic, sym.type_params`

### MISMATCH 3 (MODERATE): `trace_error` callers query lacks type data

**Plan says (Contract 13):**
> Modified callers query returns `c.arg_types, c.has_type_mismatch, c.type_mismatch_detail`
> Also show containing function's `resolved_signature`, `param_types`, `return_type`

**Actual (runtime-tools.ts:422-428, 441-443):**

Containing function query returns:
```cypher
fn.name, fn.signature, fn.docstring, fn.start_line, fn.end_line
```
Missing: `fn.resolved_signature`, `fn.param_types`, `fn.return_type`

Callers query returns:
```cypher
caller.name, f.path, caller.start_line
```
Missing: `c.arg_types`, `c.has_type_mismatch`, `c.type_mismatch_detail`

The callers query also does not bind the CALLS relationship variable. Current Cypher:
```cypher
MATCH (fn:Function {name: $fnName})<-[:CALLS]-(caller:Function)<-[:CONTAINS]-(f:File)
```
Needs to become:
```cypher
MATCH (fn:Function {name: $fnName})<-[c:CALLS]-(caller:Function)<-[:CONTAINS]-(f:File)
```

### MISMATCH 4 (MINOR): `get_dependencies` lacks type data on edges

**Plan says (Phase 6 checklist):**
> Include `resolved_type` on DIRECTLY_IMPORTS edges in response
> Include `arg_types` on CALLS edges when direction="in"

**Actual (index.ts:420-490):**
- The `direction=in` query fetches DIRECTLY_IMPORTS edges but does NOT return `di.resolved_type`.
- There is no CALLS edge query at all in `get_dependencies`. When `direction=in`, it only shows file-level IMPORTS and symbol-level DIRECTLY_IMPORTS, not CALLS edges.

### MISMATCH 5 (MINOR): `trace_imports` lacks `resolved_type`

**Plan says (Phase 6 checklist):**
> Include `resolved_type` on DIRECTLY_IMPORTS edges in response

**Actual (index.ts:531-543):**
The direct import queries in `trace_imports` return `di.import_kind` and `di.alias` but NOT `di.resolved_type`.

### NO MISMATCH: Property naming convention

Neo4j properties use `snake_case` consistently: `resolved_signature`, `param_types`, `return_type`, `is_generic`, `type_params`, `call_site_line`, `arg_types`, `has_type_mismatch`, `type_mismatch_detail`, `resolved_type`, `import_kind`.

TypeScript fields on `ParsedSymbol` use `camelCase` (`resolvedSignature`, `paramTypes`, etc.) and the loader correctly maps them to `snake_case` Neo4j properties. No naming mismatch.

### NO MISMATCH: CALLS edge MERGE pattern

The plan (Contract 7) used `MATCH (caller:Function ...)` but the implementation correctly broadened to `WHERE caller:Function OR caller:Class`. The `get_type_info` Cypher in Contract 11 specifically queries `sym:Function` which is correct since type signatures are primarily on functions. However, Phase 6 implementers should be aware that CALLS edges can also originate from Class nodes (constructors).

---

## Phase 6 IMPLEMENTATION GUIDE

### New Tool: `get_type_info`

Required Cypher (adjusted from plan Contract 11 to match actual Neo4j schema):

```cypher
MATCH (f:File)-[:CONTAINS]->(sym:Function {name: $name})
WHERE ($file IS NULL OR f.path = $file)
  AND ($repo IS NULL OR f.repo_url = $repo)
OPTIONAL MATCH (caller)-[c:CALLS]->(sym)
WHERE caller:Function OR caller:Class
OPTIONAL MATCH (cf:File)-[:CONTAINS]->(caller)
RETURN sym.name AS name, sym.resolved_signature AS resolved_signature,
       sym.param_types AS param_types, sym.return_type AS return_type,
       sym.is_generic AS is_generic, sym.type_params AS type_params,
       sym.type_errors_json AS type_errors_json,
       f.path AS file_path, sym.start_line AS start_line,
       CASE WHEN $includeCallers THEN
         collect(DISTINCT {
           caller: caller.name, file: cf.path,
           arg_types: c.arg_types,
           has_mismatch: c.has_type_mismatch,
           mismatch_detail: c.type_mismatch_detail
         })
       ELSE [] END AS callers
```

**Note:** `type_errors_json` requires the loader fix from Mismatch 1 above. If that fix is deferred, query `type_errors` but expect null.

### Existing Tool Modifications Summary

| Tool | What to add |
|------|-------------|
| `get_symbol` | Add `sym.resolved_signature`, `sym.param_types`, `sym.return_type`, `sym.is_generic`, `sym.type_params` to RETURN. Bind CALLS rel as `c` and add `c.arg_types`, `c.has_type_mismatch` to callers collect. Append type info to response text. |
| `get_dependencies` | Add `di.resolved_type` to DIRECTLY_IMPORTS query return. Add a CALLS edge query for `direction=in`. |
| `trace_error` | Add `fn.resolved_signature`, `fn.param_types`, `fn.return_type` to containing function query. Bind CALLS rel as `c`, add `c.arg_types`, `c.has_type_mismatch`, `c.type_mismatch_detail` to callers query. Format mismatch detail in response. |
| `trace_imports` | Add `di.resolved_type` to direct import query return. Show in response output. |

---

## Phase 7 TESTING CONSIDERATIONS

### Data Availability
- Tests must run a full digest with SCIP on a TS fixture repo to populate type properties.
- Without `scip-typescript` installed, all SCIP-related tests will get `skipped: true` -- need to mock or ensure the binary is available in CI.

### type_errors Gap
- Until Mismatch 1 is fixed, integration tests for `get_type_info` and `get_symbol` showing type errors will fail. Tests should either:
  - Assert `type_errors` is null (documenting the gap), or
  - Be written after the loader fix.

### CALLS Edge Scope
- CALLS edges connect `Function|Class` to `Function|Class`, not just `Function` to `Function`. Tests should include a case where a class constructor calls a function.

### Callers query scope issue in trace_error
- The current callers query in `trace_error` matches `{name: $fnName}` without scoping to a file or repo. If two functions have the same name in different files, the query returns callers for all of them. Phase 6 should consider scoping: `MATCH (fn:Function {name: $fnName, file_path: $filePath})`. This is a pre-existing issue, not introduced by Phase 5.

---

## BLOCKERS FOR PHASE 6

1. **Must fix before Phase 6:** `type_errors` not written to Neo4j (Mismatch 1). This is a loader.ts change -- add serialization of `typeErrors` to the Function node batch and SET clause.

2. **No other blockers.** All other type properties (`resolved_signature`, `param_types`, `return_type`, `is_generic`, `type_params`) are correctly stored. CALLS edges with `arg_types`, `has_type_mismatch`, `type_mismatch_detail` are correctly stored. `resolved_type` on DIRECTLY_IMPORTS is correctly stored.
