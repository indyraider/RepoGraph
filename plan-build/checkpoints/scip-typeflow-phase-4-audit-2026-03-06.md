# Phase 4 Dependency Audit
**Phase:** CALLS Edge Extraction & Edge Enrichment
**Date:** 2026-03-06
**Status:** ISSUES FOUND

## Verified Connections

### 1. extractCallsEdges — Occurrence Filtering (PASS)
**Trace:** `calls-extractor.ts:33-34` filters using bitwise AND:
```ts
if (occ.symbolRoles & SymbolRole.Definition) continue;
if (occ.symbolRoles & SymbolRole.Import) continue;
```
`SymbolRole` is imported from `parser.ts:60-65` where `Definition = 1, Import = 2`. The bitwise check correctly filters out definition and import occurrences, leaving only references (call sites). Verified against `ScipOccurrence.symbolRoles` (parser.ts:33) which is a `number` bitmask.

### 2. extractCallsEdges — findContainingFunction Arguments (PASS)
**Trace:** `calls-extractor.ts:44-48` calls `findContainingFunction(containingIdx, doc.relativePath, occ.range[0])`.
- `containingIdx` is built by `buildContainingFunctionIndex(parsedSymbols, repoPath)` (symbol-table.ts:87-110), keyed by relative path.
- `doc.relativePath` is the SCIP document's relative path (parser.ts:85).
- `occ.range[0]` is 0-indexed line number from SCIP.
- `findContainingFunction` (symbol-table.ts:116-138) accepts `line: number` documented as "0-indexed (SCIP convention)" and converts to 1-indexed on line 125: `const line1 = line + 1`. This is correct since `ParsedSymbol.startLine/endLine` are 1-indexed (parser.ts:155 uses `node.startPosition.row + 1`).

### 3. extractCallsEdges — Dedup Key (PASS)
**Trace:** `calls-extractor.ts:66`:
```ts
const dedupKey = `${callerRelPath}::${caller.name}->${calleeRelPath}::${target.parsed.name}@${callSiteLine}`;
```
Includes caller file+name, callee file+name, and 1-indexed call site line. This prevents duplicate edges from multiple SCIP occurrences referring to the same symbol on the same line (e.g., type annotations alongside call references). The `Set<string>` on line 28 tracks seen keys.

### 4. extractCallsEdges — Line Number Conversion (PASS)
**Trace:** `calls-extractor.ts:65`: `const callSiteLine = occ.range[0] + 1` converts from 0-indexed (SCIP) to 1-indexed for the `CallsEdge.callSiteLine` property, which will be stored in Neo4j per Contract 7.

### 5. CallsEdge Interface Alignment (PASS)
**Trace:** `calls-extractor.ts:70-76` pushes an object with `callerFilePath, callerName, calleeFilePath, calleeName, callSiteLine`. The `CallsEdge` interface (types.ts:15-24) defines exactly these required fields plus optional `argTypes`, `hasTypeMismatch`, `typeMismatchDetail`. The pushed object matches.

### 6. enrichDirectImports — Symbol Table Lookup (PASS)
**Trace:** `edge-enricher.ts:59-67` builds a lookup from `"relPath::name"` to signature text. `entry.parsed.filePath` is a relative path (from `ScannedFile.path` which is documented as "relative path within repo" in scanner.ts:7). `edge-enricher.ts:73` constructs the same key format `"${edge.targetFilePath}::${edge.targetSymbolName}"`. `DirectlyImportsEdge.targetFilePath` is also relative (set in resolver.ts from `terminalPath`/`resolvedPath` which comes from `path.relative(repoPath, ...)` in `resolveRelativePath`). Keys match.

### 7. enrichDirectImports — resolvedType Assignment (PASS)
**Trace:** `edge-enricher.ts:71` skips edges that already have `resolvedType`. Line 76 sets `edge.resolvedType = sig` where `sig` is `entry.scip.signatureText` (type `string | null`, filtered by truthiness on line 65). `DirectlyImportsEdge.resolvedType` (resolver.ts:32) is `string | undefined`. Assigning a `string` to `string | undefined` is valid.

### 8. Symbol Table Key Consistency (PASS)
**Trace:** In `buildSymbolTable` (symbol-table.ts:57), entries are keyed by `scipSym.symbol` (the full SCIP symbol identifier string). In `calls-extractor.ts:37`, occurrences are looked up via `symbolTable.get(occ.symbol)` where `occ.symbol` is the same SCIP symbol identifier. These are the same namespace.

### 9. Self-Call (Recursive) Handling (PASS)
**Trace:** `calls-extractor.ts:52`: `if (caller === target.parsed) continue;` uses reference equality. Both `caller` and `target.parsed` point to objects from the same `parsedSymbols` array (caller via `findContainingFunction` which returns entries from the index built from `parsedSymbols`; target via `symbolTable.get()` which stores `ParsedSymbol` references from the same array). Reference equality is correct.

### 10. Module-Level Call Handling (PASS)
**Trace:** `calls-extractor.ts:49`: `if (!caller) continue;` skips occurrences where `findContainingFunction` returns `null`. This correctly handles module-level calls (no enclosing function) by skipping them, as documented: "module-level call -- skip for v1".

### 11. External Dependency Handling (PASS)
**Trace:** `calls-extractor.ts:38`: `if (!target) continue;` skips occurrences whose symbol is not in the symbol table. External dependencies (npm packages, Node builtins) would not have entries in the symbol table since `buildSymbolTable` only matches against local `parsedSymbols`. These calls are silently skipped.

### 12. Class Method CALLS Edges (PASS)
**Trace:** When SCIP reports a reference to `ClassName#method`, `buildSymbolTable` (symbol-table.ts:60) tries the key `"${parsed.filePath}::${parsed.containerName}.${parsed.name}"`. Tree-sitter stores class methods as `"ClassName.methodName"` (parser.ts:183). The `.` convention matches the `containerName.name` join. The symbol table entry's `parsed.kind` is `"function"` for methods, passing the filter at calls-extractor.ts:41.

## Broken Chains

### CRITICAL: enrichCallsEdges Is a Complete No-Op
**File:** `edge-enricher.ts:13-43`
**Problem:** The function checks `edge.argTypes` (line 37) to detect arity mismatches, but `argTypes` is **never populated** on any `CallsEdge`. The `extractCallsEdges` function (calls-extractor.ts:70-76) does not set `argTypes` when creating edges. There is no other code path that sets it.

**Impact:** `hasTypeMismatch` and `typeMismatchDetail` will never be set on any `CallsEdge`. The type mismatch detection promised by the plan (Contract 10) is entirely non-functional. Neo4j CALLS edges will never have `has_type_mismatch` or `type_mismatch_detail` properties. The `trace_error` MCP tool's type mismatch context (Contract 13) will always be empty.

**Plan says (Contract 10):** "Use SCIP diagnostics at call site as authoritative mismatch signal." The current implementation does NOT use diagnostics at all -- it only attempts arity comparison on `argTypes` which are never populated.

**Fix required:** Either:
1. Populate `argTypes` in `extractCallsEdges` by examining the SCIP occurrence context (overrideDocumentation or related occurrences), OR
2. Implement the plan's stated approach: cross-reference SCIP diagnostics at call site lines against CALLS edges to attach mismatch info.

### MISSING: diagnostics.ts Not Created
**File:** `packages/backend/src/pipeline/scip/diagnostics.ts` (does not exist)
**Problem:** The Phase 4 checklist specifies creating `scip/diagnostics.ts` with `collectDiagnostics(scipDiagnostics, symbolTable) -> DiagnosticInfo[]`. This file was not created. The diagnostic functionality exists in `node-enricher.ts` as `attachDiagnostics` instead.

**Impact:** Low -- the functionality exists but in a different file than planned. However, this deviation means `enrichCallsEdges` cannot easily access diagnostics to implement the plan's stated mismatch detection approach (using SCIP diagnostics at call sites). The `attachDiagnostics` function in node-enricher.ts stores diagnostics on `ParsedSymbol.typeErrors` but does not correlate them with CALLS edges.

## Edge Case Issues

### 1. Dead repoPrefix Stripping in calls-extractor.ts (LOW)
**File:** `calls-extractor.ts:55-62`
**Problem:** The code strips `repoPrefix` from `caller.filePath` and `target.parsed.filePath`. However, `ParsedSymbol.filePath` is already a relative path (set from `ScannedFile.path` which is "relative path within repo" per scanner.ts:7). The `startsWith(repoPrefix)` check will always be false. This stripping logic is dead code.

**Impact:** No functional impact -- paths pass through unchanged, which is correct. But it's misleading code that suggests paths might be absolute when they never are.

### 2. Dead repoPrefix Stripping in enrichDirectImports (LOW)
**File:** `edge-enricher.ts:61-63`
**Same issue:** `entry.parsed.filePath` is already relative. The `startsWith(repoPrefix)` check is always false. The `repoPath` parameter to `enrichDirectImports` is unused in practice.

### 3. Dead repoPrefix Stripping in buildContainingFunctionIndex (LOW)
**File:** `symbol-table.ts:96-98`
**Same issue:** `sym.filePath` is already relative. The stripping logic never triggers.

### 4. SCIP relativePath vs ParsedSymbol.filePath Assumption
**File:** `calls-extractor.ts:46` uses `doc.relativePath` to look up the containing function index.
**Risk:** The SCIP document's `relative_path` (set from `doc.relative_path` in parser.ts:85) must exactly match the relative paths used as keys in `buildContainingFunctionIndex`. Both are relative to the repo root, but subtle differences (e.g., leading `./`, normalized separators) could cause lookup failures. The SCIP `relative_path` comes from `scip-typescript` which uses the TypeScript compiler's path representation.

**Impact:** If paths don't match, `findContainingFunction` returns `null` and the occurrence is silently skipped. No crash, but missing CALLS edges. This should be validated with a real SCIP index.

### 5. enrichCallsEdges Uses Raw filePath for Lookup Key
**File:** `edge-enricher.ts:20-21`
**Note:** The lookup key uses `entry.parsed.filePath` directly (no prefix stripping). Since both `entry.parsed.filePath` and `edge.calleeFilePath` are relative paths, this is consistent. Not a bug, but worth documenting that this function assumes all paths in both the symbol table and CALLS edges are in the same format.

## Stubs and Placeholders

- **No TODO/FIXME comments** found in either `calls-extractor.ts` or `edge-enricher.ts`.
- **No hardcoded return values** -- both files return computed results.
- **enrichCallsEdges is functionally a stub** -- while it's not marked as such, the mismatch detection logic can never trigger because its input (`edge.argTypes`) is never populated.

## Summary

Phase 4 has one critical issue: the `enrichCallsEdges` function is effectively a no-op because `argTypes` is never populated on `CallsEdge` objects by `extractCallsEdges`. The CALLS edge extraction itself (`extractCallsEdges`) is well-implemented -- it correctly filters occurrences, converts line numbers, deduplicates, handles self-calls, module-level calls, and external dependencies. The `enrichDirectImports` function correctly matches import edges to symbol table entries and attaches resolved type signatures. However, the plan's primary value proposition for this phase -- type mismatch detection on CALLS edges via SCIP diagnostics (Contract 10) -- is entirely non-functional. The plan explicitly states "Use SCIP diagnostics at call site as the authoritative mismatch signal" but the implementation neither accesses diagnostics nor has any pathway to populate `argTypes`. Additionally, the planned `diagnostics.ts` file was not created as a separate module (its functionality was folded into `node-enricher.ts` in Phase 3). The three instances of dead `repoPrefix` stripping code are cosmetic issues. Before proceeding to Phase 5 (pipeline integration), the `enrichCallsEdges` function must be reworked to either populate `argTypes` from SCIP data or implement diagnostic-based mismatch detection as the plan specifies.
