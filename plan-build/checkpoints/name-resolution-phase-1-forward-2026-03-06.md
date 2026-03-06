# Phase 1 Forward-Looking Checkpoint
**Date:** 2026-03-06
**Phase completed:** Phase 1 -- Barrel Classifier in parser.ts
**Files built:** `parser.ts`, `digest.ts`

---

## 1. Interface Extraction -- What Was Actually Built

### parser.ts -- New Exported Types

```typescript
export interface ReExportInfo {
  symbols: string[];       // re-exported symbol names (empty for wildcard)
  source: string;          // re-export source path as written
  isWildcard: boolean;     // export * from '...'
}

export interface BarrelInfo {
  filePath: string;
  kind: "strict" | "hybrid";
  reExports: ReExportInfo[];
}
```

### parser.ts -- Modified Type

```typescript
export interface ParseResult {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  exports: ParsedExport[];
  barrel: BarrelInfo | null;  // NEW FIELD -- non-null if file has any re-exports
}
```

**Key detail:** `barrel` is a per-file field on `ParseResult`, not a collected set. It is `null` when a file has zero re-exports, a `BarrelInfo` with `kind: "strict"` when ALL exports are re-exports (`localExportCount === 0`), and `kind: "hybrid"` when the file has both re-exports and local exports.

### parser.ts -- Classification Logic (lines 362-370)

The barrel classification runs after AST walking. Two counters drive it:
- `reExports: ReExportInfo[]` -- populated when an `export_statement` has a `source` node (i.e., `export { X } from '...'` or `export * from '...'`).
- `localExportCount: number` -- incremented for every export declaration that is NOT a re-export (lines 319, 327, 338).

Decision: `reExports.length > 0` triggers barrel creation; `localExportCount === 0` means `"strict"`, otherwise `"hybrid"`.

### digest.ts -- Barrel Aggregation (lines 228-239)

```typescript
const barrelMap = new Map<string, BarrelInfo>();
// ...inside parse loop:
if (result.barrel) {
  barrelMap.set(file.path, result.barrel);
}
```

The `barrelMap` is keyed by `file.path` (the repo-relative path from the scanner, e.g. `src/components/index.ts`) and valued with the `BarrelInfo` object from the parser.

### digest.ts -- Import of BarrelInfo (line 4)

```typescript
import { parseFile, isSupportedLanguage, ParsedSymbol, ParsedImport, ParsedExport, BarrelInfo } from "./parser.js";
```

The `BarrelInfo` type is imported and used. `ReExportInfo` is NOT imported by digest.ts (it does not need to be -- it is accessed through `BarrelInfo.reExports`).

---

## 2. Mismatch Detection -- Plan vs. Actual

### Contract 1: Parser -> Resolver

| Plan says | Actual | Status |
|-----------|--------|--------|
| `ParseResult` gains `barrelFiles: Set<string>` | `ParseResult` gains `barrel: BarrelInfo \| null` | **NAME MISMATCH -- harmless.** The plan's overview text says `barrelFiles: Set<string>` but the plan's detailed type spec shows `BarrelInfo` per file. The actual code follows the detailed spec correctly. The Set is built in digest.ts as `barrelMap`, not on ParseResult. No action needed. |
| `BarrelInfo.filePath: string` | Present | OK |
| `BarrelInfo.kind: "strict" \| "hybrid"` | Present | OK |
| `BarrelInfo.reExports: Array<{symbols, source, isWildcard}>` | Present as `ReExportInfo[]` | OK |
| `ReExportInfo.symbols: string[]` | Present | OK |
| `ReExportInfo.source: string` | Present | OK |
| `ReExportInfo.isWildcard: boolean` | Present | OK |

**Verdict: Contract 1 types match the plan's detailed spec exactly.**

### Contract 3: Path Resolver -> Barrel Unwinder (Phase 2)

The plan specifies `unwindBarrel()` takes:
```typescript
barrelMap: Map<string, BarrelInfo>
```

The actual `barrelMap` in digest.ts is:
```typescript
Map<string, BarrelInfo>
```

**Verdict: Shape matches. No mismatch.**

### Contract 8: Digest -> Resolver (updated call site)

| Plan says | Actual (line 255) | Status |
|-----------|-------------------|--------|
| Call changes to `resolveImports(allImports, scanPath, allExports, allSymbols)` | Current call is `resolveImports(allImports, scanPath)` | **EXPECTED GAP -- Phase 2/3 work.** The call site has NOT been updated yet. The `barrelMap`, `allExports`, and `allSymbols` variables exist in scope at the call site (line 255) and are ready to be passed. |

---

## 3. Dependency Readiness -- What Phase 2 Needs

### 3.1 Data available in digest.ts scope at line 255

| Variable | Type | Ready? |
|----------|------|--------|
| `allImports` | `ParsedImport[]` | Yes (line 226) |
| `scanPath` | `string` | Yes (line 144) |
| `allExports` | `ParsedExport[]` | Yes (line 227) |
| `allSymbols` | `ParsedSymbol[]` | Yes (line 225) |
| `barrelMap` | `Map<string, BarrelInfo>` | Yes (line 228) |

All five variables are populated before line 255 and available in scope. Phase 3 (digest orchestrator update) simply needs to pass them through.

### 3.2 resolveImports() current signature (resolver.ts line 137)

```typescript
export function resolveImports(
  parsedImports: ParsedImport[],
  repoPath: string
): ResolvedImport[]
```

Phase 2 must change this to accept additional parameters. The plan says the new signature should accept `allExports` and `allSymbols`. However, the plan's Contract 3 also shows `unwindBarrel()` needs `barrelMap`. Two options:

**Option A (plan's approach):** Pass `allExports` and `allSymbols` to `resolveImports()`, and have the resolver build the `barrelMap` internally from export data. But this is a problem -- the barrel classification is done in the PARSER, not derivable from `ParsedExport[]` alone (you need re-export source paths, which are in `ReExportInfo`, not in `ParsedExport`).

**Option B (what the data requires):** Pass the `barrelMap` directly from digest.ts to `resolveImports()`. The `barrelMap` contains the `ReExportInfo[]` with source paths needed by `unwindBarrel()`.

**FINDING: The plan's Contract 8 omits `barrelMap` from the updated call signature.** The plan says:
> `resolveImports(allImports, scanPath, allExports, allSymbols)`

But `unwindBarrel()` (Contract 3) needs `barrelMap: Map<string, BarrelInfo>`, and this data cannot be reconstructed from `ParsedExport[]` alone because `ParsedExport` does not contain re-export source paths or wildcard flags.

**Required fix for Phase 2:** The `resolveImports()` signature must also accept `barrelMap: Map<string, BarrelInfo>`, OR a combined data structure. The plan's Phase 2 checklist item does say "Build internal lookup maps: ... barrelMap: Map<filePath, BarrelInfo>" but this contradicts the data available -- `ParsedExport` has no re-export source information.

**Resolution:** Pass `barrelMap` as an additional parameter. The data is already built in digest.ts. Update the call at line 255 to:
```typescript
resolveImports(allImports, scanPath, allExports, allSymbols, barrelMap)
```

### 3.3 Hook points the resolver will need

| Hook point | Location | What Phase 2 does |
|------------|----------|-------------------|
| `resolveImports()` signature | resolver.ts:137 | Add `allExports`, `allSymbols`, `barrelMap` params |
| `resolveImports()` return type | resolver.ts:140 | Change from `ResolvedImport[]` to `ResolveResult` |
| After path resolution in loop | resolver.ts:158-180 | Insert barrel check + unwind call |
| After barrel unwind | (new code) | Insert `resolveSymbols()` call |
| `ResolvedImport` type | resolver.ts:5-11 | Extend to `EnrichedResolvedImport` |
| `loadTsConfig()` | resolver.ts:18-36 | Enhance for `extends` chain following |
| `resolveRelativePath()` | resolver.ts:41-73 | Used by `unwindBarrel()` to resolve re-export source paths -- no change needed, just called from new code |
| `resolveAliasPath()` | resolver.ts:75-117 | Same -- used by `unwindBarrel()` for aliased re-export sources |

### 3.4 barrelMap shape vs. unwindBarrel() needs

The plan's `unwindBarrel()` signature:
```typescript
function unwindBarrel(
  filePath: string,
  importedSymbols: string[],
  barrelMap: Map<string, BarrelInfo>,
  repoPath: string,
  visited?: Set<string>
): UnwindResult
```

What `unwindBarrel()` needs from `BarrelInfo`:
1. `kind` -- to decide strict vs hybrid handling
2. `reExports[].symbols` -- to match requested symbol names against re-exported names
3. `reExports[].source` -- to resolve the re-export target path (relative path as written in source code)
4. `reExports[].isWildcard` -- to handle `export * from '...'` (must re-resolve into the target file's exports)

All four are present in the actual `BarrelInfo` / `ReExportInfo` types. **No mismatch.**

### 3.5 Wildcard re-export handling gap

For `export * from './foo'`, the `ReExportInfo` has `symbols: []` and `isWildcard: true`. The `unwindBarrel()` function will need to look up the target file's exports to determine if the requested symbol is re-exported through the wildcard. This requires access to `allExports` (or an exports-by-file map). The plan's `unwindBarrel` signature does NOT include an `exportsMap` parameter.

**FINDING: `unwindBarrel()` cannot resolve wildcard re-exports with its planned signature alone.** When `isWildcard: true` and `symbols: []`, the function must check if the target file exports the requested symbol. It needs either:
- An `exportsMap: Map<string, ParsedExport[]>` parameter, or
- To be called from within `resolveImports()` which has built such a map internally.

The plan's Phase 2 checklist says "Build internal lookup maps: exportsMap: Map<filePath, ParsedExport[]>" inside `resolveImports()`. If `unwindBarrel()` is a nested function or receives the map via closure, this works. If it is a standalone exported function (as the plan's signature suggests), it needs the map as a parameter.

**Recommendation:** Add `exportsMap: Map<string, ParsedExport[]>` to the `unwindBarrel()` parameter list, or define it as a closure inside `resolveImports()`.

---

## 4. Summary of Findings

### No-action items (matched correctly)
- `BarrelInfo` type shape matches plan exactly
- `ReExportInfo` type shape matches plan exactly
- `barrelMap` key type (`string` = file path) matches plan
- `barrelMap` value type (`BarrelInfo`) matches plan
- `ParseResult.barrel` field provides correct data
- All barrel data variables are in scope at the digest.ts call site (line 255)
- `localExportCount` tracking correctly distinguishes strict vs hybrid

### Action items for Phase 2

1. **Pass `barrelMap` to `resolveImports()`** -- The plan's Contract 8 omits it from the call signature. The barrel data cannot be reconstructed from `ParsedExport[]`. Add it as a parameter.

2. **Handle wildcard re-exports in `unwindBarrel()`** -- When `isWildcard: true`, the symbols array is empty. The unwinder needs access to an exports map to determine if the requested symbol passes through the wildcard. Either add `exportsMap` to `unwindBarrel()`'s signature or implement it as a closure.

3. **Update digest.ts line 255** -- Currently `resolveImports(allImports, scanPath)`. Must become `resolveImports(allImports, scanPath, allExports, allSymbols, barrelMap)` (Phase 3 task, but the resolver signature change happens in Phase 2).

4. **Handle `resolveImports()` return type change** -- Lines 306 and 322 in digest.ts pass `resolvedImports` to `loadImportsToNeo4j()`. When `resolveImports()` returns `ResolveResult` instead of `ResolvedImport[]`, both call sites and the `loadImportsToNeo4j()` signature in loader.ts must be updated together (Phase 3).

### Risk: export_statement edge case

The barrel classifier counts `localExportCount` inside the `export_statement` branch (lines 309-329). An `export_default_declaration` also increments `localExportCount` (line 338). However, a plain `export { Foo }` (re-export of a local variable, no `from` clause) is classified as a local export. This is correct behavior -- only re-exports with a source module path should be treated as barrel re-exports.

One edge case: `export { default as Foo } from './bar'` -- this is a re-export and is correctly handled because the `source` node will be non-empty, routing through the re-export branch (line 283).
