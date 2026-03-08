# SCIP TypeFlow -- Phase 2 Forward-Look Checkpoint

**Date:** 2026-03-06
**Phase completed:** Phase 2 (SCIP Subprocess Runner & Parser)
**Next phase:** Phase 3 (Symbol Table & Node Enrichment)

---

## 1. Exported Interfaces from Phase 2

### runner.ts

```ts
export interface ScipRunResult {
  success: boolean;
  indexPath: string;
  durationMs: number;
  error?: string;
}

export async function isScipAvailable(): Promise<boolean>
export async function runScipTypescript(
  repoPath: string,
  outputPath: string,
  timeoutMs?: number   // defaults to config.scip.timeoutMs
): Promise<ScipRunResult>
```

### parser.ts

```ts
export interface ScipSymbolInfo {
  symbol: string;
  documentation: string[];
  signatureText: string | null;
  relationships: Array<{
    symbol: string;
    isImplementation: boolean;
    isReference: boolean;
    isTypeDefinition: boolean;
  }>;
}

export interface ScipOccurrence {
  symbol: string;
  range: [number, number, number, number];  // [startLine, startChar, endLine, endChar]
  symbolRoles: number;
}

export interface ScipDiagnostic {
  severity: number;   // 1=Error, 2=Warning, 3=Info, 4=Hint
  code: string;
  message: string;
  range: [number, number, number, number];
}

export interface ScipDocument {
  relativePath: string;
  symbols: ScipSymbolInfo[];
  occurrences: ScipOccurrence[];
  diagnostics: ScipDiagnostic[];
}

export interface ScipIndexData {
  documents: ScipDocument[];
  externalSymbols: ScipSymbolInfo[];
}

export const SymbolRole = {
  Definition: 1,
  Import: 2,
  WriteAccess: 4,
  ReadAccess: 8,
} as const;

export function parseScipIndex(indexPath: string): ScipIndexData
export function parseScipSymbolId(symbolId: string):
  { filePath: string; name: string; containerName?: string } | null
```

### cache.ts

```ts
export function checkCache(repoUrl: string, commitSha: string): string | null
export function cacheIndex(repoUrl: string, commitSha: string, indexPath: string): void
export function getScipOutputPath(jobId: string): string
export function cleanupScipOutput(outputPath: string): void
```

---

## 2. Phase 3 Needs vs. Phase 2 Provides

### Phase 3a: symbol-table.ts -- `buildSymbolTable(scipSymbols, parsedSymbols)`

**Plan says it needs:**
- `ScipSymbol` objects with `symbol` (ID string), `documentation`, `signatureDocumentation`
- Ability to parse SCIP symbol IDs to extract `filePath` + `name`

**Phase 2 provides:**
- `ScipSymbolInfo` (not `ScipSymbol` -- name differs from plan's Contract 4 which says `ScipSymbol`, but the shape matches)
- `ScipSymbolInfo.symbol` -- the SCIP ID string. PRESENT.
- `ScipSymbolInfo.documentation` -- string array. PRESENT.
- `ScipSymbolInfo.signatureText` -- the plan says `signatureDocumentation: { language, text }` but Phase 2 already flattened this to `signatureText: string | null`. This is BETTER for downstream -- Phase 3 just needs the text.
- `parseScipSymbolId()` -- returns `{ filePath, name, containerName? }`. PRESENT.

**MATCH STATUS: GOOD.** Phase 3 has everything it needs. The naming difference (`ScipSymbol` in plan vs `ScipSymbolInfo` in code) is fine -- Phase 3 just needs to import `ScipSymbolInfo`.

**One subtlety:** `parseScipSymbolId()` returns `filePath` as the backtick-quoted segment only (e.g., `file.ts`), not a full relative path like `src/file.ts`. The SCIP symbol format is `scip-typescript npm . . src/\`file.ts\`/Name.` -- the regex `\`([^\`]+)\`/` captures only `file.ts`, NOT the leading `src/` path segments. This is a potential mismatch because `ParsedSymbol.filePath` will be a full relative or absolute path like `src/file.ts`.

**MISMATCH FOUND:** `parseScipSymbolId()` extracts only the filename inside backticks, not the full directory path. SCIP symbol IDs encode the path as segments before the backtick-quoted file, e.g.: `scip-typescript npm . . src/utils/`helper.ts`/doSomething.` The current regex only captures `helper.ts`, losing `src/utils/`. Phase 3's symbol table builder will fail to match by filePath because `helper.ts` != `src/utils/helper.ts`.

**Fix needed before Phase 3:** `parseScipSymbolId()` must reconstruct the full relative path by combining the path segments before the backtick with the backtick-quoted filename.

### Phase 3b: node-enricher.ts -- `enrichSymbols(symbolTable)`

**Plan says it needs:**
- `signatureDocumentation.text` from ScipSymbol to extract resolved_signature
- Parse param_types and return_type from the signature string
- Set is_generic based on type parameters

**Phase 2 provides:**
- `ScipSymbolInfo.signatureText: string | null` -- the text is ready. GOOD.
- No signature parsing utility -- Phase 3 must implement its own TS signature parser. Expected.

**MATCH STATUS: GOOD.** The enricher gets `signatureText` directly.

---

## 3. Phase 4 Needs vs. Phase 2 Provides

### Phase 4a: calls-extractor.ts -- `extractCallsEdges(occurrences, symbolTable, parsedSymbols)`

**Plan says it needs:**
- `ScipOccurrence` with `symbol`, `range`, `symbolRoles`
- Ability to filter by `role=reference` (not definition, not import)

**Phase 2 provides:**
- `ScipOccurrence` with exactly `{ symbol, range, symbolRoles }`. PRESENT.
- `SymbolRole` constant with `Definition: 1`, `Import: 2`, `WriteAccess: 4`, `ReadAccess: 8`. PRESENT.
- A reference occurrence = `symbolRoles` that does NOT have `Definition` or `Import` bits set.

**MATCH STATUS: GOOD.** Phase 4 can filter references via `!(occ.symbolRoles & (SymbolRole.Definition | SymbolRole.Import))`.

**Note:** The plan mentions `overrideDocumentation` on ScipOccurrence (Contract 3). Phase 2 does NOT include this field. This is fine for v1 since it's only used for hover info, not CALLS extraction. If Phase 4's edge enricher needs override docs, it would need to be added.

### Phase 4b: edge-enricher.ts

**Plan says it needs:**
- SCIP diagnostics at call sites for type mismatch detection
- SCIP occurrences matched to DirectlyImportsEdge objects for resolved_type

**Phase 2 provides:**
- `ScipDiagnostic` per document with `{ severity, code, message, range }`. PRESENT.
- Occurrences are per-document (accessed via `ScipDocument`). PRESENT.

**MINOR GAP:** Diagnostics in the current parser are always empty arrays. The comment at line 109-113 of parser.ts says: "Diagnostics are nested under symbols in some SCIP versions, or at the document level. Check both." But the code only creates an empty array and never populates it. scip-typescript does not typically emit diagnostics in the SCIP index itself (diagnostics come from the TypeScript compiler, not SCIP). This means `DiagnosticInfo[]` will always be empty in practice unless the parser is updated to pull diagnostics from another source.

**Impact on Phase 4:** The edge enricher's plan to use "SCIP diagnostics at the call site as the authoritative mismatch signal" will not work with empty diagnostics. Phase 4 will need to either:
1. Fall back to string-comparison of arg types vs param types, or
2. Run a separate tsc pass to collect diagnostics, or
3. Accept that type mismatch detection is deferred.

This is a design decision for Phase 4, not a Phase 2 bug.

---

## 4. Phase 5 Needs vs. Phase 2 Provides

### Phase 5: scip/index.ts orchestrator -- `runScipStage(input)`

**Plan says the orchestrator calls:**
1. `checkCache(repoUrl, commitSha)` -- cache.ts provides. MATCH.
2. `runScipTypescript(repoPath, outputPath, timeoutMs)` -- runner.ts provides. MATCH.
3. `parseScipIndex(indexPath)` -- parser.ts provides. MATCH.
4. `cacheIndex(repoUrl, commitSha, indexPath)` -- cache.ts provides. MATCH.
5. `cleanupScipOutput(outputPath)` -- cache.ts provides. MATCH.
6. `getScipOutputPath(jobId)` -- cache.ts provides. MATCH.
7. `isScipAvailable()` -- runner.ts provides. MATCH.

**Return type alignment:**
- Plan Contract 1 says OUT includes `{ enrichedSymbols, callsEdges, diagnostics, stats, skipped }`.
- `ScipStageResult` in types.ts has `{ enrichedSymbols, callsEdges, enrichedDirectImports, diagnostics, stats, skipped }`.
- types.ts adds `enrichedDirectImports` which the plan doesn't mention in Contract 1 but does mention in Contract 9. This is an improvement -- types.ts is more complete than the plan.

**MATCH STATUS: GOOD.** All orchestrator hook points are present.

**Data flow shape note:** `parseScipIndex()` returns `ScipIndexData` which contains `documents: ScipDocument[]`. Each document has its own `symbols`, `occurrences`, and `diagnostics`. Phase 5's orchestrator will need to flatten these across all documents before passing to Phase 3/4 functions OR pass the document array and let those phases iterate. The plan's Contract 3 shows flat arrays as output, but the actual code returns per-document arrays nested inside `ScipDocument[]`. Phase 5 must flatten:

```ts
const allScipSymbols = data.documents.flatMap(d => d.symbols);
const allOccurrences = data.documents.flatMap(d => d.occurrences);
```

When flattening occurrences, the `relativePath` from each `ScipDocument` must be associated with the occurrences (they don't carry their own file path). Phase 5 may need to attach `relativePath` to each occurrence for the CALLS extractor to know which file an occurrence belongs to.

---

## 5. Mismatch Summary

| # | Severity | Location | Issue | Fix Phase |
|---|----------|----------|-------|-----------|
| 1 | **HIGH** | `parser.ts:parseScipSymbolId()` | Only extracts filename from backticks, loses directory path segments. Will cause symbol table join failures in Phase 3. | Fix in Phase 2 (before Phase 3 starts) |
| 2 | **MEDIUM** | `parser.ts` diagnostics (line 109) | Diagnostics array is always empty -- never populated from SCIP data. Phase 4 edge enricher's type mismatch strategy depends on diagnostics. | Design decision in Phase 4 |
| 3 | **LOW** | `parser.ts:ScipOccurrence` | Missing `overrideDocumentation` field from plan's Contract 3. Not needed for v1 CALLS extraction. | Defer (v2 if needed) |
| 4 | **LOW** | `parseScipIndex()` return shape | Returns nested `ScipDocument[]` not flat arrays. Phase 5 orchestrator must flatten and attach `relativePath` to occurrences. | Handle in Phase 5 |

---

## 6. What Phase 3 Must Import from Phase 2

```ts
// symbol-table.ts will need:
import { ScipSymbolInfo, ScipDocument, ScipIndexData, parseScipSymbolId } from "./parser.js";
import { ParsedSymbol } from "../parser.js";

// node-enricher.ts will need:
import { ScipSymbolInfo } from "./parser.js";
import { ParsedSymbol } from "../parser.js";
```

### Data shapes `buildSymbolTable()` must consume:

**Input 1:** `ScipSymbolInfo[]` (flattened from all `ScipDocument.symbols`) -- each has:
- `symbol: string` -- the SCIP ID to parse via `parseScipSymbolId()`
- `signatureText: string | null` -- for enrichment
- `documentation: string[]` -- for enrichment
- `relationships: Array<{...}>` -- for potential IMPLEMENTS edges (v2)

**Input 2:** `ParsedSymbol[]` (from parse stage) -- each has:
- `filePath: string` -- match key
- `name: string` -- match key
- `kind: "function" | "class" | "type" | "constant"` -- filter
- `startLine / endLine` -- for occurrence containment checks in Phase 4

**Join logic:** For each `ScipSymbolInfo`, call `parseScipSymbolId(info.symbol)` to get `{ filePath, name, containerName? }`, then find matching `ParsedSymbol` by `filePath` + `name`. The `containerName` handles `Class#method` patterns where `name` is the method and `containerName` is the class.

---

## 7. Blockers for Phase 3

**BLOCKER:** Fix `parseScipSymbolId()` path extraction before starting Phase 3. The current regex `/\`([^\`]+)\`\//` only captures the backtick-quoted segment. For a symbol ID like:

```
scip-typescript npm . . src/utils/`helper.ts`/doSomething.
```

It returns `{ filePath: "helper.ts", name: "doSomething" }` but should return `{ filePath: "src/utils/helper.ts", name: "doSomething" }`.

The fix: extract everything between the version segment and the last backtick-quoted part, concatenating the path prefix with the backtick-quoted filename. The path prefix segments use `/` separators before the backtick.

---

## 8. Non-Blocking Notes for Later Phases

- **Phase 5:** When flattening `ScipDocument[]` occurrences, attach each document's `relativePath` so the CALLS extractor knows which file each occurrence is in. Consider creating a `ScipOccurrenceWithFile` type or adding `filePath` to occurrences during flattening.
- **Phase 6:** MCP tools query `type_errors` on nodes, but if diagnostics are always empty (Mismatch #2), this field will always be null in Neo4j. Ensure MCP tools handle the null case gracefully.
- **Phase 7:** Test fixtures must include multi-directory TS repos to catch the path extraction bug if it resurfaces.
