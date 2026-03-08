# Phase 6 Forward Plan Review
**Phase completed:** MCP Tool Updates
**Date:** 2026-03-06
**Plan updates needed:** YES (minor)

---

## Actual Interfaces Built

### Tool 1: `get_type_info` (NEW — index.ts:752-862)

**Schema (z params):**
| Param | Type | Default | Required |
|---|---|---|---|
| `name` | `z.string()` | — | yes |
| `file` | `z.string().optional()` | — | no |
| `repo` | `z.string().optional()` | — | no |
| `include_callers` | `z.boolean().optional()` | `false` | no |

**Cypher query — Neo4j properties read:**
- `sym.name`, `sym.signature`, `sym.resolved_signature`, `sym.param_types`, `sym.return_type`, `sym.is_generic`, `sym.type_params`
- `f.path`, `sym.start_line`, `sym.end_line`
- `c.call_site_line`, `c.has_type_mismatch`, `c.type_mismatch_detail` (on CALLS edges)
- `caller.name`, `cf.path` (caller nodes)
- Labels filter: `(sym:Function OR sym:Class)`

**Response format (text sections):**
```
## {kind}: {name}
File: {file_path}:{start_line}
Source signature: {signature}
Resolved type: {resolved_signature}  |  "not available (SCIP may not have indexed this symbol)"
Parameter types: {param_types joined by ", "}
Return type: {return_type}
Generic: yes ({type_params joined by ", "})

Callers ({count}):
  - {caller} in {file}:{call_site_line} [warning] TYPE MISMATCH: {mismatch_detail}
```

**Notable:** Does NOT query `sym.type_errors` (plan Contract 11 says it should). See Mismatch 1.

---

### Tool 2: `get_symbol` (MODIFIED — index.ts:270-416)

**Schema (z params):** unchanged from prior phase.
| Param | Type | Default | Required |
|---|---|---|---|
| `name` | `z.string()` | — | yes |
| `kind` | `z.enum(["function","class","type"]).optional()` | — | no |
| `repo` | `z.string().optional()` | — | no |
| `include_source` | `z.boolean().optional()` | `false` | no |

**New Neo4j properties returned (added to RETURN clause):**
- `sym.resolved_signature AS resolved_signature`
- `sym.param_types AS param_types`
- `sym.return_type AS return_type`
- `sym.is_generic AS is_generic`
- `sym.type_params AS type_params`

**Response additions:**
```
Resolved type: {resolved_signature}
Param types: {param_types joined by ", "}
Return type: {return_type}
Generic: yes ({type_params joined by ", "})
```

**Notable:** Does NOT query `sym.type_errors` (plan Contract 12 says it should). Callers section does NOT include `arg_types` or `has_type_mismatch` from CALLS edges — only collects `{caller: caller.name, file: cf.path}`. See Mismatch 2.

---

### Tool 3: `get_dependencies` (MODIFIED — index.ts:419-538)

**Schema (z params):** unchanged.
| Param | Type | Default | Required |
|---|---|---|---|
| `repo` | `z.string().optional()` | — | no |
| `path` | `z.string()` | — | yes |
| `direction` | `z.enum(["in","out","both"]).optional()` | `"both"` | no |

**New queries added (direction="in" or "both"):**

1. **DIRECTLY_IMPORTS with resolved_type** — queries `di.resolved_type AS resolved_type` and displays `:: {resolved_type}` in output. Matches plan.

2. **CALLS outgoing** — new query:
   ```cypher
   MATCH (f:File {path: $path})-[:CONTAINS]->(caller)-[r:CALLS]->(callee)<-[:CONTAINS]-(tf:File)
   WHERE caller:Function OR caller:Class
   RETURN caller.name, callee.name, tf.path, r.call_site_line
   ```
   Format: `{caller_name} -> {callee_name} in {target_file}:{call_line}`

3. **CALLS incoming** — new query:
   ```cypher
   MATCH (sf:File)-[:CONTAINS]->(caller)-[r:CALLS]->(callee)<-[:CONTAINS]-(f:File {path: $path})
   WHERE caller:Function OR caller:Class
   RETURN caller.name, sf.path, callee.name, r.call_site_line
   ```

**Notable:** CALLS edges in `get_dependencies` do NOT include `arg_types` or `has_type_mismatch`. Plan says to include `arg_types` on CALLS when direction="in". See Mismatch 3.

---

### Tool 4: `trace_error` (MODIFIED — runtime-tools.ts:354-539)

**Schema (z params):** unchanged.
| Param | Type | Default | Required |
|---|---|---|---|
| `repo` | `z.string().optional()` | — | no |
| `log_id` | `z.string().optional()` | — | no |
| `stack_trace` | `z.string().optional()` | — | no |

**Containing function query — new Neo4j properties:**
```cypher
RETURN fn.name, fn.signature, fn.docstring, fn.start_line, fn.end_line,
       fn.resolved_signature, fn.param_types, fn.return_type
```

**Containing function response additions:**
```
- **Resolved type:** {resolved_signature}
- **Param types:** {param_types joined by ", "}
- **Return type:** {return_type}
```

**Callers query — new CALLS edge properties:**
```cypher
MATCH (fn:Function {name: $fnName})<-[r:CALLS]-(caller:Function)<-[:CONTAINS]-(f:File)
RETURN caller.name, f.path, caller.start_line,
       r.call_site_line, r.has_type_mismatch, r.type_mismatch_detail
```

**Caller response format:**
```
- {caller_name} in {caller_file}:{call_site_line|caller_line} [warning] TYPE MISMATCH: {type_mismatch_detail}
```

**Direct symbol imports query** — queries `di.resolved_type` on DIRECTLY_IMPORTS edges.

**Notable:** Does NOT query `c.arg_types` from CALLS edges. Plan Contract 13 says callers should show `arg_types`. See Mismatch 4. Does NOT query `sym.type_errors` on the containing function.

---

### Tool 5: `trace_imports` (MODIFIED — index.ts:541-656)

**Schema (z params):** unchanged.

**New Neo4j properties in direct imports query:**
- `di.resolved_type AS resolved_type`

**Response format addition:**
```
{start_path} -> {sym} ({kind}) in {target_file}{alias} :: {resolved_type}
```

Matches plan.

---

## Mismatches with Plan

### Mismatch 1: `get_type_info` missing `type_errors`
- **Plan says (Contract 11):** Query and display `sym.type_errors`: "Type Errors: - TS2345: Argument of type 'null' is not assignable... (line 48)"
- **Code actually:** Does not query `sym.type_errors` at all. Not in RETURN clause, not in response formatting.
- **Downstream impact:** Phase 7 integration test "get_type_info returns correct data" cannot validate type_errors output. Any test that checks for a "Type Errors" section will fail.
- **Plan update:** Either add `sym.type_errors` to the get_type_info query and response, or update the plan to note type_errors are deferred. Recommend adding it — it is a simple addition.

### Mismatch 2: `get_symbol` missing type_errors and CALLS edge type data on callers
- **Plan says (Contract 12):** Include `sym.type_errors` in output, and show `arg_types` + `has_type_mismatch` on callers from CALLS edges.
- **Code actually:** Queries `sym.resolved_signature`, `sym.param_types`, `sym.return_type`, `sym.is_generic`, `sym.type_params` (correct). But does NOT query `sym.type_errors`. The callers collect only `{caller: caller.name, file: cf.path}` — no `c.arg_types` or `c.has_type_mismatch` from CALLS relationships.
- **Downstream impact:** Phase 7 "validate against target codebase: spot-check param_types, has_type_mismatch" — the has_type_mismatch piece is only visible in get_type_info and trace_error, not get_symbol. Tests checking get_symbol for type mismatch data will fail.
- **Plan update:** Amend get_symbol's CALLS callers collect to include `arg_types: c.arg_types, has_mismatch: c.has_type_mismatch` and format them. Add `sym.type_errors` to the RETURN clause and response text.

### Mismatch 3: `get_dependencies` missing arg_types on CALLS edges
- **Plan says (Phase 6 checklist):** "Include arg_types on CALLS edges when direction='in'"
- **Code actually:** CALLS queries return `caller.name`, `callee.name`, `tf.path`, `r.call_site_line` — but NOT `r.arg_types`, `r.has_type_mismatch`, or `r.type_mismatch_detail`.
- **Downstream impact:** Minor — no Phase 7 test explicitly targets get_dependencies CALLS data. But the plan checklist item is unfulfilled.
- **Plan update:** Add `r.arg_types`, `r.has_type_mismatch` to the CALLS queries in get_dependencies, or mark as deferred.

### Mismatch 4: `trace_error` callers missing `arg_types`
- **Plan says (Contract 13):** Callers response should show "Args: [Order | null] <- TYPE MISMATCH: param expects Order, got Order | null"
- **Code actually:** Queries `r.has_type_mismatch` and `r.type_mismatch_detail` (correct), but does NOT query `r.arg_types` (so we cannot show the "Args: [...]" portion). Also does not query `c.arg_types`.
- **Downstream impact:** Phase 7 "trace_error includes type mismatch context" — the test can verify has_type_mismatch and type_mismatch_detail are shown, but cannot verify arg_types are displayed. If the test expects the "Args: [Order | null]" format from the plan, it will fail.
- **Plan update:** Add `r.arg_types` to the trace_error callers query and include it in the response formatting.

### Mismatch 5: Plan Contract 11 callers query uses `$includeCallers` — code uses correct param passing
- **Plan says:** `CASE WHEN $includeCallers THEN collect(...)` with param `$includeCallers`
- **Code actually:** Uses the same pattern, passes `includeCallers: include_callers ?? false` as a query parameter.
- **Status:** MATCH. No issue.

### Mismatch 6: Plan Contract 11 has `$file IS NULL` fallback — code uses separate WHERE clause
- **Plan says:** `WHERE f.path = $file OR $file IS NULL`
- **Code actually:** Builds WHERE clause conditionally: `if (file) conditions.push("f.path = $file")`. Functionally equivalent.
- **Status:** MATCH. No issue — implementation differs but semantics are correct.

---

## Neo4j Properties Queried — Dependency on Loader (Phase 5)

All properties below must exist on Neo4j nodes/edges for MCP tools to return data. Phase 5 (loader) is responsible for writing them.

### Function/Class Node Properties
| Property | Queried by | Written by (plan) |
|---|---|---|
| `resolved_signature` | get_type_info, get_symbol, trace_error | loader SET on Function/Class nodes |
| `param_types` | get_type_info, get_symbol, trace_error | loader SET (string array) |
| `return_type` | get_type_info, get_symbol, trace_error | loader SET |
| `is_generic` | get_type_info, get_symbol | loader SET (boolean) |
| `type_params` | get_type_info, get_symbol | loader SET (string array) |
| `type_errors` | **NOT QUERIED** (should be per plan) | loader SET (array of objects) |

### CALLS Edge Properties
| Property | Queried by | Written by (plan) |
|---|---|---|
| `call_site_line` | get_type_info, get_dependencies, trace_error | loader from CallsEdge.callSiteLine |
| `has_type_mismatch` | get_type_info, trace_error | edge enricher -> loader |
| `type_mismatch_detail` | get_type_info, trace_error | edge enricher -> loader |
| `arg_types` | **NOT QUERIED** (should be per plan) | loader from CallsEdge.argTypes |

### DIRECTLY_IMPORTS Edge Properties
| Property | Queried by | Written by (plan) |
|---|---|---|
| `resolved_type` | get_dependencies, trace_imports, trace_error | loader SET from edge enricher |
| `import_kind` | get_dependencies, trace_imports, get_symbol, trace_error | existing loader (pre-SCIP) |
| `alias` | get_dependencies, trace_imports, get_symbol, trace_error | existing loader (pre-SCIP) |

---

## Hook Points for Phase 7

### Integration test: `get_type_info` returns correct data
**What to call:** Tool `get_type_info` with `{ name: "<fixture function>", include_callers: true }`
**What to assert:**
- Response contains `Resolved type:` line with expected signature
- Response contains `Parameter types:` with correct param types
- Response contains `Return type:` with correct return type
- If generic: `Generic: yes (T, U)` appears
- With `include_callers: true`: caller list appears with `TYPE MISMATCH` annotation on mismatched callers
- **Gap:** Cannot assert `type_errors` section until Mismatch 1 is fixed

### Integration test: `trace_error` includes type mismatch context
**What to call:** Tool `trace_error` with `{ log_id: "<fixture log>" }` or `{ stack_trace: "<fixture stack>" }`
**What to assert:**
- "Containing Function" section includes `Resolved type:`, `Param types:`, `Return type:`
- "Callers" section shows `TYPE MISMATCH: {detail}` for known-mismatched callers
- **Gap:** Cannot assert `Args: [...]` display until Mismatch 4 is fixed (arg_types not queried)

### Validate against target codebase: spot-check param_types, has_type_mismatch
**How:** Run `get_type_info` or `get_symbol` against a digested TypeScript repo
**What to check:**
- `param_types` array is populated for TS functions with typed parameters
- `has_type_mismatch` is `true` on CALLS edges where arg types don't match param types
- `resolved_signature` is populated (vs null for non-SCIP repos)
- **Via get_symbol:** Currently callers section does NOT surface has_type_mismatch (Mismatch 2). Must use `get_type_info` with `include_callers: true` instead, or fix get_symbol.

### Unit test hooks (Neo4j queries to verify in isolation)
```cypher
-- Verify type properties on Function nodes
MATCH (f:Function {name: $name}) RETURN f.resolved_signature, f.param_types, f.return_type, f.is_generic

-- Verify CALLS edges with type mismatch data
MATCH (caller)-[c:CALLS]->(callee {name: $name})
RETURN caller.name, c.arg_types, c.has_type_mismatch, c.type_mismatch_detail

-- Verify resolved_type on DIRECTLY_IMPORTS edges
MATCH (f:File)-[di:DIRECTLY_IMPORTS]->(sym) RETURN di.resolved_type
```

---

## Recommended Plan Updates

### 1. Add `type_errors` to `get_type_info` and `get_symbol` (code fix needed)
Both tools should query `sym.type_errors` and format them in the response. This is a straightforward addition:
- Add `sym.type_errors AS type_errors` to both RETURN clauses
- Add formatting: `Type Errors:\n  - {code}: {message}`

### 2. Add `arg_types` to `trace_error` callers query (code fix needed)
Add `r.arg_types AS arg_types` to the callers RETURN clause in trace_error, and format as `Args: [{arg_types}]` in the caller line.

### 3. Add type data to `get_symbol` callers collect (code fix needed)
Change the callers collect from:
```
collect(DISTINCT {caller: caller.name, file: cf.path})
```
to:
```
collect(DISTINCT {caller: caller.name, file: cf.path, arg_types: c.arg_types, has_mismatch: c.has_type_mismatch})
```
Where `c` is the CALLS relationship variable (note: current query uses `[:CALLS]` without a variable — needs `[c:CALLS]`).

### 4. Add `arg_types` to `get_dependencies` CALLS queries (optional, low priority)
Add `r.arg_types`, `r.has_type_mismatch` to both CALLS queries in get_dependencies for completeness.

### 5. Phase 7 test plan adjustment
If the above code fixes are NOT made before Phase 7:
- Tests for `type_errors` display must be skipped or marked expected-fail
- Tests for `arg_types` display in trace_error must check only `has_type_mismatch` / `type_mismatch_detail`
- Spot-check of `has_type_mismatch` must go through `get_type_info` (not `get_symbol`)
