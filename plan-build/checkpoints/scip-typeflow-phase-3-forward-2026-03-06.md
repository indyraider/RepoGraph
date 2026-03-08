# Phase 3 Forward-Looking Checkpoint

**Date:** 2026-03-06
**Phase completed:** Phase 3 — Symbol Table & Node Enrichment
**Files reviewed:**
- `packages/backend/src/pipeline/scip/symbol-table.ts`
- `packages/backend/src/pipeline/scip/node-enricher.ts`
- `packages/backend/src/pipeline/scip/types.ts` (Phase 1)
- `packages/backend/src/pipeline/scip/parser.ts` (Phase 2)
- `packages/backend/src/pipeline/parser.ts` (ParsedSymbol interface)
- `packages/backend/src/pipeline/resolver.ts` (DirectlyImportsEdge interface)

---

## Exported Interfaces from Phase 3

### symbol-table.ts

```ts
export interface SymbolTableEntry {
  parsed: ParsedSymbol;
  scip: ScipSymbolInfo;
}

export function buildSymbolTable(
  scipDocuments: ScipDocument[],
  parsedSymbols: ParsedSymbol[],
  repoPath: string
): { table: Map<string, SymbolTableEntry>; unmatchedCount: number }

export function buildContainingFunctionIndex(
  parsedSymbols: ParsedSymbol[],
  repoPath: string
): Map<string, ParsedSymbol[]>
// Key: relative file path -> sorted array of function/class ParsedSymbol

export function findContainingFunction(
  index: Map<string, ParsedSymbol[]>,
  relativePath: string,
  line: number  // 0-indexed (SCIP convention)
): ParsedSymbol | null
```

### node-enricher.ts

```ts
export function enrichSymbols(
  table: Map<string, SymbolTableEntry>
): void
// Mutates ParsedSymbol objects in place via table entries.
// Sets: resolvedSignature, paramTypes, returnType, isGeneric, typeParams

export function attachDiagnostics(
  scipDocuments: ScipDocument[],
  table: Map<string, SymbolTableEntry>,
  repoPath: string
): DiagnosticInfo[]
// Attaches typeErrors to ParsedSymbol objects in place.
// Returns flat list of all error-severity diagnostics.
```

---

## Mismatch Detection: Phase 3 vs. Phase 4+ Expectations

### 1. buildSymbolTable() signature — DEVIATION from plan (benign)

**Plan (Contract 4) says:**
```
IN:  scipSymbols: ScipSymbol[], parsedSymbols: ParsedSymbol[]
OUT: Map<string, { parsed: ParsedSymbol, scip: ScipSymbol }>
```

**Actual:**
```ts
IN:  scipDocuments: ScipDocument[], parsedSymbols: ParsedSymbol[], repoPath: string
OUT: { table: Map<string, SymbolTableEntry>; unmatchedCount: number }
```

**Differences:**
- Takes `ScipDocument[]` (which contains per-file `ScipSymbolInfo[]`) instead of a flat `ScipSymbol[]`. This is better — matches the parser output (`ScipIndexData.documents`) directly.
- Takes an extra `repoPath` parameter (needed to convert absolute ParsedSymbol paths to relative).
- Returns a `{ table, unmatchedCount }` wrapper instead of a bare Map.
- Map values use `ScipSymbolInfo` (not `ScipSymbol` — that type doesn't exist; the actual type is `ScipSymbolInfo`).

**Impact on Phase 4:** calls-extractor.ts must destructure the return value (`{ table }`) when importing. The Map key is the SCIP symbol ID string (e.g., `scipSym.symbol`), which is exactly what occurrence `.symbol` fields reference. **This works correctly for occurrence-based lookup.**

**Impact on Phase 5:** index.ts orchestrator must pass `ScipDocument[]` and `repoPath`, not a flat symbol array. Must destructure `{ table, unmatchedCount }`.

**Status: OK — deviations are improvements, not breakages.**

### 2. Symbol table Map key for occurrence lookups — VERIFIED CORRECT

The Map key is set at `symbol-table.ts:57`: `table.set(scipSym.symbol, ...)` where `scipSym.symbol` is the full SCIP symbol ID string. SCIP occurrences carry the same `.symbol` field. Phase 4's calls-extractor can do `symbolTable.get(occurrence.symbol)` to resolve the target. **This is the correct join key.**

### 3. findContainingFunction() and buildContainingFunctionIndex() — READY for Phase 4

Phase 4's calls-extractor needs to determine which function contains a given SCIP occurrence. The plan says (Contract 6):
> "Find which ParsedSymbol (function) the occurrence line falls within (caller: startLine <= occurrenceLine <= endLine)"

**Actual implementation:**
- `buildContainingFunctionIndex(parsedSymbols, repoPath)` builds a `Map<relativePath, ParsedSymbol[]>` sorted by startLine.
- `findContainingFunction(index, relativePath, line)` takes a 0-indexed line (SCIP convention), converts to 1-indexed internally, and finds the innermost containing function.

**Phase 4 usage pattern:**
```ts
import { buildContainingFunctionIndex, findContainingFunction } from "./symbol-table.js";

const containingIdx = buildContainingFunctionIndex(parsedSymbols, repoPath);

for (const occ of occurrences) {
  const caller = findContainingFunction(containingIdx, doc.relativePath, occ.range[0]);
  if (!caller) continue; // module-level call
  const target = symbolTable.get(occ.symbol);
  if (!target) continue; // external call
  // create CallsEdge
}
```

**Status: Signatures are compatible. No issues.**

### 4. enrichSymbols() — Phase 5 compatibility — VERIFIED

Plan says enrichSymbols takes the symbol table Map. Actual signature: `enrichSymbols(table: Map<string, SymbolTableEntry>): void`. **Exact match.**

The function mutates `ParsedSymbol` objects in place by setting: `resolvedSignature`, `paramTypes`, `returnType`, `isGeneric`, `typeParams`. These field names match the `ParsedSymbol` interface extensions in `parser.ts:18-23`. **No mismatch.**

### 5. attachDiagnostics() — Phase 5 compatibility — MINOR DEVIATION

**Plan (Phase 3 checklist) does not mention attachDiagnostics.** The plan lists diagnostics collection under Phase 4 as a separate `scip/diagnostics.ts` file with `collectDiagnostics(scipDiagnostics, symbolTable)`.

**Actual:** Diagnostics are handled in `node-enricher.ts` as `attachDiagnostics(scipDocuments, table, repoPath)`. This consolidates what the plan split into a separate file.

**Impact on Phase 4:** The planned `scip/diagnostics.ts` file may not be needed. Phase 4's edge-enricher still needs diagnostics for type mismatch detection — but `attachDiagnostics()` returns `DiagnosticInfo[]` which can be passed to the edge enricher. **The plan's `collectDiagnostics()` is effectively replaced by `attachDiagnostics()`.**

**Impact on Phase 5:** index.ts orchestrator should call `attachDiagnostics()` from `node-enricher.ts` instead of a separate `diagnostics.ts` module.

**Status: OK — consolidation is fine, but Phase 5 wiring must use the actual location.**

### 6. ParsedSymbol field names — VERIFIED MATCH

Plan uses snake_case (`resolved_signature`, `param_types`, `return_type`, `type_errors`, `is_generic`, `type_params`). Implementation uses camelCase (`resolvedSignature`, `paramTypes`, `returnType`, `typeErrors`, `isGeneric`, `typeParams`). This is the correct TypeScript convention.

The loader (Phase 5) must map camelCase properties to snake_case Neo4j property names in the SET clause. The `CallsEdge` interface in `types.ts` also uses camelCase (`callerFilePath`, `calleeName`, `callSiteLine`, `argTypes`, `hasTypeMismatch`, `typeMismatchDetail`).

**Status: Consistent within TS code. Loader must handle the TS-to-Neo4j naming convention.**

---

## Hook Points for Phase 4: calls-extractor.ts

### Required imports from symbol-table.ts:
```ts
import {
  SymbolTableEntry,
  buildContainingFunctionIndex,
  findContainingFunction,
} from "./symbol-table.js";
```

### Required imports from node-enricher.ts:
None directly. The calls-extractor does not need the enricher — it needs the symbol table (pre-enrichment is fine; enrichment mutates in place).

### Required imports from parser.ts (Phase 2):
```ts
import { ScipDocument, ScipOccurrence, SymbolRole } from "./parser.js";
```

### Required imports from types.ts (Phase 1):
```ts
import { CallsEdge } from "./types.js";
```

### Required imports from parser.ts (tree-sitter):
```ts
import { ParsedSymbol } from "../parser.js";
```

### Data flow for calls-extractor.ts:

```
extractCallsEdges(
  scipDocuments: ScipDocument[],
  symbolTable: Map<string, SymbolTableEntry>,
  parsedSymbols: ParsedSymbol[],
  repoPath: string
): CallsEdge[]
```

**Note:** The plan signature is `extractCallsEdges(occurrences, symbolTable, parsedSymbols)` but the actual implementation should take `ScipDocument[]` (not flat occurrences) because occurrences are per-document and the containing-function lookup needs the file's `relativePath`. Alternatively, flatten occurrences with their file path first.

### CallsEdge production shape (from types.ts):
```ts
{
  callerFilePath: string;   // relative path
  callerName: string;
  calleeFilePath: string;   // relative path (from symbol table entry)
  calleeName: string;
  callSiteLine: number;     // 1-indexed for Neo4j
  argTypes?: string[];      // populated by edge-enricher, not calls-extractor
  hasTypeMismatch?: boolean;
  typeMismatchDetail?: string;
}
```

### Filtering occurrences to call sites:
Use `SymbolRole` from parser.ts. An occurrence is a "reference at a call site" when:
- `(occ.symbolRoles & SymbolRole.Definition) === 0` (not a definition)
- `(occ.symbolRoles & SymbolRole.Import) === 0` (not an import)
- The target symbol (resolved via `symbolTable.get(occ.symbol)`) has `parsed.kind === "function"`

---

## Hook Points for Phase 4: edge-enricher.ts

### Required imports:
```ts
import { SymbolTableEntry } from "./symbol-table.js";
import { ScipDocument, ScipOccurrence } from "./parser.js";
import { CallsEdge, DiagnosticInfo } from "./types.js";
import { DirectlyImportsEdge } from "../resolver.js";
```

### enrichCallsEdges: needs the callee's `paramTypes` (set by enrichSymbols) and the `DiagnosticInfo[]` from `attachDiagnostics()`.

### enrichDirectImports: needs to match occurrences to `DirectlyImportsEdge` by `fromFile + targetSymbolName`. DirectlyImportsEdge already has `resolvedType?: string` field ready.

---

## Summary of Action Items for Phase 4

1. **No breaking mismatches found.** All Phase 3 signatures are compatible with Phase 4 needs.
2. **calls-extractor.ts should take `ScipDocument[]`** (not flat occurrences) to preserve per-file context for containing-function lookup. Or pre-flatten with file path attached.
3. **`scip/diagnostics.ts` from the plan is already handled** by `attachDiagnostics()` in `node-enricher.ts`. Phase 4 can skip creating that file unless additional diagnostic logic is needed for edge enrichment.
4. **Edge enricher needs `DiagnosticInfo[]`** from `attachDiagnostics()` return value to detect type mismatches at call sites.
5. **repoPath parameter** is needed by `buildContainingFunctionIndex()` — must be threaded through from the orchestrator.
6. **SymbolRole bitmask** is exported from `parser.ts` and ready for use in filtering occurrences.
