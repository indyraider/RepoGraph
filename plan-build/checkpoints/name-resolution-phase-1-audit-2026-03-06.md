# Phase 1 Audit: Barrel Classifier in parser.ts

**Date:** 2026-03-06
**Phase:** Phase 1 -- Barrel Classifier (parser.ts extension)
**Auditor:** Claude Opus 4.6
**Verdict:** PASS WITH FINDINGS (2 bugs, 1 observation)

---

## Wiring Checklist Verification

### 1. Add BarrelInfo type to parser.ts exports -- PASS

`ReExportInfo` (lines 32-36) and `BarrelInfo` (lines 38-42) are defined and exported. Both match the contract specified in the build plan exactly:

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

The `ReExportInfo` type is a good addition not in the plan -- it factors out the inline array type from `BarrelInfo.reExports`, making it reusable.

### 2. Add barrelFiles field to parse result aggregation in digest.ts -- PASS

`ParseResult` (lines 44-49) now includes `barrel: BarrelInfo | null`. This is slightly different from the plan which said `barrelFiles: Set<string>` -- but the actual implementation is better. The `barrel` field on `ParseResult` carries the per-file barrel info, and `digest.ts` aggregates into `barrelMap: Map<string, BarrelInfo>` (line 228), which is the correct data structure for downstream consumption.

### 3. Barrel classification after walk completes -- PASS

Lines 362-370 of `parser.ts`:
```typescript
let barrel: BarrelInfo | null = null;
if (reExports.length > 0) {
  barrel = {
    filePath,
    kind: localExportCount === 0 ? "strict" : "hybrid",
    reExports,
  };
}
```

This runs AFTER the `for (const child of tree.rootNode.namedChildren)` loop at lines 358-360. Correct sequencing.

### 4. Aggregate barrel info in digest.ts parse loop -- PASS

Lines 228-239 of `digest.ts`:
```typescript
const barrelMap = new Map<string, BarrelInfo>();
// ...
if (result.barrel) {
  barrelMap.set(file.path, result.barrel);
}
```

Keyed by `file.path` (the scanned file's path). The `BarrelInfo.filePath` field inside the value should match this key since `parseFile` receives and propagates `file.path` as `filePath`. Consistent.

---

## Execution Chain Analysis

### Re-export detection (export { X } from './Y') -- PASS

Lines 280-305: The `export_statement` case checks for a `source` field. In tree-sitter-typescript, `export { X } from './Y'` produces an `export_statement` node with a `source` field pointing to the string literal. When `source` is non-empty, the code correctly:
1. Extracts re-exported symbol names from the `export_clause`
2. Pushes to both `imports[]` (for import resolution) and `reExports[]` (for barrel classification)
3. Breaks without incrementing `localExportCount`

### Wildcard detection (export * from './Y') -- PASS

Line 286: `const isWildcard = node.children.some((c) => c.type === "*");`

In tree-sitter-typescript, `export * from './foo'` produces an `export_statement` with a child node of type `"*"`. This check works. When `isWildcard` is true, the `exportClause` will be null (no `export_clause` node for wildcard exports), so `reExportSymbols` stays empty. This correctly produces a `ReExportInfo` with `symbols: []` and `isWildcard: true`.

### Local export counting -- PASS WITH BUG (see Finding #1)

The `localExportCount` counter increments in two places:
- Line 319: Inside the loop over `export_statement` children for declaration types
- Line 327: Inside the `identifier && defaultKeyword` branch

This correctly counts `export function foo()`, `export class Bar`, `export const X`, `export default foo`, etc.

### Every code path sets barrel -- PASS

- `parseTypeScript`: Lines 362-372 always set `barrel` (either to `BarrelInfo` or `null`)
- `parsePython`: Line 543 returns `barrel: null`
- `parseGo`: Line 675 returns `barrel: null`
- Unsupported language: Line 87 returns `barrel: null`

All four paths covered.

---

## Data Flow Analysis

### Parser -> Digest aggregation -- PASS

`digest.ts` line 4 imports `BarrelInfo` from `parser.js`. Line 228 declares `barrelMap`. Lines 238-239 populate it. The key is `file.path` which is the repo-relative path from the scanner -- consistent with what downstream phases will use for lookups.

### barrelMap is declared but not yet consumed -- OBSERVATION

`barrelMap` is built at line 228 of `digest.ts` but is not passed to `resolveImports` at line 255. This is expected -- Phase 2 will wire it into the resolver. Currently it is a dead variable. No issue, but Phase 2 must add it as an argument.

---

## Findings

### FINDING #1: BUG -- `export { X }` without `from` misclassified as having zero local exports

**Severity: Medium**
**Location:** parser.ts lines 308-329

When a file uses `export { X, Y }` (without `from`) to re-export previously declared local symbols, this pattern falls through to the "local exports" branch (line 308). However, the code at lines 309-316 only looks for declaration node types (`function_declaration`, `class_declaration`, etc.). An `export { X }` statement contains an `export_clause` node, not a declaration node. The `export_clause`'s named children are `export_specifier` nodes, which are not in the type list.

**Result:** `localExportCount` is NOT incremented for `export { X }` statements. The symbols are also not added to `exports[]`.

**Impact on barrel classification:** If a file has ONLY `export { X }` statements (no inline `export function`, no re-exports), then:
- `reExports.length === 0` so `barrel` is `null` -- correct, file is not a barrel
- But the exports are silently lost from `exports[]`

If a file has re-exports AND `export { X }` statements:
- `localExportCount` stays 0 for the `export { X }` parts
- File may be incorrectly classified as `"strict"` barrel when it should be `"hybrid"`

**Example triggering the bug:**
```typescript
// utils/index.ts
function helper() { ... }
export { helper };           // <-- not counted as local export, not added to exports[]
export { Button } from './Button';  // <-- counted as re-export
```
This file would be classified as `kind: "strict"` but it should be `kind: "hybrid"` because `helper` is a local export.

**Fix:** Add an `export_clause` handler in the non-source branch:
```typescript
if (child.type === "export_clause") {
  for (const spec of child.namedChildren) {
    const name = spec.childForFieldName("name")?.text || spec.text;
    exports.push({ symbolName: name, isDefault: false, filePath });
  }
  localExportCount++;
}
```

### FINDING #2: BUG -- `export enum` declarations not counted properly

**Severity: Low**
**Location:** parser.ts lines 309-319

`enum_declaration` is in the type list at line 316, so `walk(child, true)` is called. But `walk` has no `case "enum_declaration"` -- it falls through to the `default` case which recurses into children. Those children won't match any symbol-producing case, so:
- `localExportCount` IS incremented (line 319) -- correct for barrel classification
- But no `ParsedSymbol` or `ParsedExport` is created for the enum -- the symbol is silently dropped

**Impact on barrel classification:** Minimal. The count is correct, so barrel vs. hybrid classification is right. But the exported enum won't appear in `allExports` which will affect symbol resolution in Phase 2.

**Pre-existing issue:** This is a pre-existing gap in the parser (enums were never handled as symbols). Not introduced by Phase 1. But it will matter when Phase 2 tries to resolve symbols -- an imported enum will be unresolvable.

### FINDING #3: OBSERVATION -- `export default class {}` (anonymous) not handled

**Severity: Informational**
**Location:** parser.ts lines 333-347

`export_default_declaration` only processes children that are `function_declaration` or `class_declaration`. Anonymous default exports like `export default class {}` or `export default function() {}` produce nodes without a `name` field. The `childForFieldName("name")` returns null, so the name check at line 338 prevents the export from being marked as default. Also, `export default { ... }` (object literal) and `export default expression` are not handled.

**Impact on barrel classification:** None. These are local exports within `export_default_declaration`, which doesn't touch `localExportCount` or `reExports`. If the file has re-exports too, the lack of counting here could cause a strict/hybrid misclassification, but `export_default_declaration` is rare alongside re-exports.

---

## Stubs and Placeholders

No TODO, FIXME, HACK, XXX, or PLACEHOLDER comments found in either parser.ts or digest.ts.

No hardcoded values that should be configurable found in Phase 1 code. The barrel depth limit (10) is not in Phase 1 -- it will be in Phase 2's `unwindBarrel`.

---

## Configuration / Import Verification

### parser.ts imports -- PASS
- `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-go`: All existing, unchanged.

### digest.ts imports -- PASS
- Line 4: `import { parseFile, isSupportedLanguage, ParsedSymbol, ParsedImport, ParsedExport, BarrelInfo } from "./parser.js";`
  - `parseFile` -- exported at line 81
  - `isSupportedLanguage` -- exported at line 77
  - `ParsedSymbol` -- exported at line 9
  - `ParsedImport` -- exported at line 19
  - `ParsedExport` -- exported at line 26
  - `BarrelInfo` -- exported at line 38
  - All verified present and exported.

---

## Error Path Analysis

### Unexpected AST nodes -- PASS

The `walk` function's `default` case (line 349) recurses into children. If tree-sitter produces an unexpected node type, it falls through to the default and recurses. This is safe -- it won't crash, and the barrel classification logic only depends on `reExports` and `localExportCount`, which are only modified in known cases.

### File with zero exports -- PASS

If a file has zero exports (no `export_statement`, no `export_default_declaration`):
- `reExports.length === 0`
- `localExportCount === 0`
- `barrel = null` (correct -- file with no exports is not a barrel)

### Parse failure -- PASS

`digest.ts` line 241: `try/catch` around `parseFile` catches parse errors, increments `parseFailures`, logs a warning, and continues. No barrel info is stored for failed files. Correct behavior.

---

## Summary

| Check | Status |
|-------|--------|
| BarrelInfo type exported | PASS |
| ReExportInfo type exported | PASS (bonus) |
| ParseResult includes barrel field | PASS |
| barrel classification after walk | PASS |
| Re-export detection | PASS |
| Wildcard detection | PASS |
| digest.ts imports BarrelInfo | PASS |
| digest.ts builds barrelMap | PASS |
| barrelMap keyed by file.path | PASS |
| Python returns barrel: null | PASS |
| Go returns barrel: null | PASS |
| Unsupported returns barrel: null | PASS |
| No TODOs/FIXMEs | PASS |
| Error paths handled | PASS |
| `export { X }` without from | **BUG** |
| enum exports | **BUG** (pre-existing) |

**Bugs to fix before proceeding to Phase 2:**
1. **Must fix:** `export { X }` without `from` clause -- not counted as local export, not added to exports array. Causes strict/hybrid misclassification.
2. **Should fix (pre-existing):** `enum_declaration` in walk produces no symbol or export entry. Will cause unresolvable symbols in Phase 2.
