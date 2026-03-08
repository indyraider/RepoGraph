# RepoGraph — Feature Add-On PRD: Type Flow via TypeScript Compiler API

**Add-On To:** RepoGraph v1.0 PRD  
**Version:** 1.0  
**Date:** March 6, 2026  
**Status:** Draft  
**Phase:** 4 Extension  
**Depends On:** Name Resolution PRD (Phase 2 Extension), Type Flow via SCIP PRD (Phase 3 Extension)

---

## 1. Overview

Type flow via the TypeScript Compiler API is the deep integration layer that sits beneath SCIP. Where SCIP gives RepoGraph ground-truth type information by running `scip-typescript` as a subprocess and ingesting its output, the Compiler API gives RepoGraph direct, programmatic access to the same type checker that powers VS Code, ESLint, and every serious TypeScript tooling in existence.

The practical difference is control and depth. SCIP gives you what the indexer decided to emit. The Compiler API gives you everything — the ability to ask arbitrary questions of the type checker at any point in the graph, resolve types that SCIP did not surface, evaluate type assignability on demand, and catch categories of type error that a pre-computed index cannot express.

This feature is not a replacement for SCIP. It is a complement that fills the gaps SCIP leaves — complex generic resolution, on-demand assignability checks, conditional type evaluation, and type narrowing within function bodies. SCIP is the fast, broad pass. The Compiler API is the deep, precise pass for cases SCIP cannot handle.

---

## 2. Problem Statement

SCIP covers the majority of type information RepoGraph needs. But three categories of TypeScript code routinely defeat what a pre-computed index can express:

**Deep generic chains.** TypeScript utility types — `ReturnType<typeof fn>`, `Parameters<typeof fn>`, `Awaited<Promise<T>>`, deeply nested `Partial<Required<Pick<T, K>>>` — produce resolved types that SCIP emits as opaque strings. Claude Code sees `Partial<Required<Pick<Order, "amount" | "currency">>>` when it needs to see `{ amount?: number; currency?: string }`. The Compiler API can fully expand these chains.

**Conditional types and type narrowing.** A function that accepts `string | null` and returns different types depending on which branch executes has behaviour that a static index snapshot cannot capture. The Compiler API can evaluate type narrowing within specific branches — so Claude knows not just what enters a function but what type a variable has at any given line inside it.

**On-demand assignability.** SCIP flags type errors the compiler detected during indexing. It cannot answer the question "if I pass this new value here, would that be a type error?" — which is exactly what Claude Code needs when generating or modifying code. The Compiler API can answer assignability questions programmatically at query time, without a re-digest.

The downstream effect is that SCIP enrichment tells Claude what is wrong now. The Compiler API tells Claude what would be wrong if it made a given change — the difference between a tool that explains bugs and a tool that prevents them.

---

## 3. Goals & Non-Goals

### 3.1 Goals

1. Instantiate a TypeScript Compiler API `Program` against the cloned repo at digest time, after SCIP has run.
2. Use the type checker to fully expand complex generic types that SCIP emitted as opaque strings, storing the expanded form on graph nodes.
3. Annotate function body type narrowing — the resolved type of key variables at specific lines within a function — on `Function` nodes.
4. Expose an on-demand assignability check through a new MCP tool that Claude Code can call at query time without triggering a full re-digest.
5. Enrich `CALLS` edges with fully expanded argument types where SCIP stored opaque generic strings.
6. Run only on TypeScript files and only in repos where a valid `tsconfig.json` exists — fail open for all others.
7. Treat SCIP enrichment as the baseline — the Compiler API fills gaps and expands what SCIP could not resolve, never overwrites SCIP data that is already present and accurate.

### 3.2 Non-Goals

- Replacing SCIP. SCIP runs first, covers the broad case, and is cheaper. The Compiler API fills gaps only.
- Full program execution or runtime type inference. This is static analysis only.
- Supporting languages other than TypeScript. The Compiler API is TypeScript-specific.
- Re-implementing a type checker. The goal is to consume the existing checker's output, not reproduce its logic.
- Continuous incremental compilation. The Compiler API runs once per digest, not on every file save.

---

## 4. How the Compiler API Fits the Existing Pipeline

After SCIP and name resolution, the pipeline is:

```
Clone → Scan → Parse → Type-check (SCIP) → Resolve → Deps → Load
```

The Compiler API runs as a second pass within the Type-check stage, after SCIP has completed:

```
Clone → Scan → Parse → Type-check
                           ├── Pass 1: SCIP (broad, fast)
                           └── Pass 2: Compiler API (deep, targeted)
                       → Resolve → Deps → Load
```

Pass 2 is targeted — it only invokes the Compiler API on nodes where SCIP left gaps. It does not re-process nodes that SCIP resolved cleanly.

---

## 5. Technical Specification

### 5.1 Program Instantiation

The Compiler API integration creates a single `ts.Program` instance at the start of Pass 2 and reuses it for all queries within that digest run.

```typescript
import ts from 'typescript'

const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json')
const config = ts.readConfigFile(configPath, ts.sys.readFile)
const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot)

const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options)
const checker = program.getTypeChecker()
```

The `checker` object is the primary interface for all type queries. It is stateless and safe to reuse across files within a single digest run. A new `Program` is created for each digest — programs are not cached across digest runs because the file tree may have changed.

### 5.2 Gap Detection

Before invoking the Compiler API on any node, the SCIP enrichment data is inspected to determine whether a gap exists. A node has a gap if any of the following are true:

- `resolved_signature` contains an unexpanded generic string (detected by presence of utility type keywords combined with `<` characters)
- `param_types` contains one or more entries that are generic utility type expressions rather than concrete types
- `return_type` is a conditional type expression (`T extends U ? V : W`)
- `type_errors` is empty but the function contains a known narrowing pattern in the AST

Nodes without gaps are skipped entirely. The Compiler API is only invoked where it adds information SCIP did not provide.

### 5.3 Generic Type Expansion

For each node with an unexpanded generic in its type properties, the Compiler API resolves the fully expanded concrete type:

```typescript
const symbol = checker.getSymbolAtLocation(node)
const type = checker.getTypeOfSymbolAtLocation(symbol, node)
const expandedType = checker.typeToString(
  type,
  undefined,
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias
)
```

The expanded string replaces the opaque generic in the node's `resolved_signature` property. The original SCIP string is preserved in a `scip_signature` property for reference.

### 5.4 Type Narrowing Annotation

For functions that contain null checks, type guard calls, or discriminated union switches, the Compiler API extracts the narrowed type of key variables at specific lines within the function body. These are stored as a `narrowing_annotations` array on the `Function` node:

```json
[
  { "line": 134, "variable": "order", "narrowed_type": "Order" },
  { "line": 141, "variable": "order", "narrowed_type": "Order | null" }
]
```

This allows Claude Code to answer "at the line where the error occurred, what type did the compiler believe this variable was?" — the question that `trace_error` needs to give a complete explanation of a TypeError.

### 5.5 New MCP Tool: `check_assignability`

| Parameter | Type | Description |
|---|---|---|
| `source_type` | string | The type being assigned from (e.g. `Order \| null`) |
| `target_type` | string | The type being assigned to (e.g. `Order`) |
| `repo` | string | Repository identifier |
| `context_file` | string | File path for resolving type names in context |

Returns `{ assignable: bool, error?: string }`. This tool does not require a re-digest. It uses the cached `Program` to evaluate assignability on demand and returns in under 200ms for most type pairs. It is the primary tool Claude Code uses when generating new code to verify that a proposed argument is type-safe before writing it.

### 5.6 Updated Graph Schema

The Compiler API adds properties to existing nodes only. No new node labels or relationship types are introduced.

**Updated `Function` node properties:**

| Property | Type | Description |
|---|---|---|
| `resolved_signature` | string | Expanded by Compiler API where SCIP left a generic (updated) |
| `param_types` | string[] | Fully expanded concrete types per parameter (updated) |
| `return_type` | string | Fully expanded concrete return type (updated) |
| `narrowing_annotations` | object[] | Per-line narrowed types for key variables within the function body (new) |
| `scip_signature` | string | Original SCIP signature preserved for reference (new) |

**Updated `CALLS` edge properties:**

| Property | Type | Description |
|---|---|---|
| `arg_types` | string[] | Expanded concrete argument types where SCIP had generics (updated) |
| `has_type_mismatch` | bool | Re-evaluated with expanded types where SCIP was ambiguous (updated) |

### 5.7 Incremental Re-Digest Behaviour

The Compiler API pass runs only on files where SCIP detected gaps on the previous digest and the file's content hash has changed, or where gaps were flagged as unresolved on the last run. Files where SCIP resolved cleanly and whose content has not changed are skipped entirely.

The `ts.Program` is constructed once per digest run regardless of how many files are processed — program construction is expensive, individual type queries are fast.

### 5.8 Error Handling

| Failure | Handling |
|---|---|
| `tsconfig.json` not found | Skip Compiler API pass entirely, log warning, continue |
| `ts.createProgram` throws | Log error, skip pass, continue with SCIP data |
| Type checker returns `any` for a gap node | Store `any`, flag `compiler_api_unresolved: true`, continue |
| Narrowing annotation extraction fails | Skip narrowing for that function, continue |
| Assignability tool called without cached Program | Reconstruct Program on demand, log latency warning |

---

## 6. Impact on MCP Tools

**`get_symbol`** — `resolved_signature`, `param_types`, and `return_type` now contain fully expanded concrete types rather than opaque generic strings. Claude can read the actual shape of a type without chasing down utility type definitions.

**`get_type_info`** — gains `narrowing_annotations` in its response. Claude can answer "what type did the compiler believe this variable was at the line where the error occurred."

**`trace_error`** — the highest-value improvement. When assembling error context, `trace_error` now includes the narrowed type of the erroring variable at the exact error line, the expanded type of the argument that was passed, and the expanded type of the parameter that expected it. This is a complete, compiler-verified explanation of why the TypeError occurred.

**`check_assignability`** — new tool. Used by Claude Code when generating or modifying code to verify type compatibility before writing changes.

---

## 7. Implementation Plan

### 7.1 Subtasks

| Subtask | Implementation | Validation |
|---|---|---|
| Program factory module | 2 hours | 30 minutes |
| Gap detector | 2 hours | 1 hour |
| Generic expander | 3 hours | 2 hours |
| Narrowing annotator | 4 hours | 3 hours |
| `check_assignability` MCP tool | 2 hours | 1 hour |
| Neo4j write integration | 2 hours | 1 hour |
| **Total** | **~15 hours** | **~8.5 hours** |

Approximately **3–4 focused days** end-to-end. The narrowing annotator is the highest-risk subtask and should be implemented and validated before the others are integrated.

---

## 8. Testing Strategy

### 8.1 Unit Tests

- **Program factory:** valid tsconfig, missing tsconfig, malformed tsconfig, tsconfig with project references.
- **Gap detector:** clean SCIP node (no gap), opaque generic, conditional return type, narrowing pattern in body.
- **Generic expander:** `ReturnType<typeof fn>`, `Partial<T>`, `Pick<T, K>`, deeply nested utility types, circular type references.
- **Narrowing annotator:** simple null check, type guard function, discriminated union, nested conditionals, early return pattern.
- **Assignability tool:** assignable pair, non-assignable pair, `any` source, `never` target, union types.

### 8.2 Integration Test Repos

**Fixture G — generic-heavy repo.** A synthetic repo with extensive utility type usage. Every key function uses `ReturnType`, `Parameters`, `Awaited`, or custom mapped types. Validates that expanded types are concrete and accurate after the Compiler API pass.

**Fixture H — narrowing-heavy repo.** A repo with deliberate null-safety patterns: optional chaining, null guards, type guards, discriminated unions. Validates that `narrowing_annotations` correctly record the narrowed type at each branch point.

**Fixture I — mixed strict/non-strict.** A repo with some files in strict mode and some without. Validates that gap detection and expansion behave correctly across different compiler settings within the same project.

### 8.3 Acceptance Criteria

- All opaque generic type strings in Fixture G are expanded to concrete types after the Compiler API pass.
- `narrowing_annotations` in Fixture H correctly identify the narrowed type at each null-check line.
- `check_assignability` returns correct results for 20 hand-verified type pairs from the target codebase.
- `trace_error` responses include narrowed type context when the Compiler API pass has run.
- Compiler API pass adds less than 40% to total digest time on a repo of 5,000 TypeScript files.
- Zero digests fail due to Compiler API errors — all failures are flagged and SCIP data is preserved.

---

## 9. Performance Considerations

The TypeScript Compiler API is the most expensive stage in the pipeline because it invokes a full type-check of the entire project.

- **Single Program construction per digest.** The `ts.Program` is constructed once and reused. Never construct multiple programs in a single digest.
- **Process only gap nodes.** On a well-typed codebase where SCIP resolves cleanly, the Compiler API may process fewer than 10% of nodes.
- **Memory limit.** Set `--max-old-space-size=6144` on the Node.js process for large repos. Make this configurable.
- **Async execution.** Like SCIP, run asynchronously on repos where the pass takes more than 60 seconds.
- **Skip on non-TS changes.** If the Scan diff shows no TypeScript file changes, skip the pass entirely and reuse cached results.

---

## 10. Success Criteria

1. All opaque generic type strings from SCIP are expanded to concrete types on `Function` nodes in the target codebase.
2. `narrowing_annotations` are present on functions containing null checks or type guards, and correctly reflect the compiler's narrowed type at each point.
3. `trace_error` can explain a TypeError in terms of the narrowed type at the error line — not just the declared parameter type.
4. `check_assignability` returns accurate results for arbitrary type pairs from the target codebase without requiring a re-digest.
5. All Compiler API failures are surfaced in `digest_jobs.stats` with SCIP data preserved intact.
6. Digest time increase from the Compiler API pass is within the 40% target on the target repo.

---

## 11. Decision Map

### 11.1 Before the Compiler API Pass Runs

**Did SCIP complete successfully?**
Yes → run gap detection and proceed. No → skip the Compiler API pass entirely. The Compiler API is a gap-filler, not a fallback for SCIP.

**Does a valid `tsconfig.json` exist?**
Yes → construct `ts.Program` from it. No → skip the pass. Unlike SCIP's `--infer-tsconfig` option, the Compiler API requires a valid tsconfig to produce accurate type information.

**Have any TypeScript files changed since the last digest?**
No → skip the pass, reuse cached expanded types and narrowing annotations. Yes → run gap detection to determine the targeted work list.

### 11.2 Gap Detection Decisions

**Does the node's `resolved_signature` contain an unexpanded generic?**
Detected by pattern matching for utility type keywords (`ReturnType`, `Parameters`, `Awaited`, `Partial`, `Required`, `Pick`, `Omit`, `Extract`, `Exclude`) combined with `<` characters. Yes → add to work list. No → skip.

**Is the return type a conditional type expression?**
Detected by presence of the `extends` keyword within the type string. Yes → add to work list.

**Does the function body contain a narrowing pattern?**
Check the Parse stage AST for null checks, type guard calls, or discriminated union switches. Yes → add to narrowing work list.

### 11.3 Program Construction Decisions

**Does the tsconfig have project references?**
Use `ts.createProgram` with `projectReferences` support enabled. If a referenced project cannot be found, log the missing reference and proceed with available files.

**Are there compiler errors in the Program?**
Do not abort. A repo with type errors is exactly the kind of repo that benefits most from this feature. Log the error count to `digest_jobs.stats` and proceed.

### 11.4 Generic Expansion Decisions

**Does the expanded type string exceed a reasonable length?**
Cap at 2,000 characters. Beyond this, store the first 2,000 characters with a `type_truncated: true` flag. A 5,000-character type string is not useful to Claude Code.

**Does the expanded type contain `any`?**
Store as-is with a `contains_any: true` flag. Partial information is still useful.

**Does expansion produce a circular reference?**
If `typeToString` returns a string containing `...` (the compiler's truncation marker), store the truncated string and flag `is_circular_type: true`.

### 11.5 Narrowing Annotation Decisions

**Which variables are worth annotating?**
Only variables that appear in the function's parameter list or are directly assigned from parameters. Do not track every local variable — only variables that appear in known type errors or at decision points where the type actually changes.

**What counts as a narrowing point?**
Record narrowed types at: null/undefined checks, `typeof` checks, `instanceof` checks, type guard calls, and the first line of each branch in a discriminated union switch.

**Does a narrowing annotation conflict with a SCIP diagnostic?**
The Compiler API data takes precedence — it has more context about the specific branch. Log the conflict to `digest_jobs.stats`.

### 11.6 `check_assignability` Tool Decisions

**Should the tool reuse the digest-time Program or construct a new one?**
Reuse the cached Program across all `check_assignability` calls until a new digest runs. Reconstruct only if the cached Program is unavailable.

**What if a type name cannot be resolved in `context_file`?**
Return a structured error indicating the unresolvable type rather than returning an incorrect assignability result.

### 11.7 Decisions Requiring Product Judgment

**Synchronous vs. always-async execution.** Always-async is recommended if digest speed is less important than implementation simplicity. Use a threshold (default 60 seconds) if small repos should block and get type data immediately.

**Expanded type string length limit.** Validate the 2,000 character default against your actual codebase. Lower it if most types are simpler. Raise it only if Claude Code demonstrably needs the full form to reason correctly.

**Narrowing annotation scope.** The recommendation to scope annotations to parameter-derived variables is conservative. Widen only if validation shows Claude Code is missing information it needs for production error explanations.

**`check_assignability` caching.** Cache results keyed on `source_type + target_type + context_file` with a TTL of one digest cycle. Without caching, repeated calls during code generation loops will be slow.
