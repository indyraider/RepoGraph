# Phase 3 Audit: Symbol Table & Node Enrichment

**Date:** 2026-03-06
**Files audited:**
- `packages/backend/src/pipeline/scip/symbol-table.ts` (NEW)
- `packages/backend/src/pipeline/scip/node-enricher.ts` (NEW)
- `packages/backend/src/pipeline/scip/parser.ts` (Phase 2 context)
- `packages/backend/src/pipeline/scip/types.ts` (Phase 1 context)
- `packages/backend/src/pipeline/parser.ts` (Phase 1 context)

**Verdict: PASS with 3 bugs to fix before Phase 4**

---

## EXECUTION CHAINS

### 1. Does buildSymbolTable correctly strip the repo path prefix to get relative paths?

**PASS.** Lines 25-31 of `symbol-table.ts`: normalizes `repoPath` to always end with `/` via `repoPrefix`, then uses `startsWith` + `slice` to strip. Handles both cases (path already ends with `/` and path without trailing `/`). Correct.

### 2. Does the "relPath::name" key format match what parseScipSymbolId returns?

**PASS.** `buildSymbolTable` builds keys as `` `${relPath}::${sym.name}` `` (line 32). `parseScipSymbolId` returns `{ filePath, name }` where `filePath` is already relative (extracted from the SCIP symbol ID which encodes relative paths like `src/utils/helper.ts`). The lookup on line 53 uses `` `${parsed.filePath}::${parsed.name}` ``. The formats match.

### 3. Does enrichSymbols correctly mutate ParsedSymbol objects?

**PASS.** `enrichSymbols` (node-enricher.ts lines 9-37) iterates `table.values()`, destructures `{ parsed, scip }`, and writes directly to `parsed.resolvedSignature`, `parsed.paramTypes`, etc. Since `parsed` is a reference to the original `ParsedSymbol` object stored in the symbol table (which itself references the same objects from the `parsedSymbols` array), mutations propagate correctly.

### 4. Does parseSignature handle arrow functions, regular functions, generics, and classes?

**PASS with one concern.**

- **Arrow functions** `(order: Order) => Promise<Result>`: The `(` is found at index 0, depth-tracking finds the matching `)`, param types are extracted, `=> Promise<Result>` is matched by the `arrowMatch` regex on line 183. Correct.
- **Regular functions** `function foo(x: number): string`: `(` found, `)` found, params extracted. The return type regex `^(?::|\s*=>)\s*(.+)` matches `: string` via the `:` alternative. Correct.
- **Generics** `<T extends Base>(items: T[]) => T`: The generic regex on line 135 matches `<T extends Base>`. Then the `(` is found for params. Correct.
- **Classes** `class MyClass<T>`: Handled by the `kind === "class"` branch (lines 141-148). The class generic regex matches. Correct.

**BUG 1 (MEDIUM) — depth counter conflates `<`/`>` with `(`/`)` in param scanning.**

Lines 158-165: The parenthesis-finding loop increments depth for both `(` and `<`, and decrements for both `)` and `>`. This means for a signature like:

```
(items: Map<string, number>, count: number) => void
```

The depth tracking goes: `(` +1=1, `<` +1=2, `,` (depth!=0, skip), `>` -1=1, `,` (depth!=0, **skip**) — but this comma separates the two *parameters*, not type args. The `)` at depth=1 decrements to 0 and is found correctly.

Wait — re-reading more carefully: the depth starts at 0, encounters `(` at index 0: depth becomes 1 (from `(`), then `<` makes it 2, the `>` in `Map<string, number>` brings it back to 1, then the `,` between params is at depth 1 (not 0), so the `depth === 0 && signature[i] === ")"` check works fine — we only break on `)` when depth reaches 0.

Actually, the bug is subtler. The `depth` tracking for finding `paramEnd` works correctly because we only care about finding the *matching* closing `)`. The `(` increments to 1, and only a `)` at depth 0 terminates. `<`/`>` add noise to the depth counter, but since they always come in balanced pairs within valid TypeScript, and we require depth to reach exactly 0 via `)`, the final result is correct.

**Revised: NOT A BUG for paramEnd finding.** However, there is still a problem: `>` in a context like `(a: Foo<Bar>)` would cause depth to go: `(` +1=1, `<` +1=2, `>` -1=1, `)` -1=0 — and then the condition `depth === 0 && signature[i] === ")"` fires correctly. So this is fine.

**But wait** — what about `>=` operators or `=>` in type signatures like `(predicate: (x: T) => boolean) => T[]`? The `>` in `=>` would decrement depth by 1 unexpectedly. Let me trace:

```
(predicate: (x: T) => boolean) => T[]
^depth=1     ^depth=2   ^>: depth=1, but this > is part of =>
                                     ^): depth=0, breaks
```

Actually this works because the `>` in `=>` decrements from 2 to 1, and the `)` right before `=> T[]` (the outer close-paren) decrements from 1 to 0. The result is correct by coincidence — the `>` in `=>` is "absorbed" by the `(` that preceded it (`(x: T)`). But consider:

```
(fn: () => void) => void
^depth=1  ^depth=2  ^>: depth=1  ^): depth=0 ✓
```

This works. But consider a function with no generics but an arrow type param:

```
(fn: () => void, x: number) => void
^depth=1  ^depth=2  ^>: depth=1, commas at depth 1 are OK for paramEnd
```

Actually paramEnd is found correctly at the outer `)`. The real concern is in `splitTopLevel` which is used *after* to split params — but `splitTopLevel` uses its own depth tracking that also treats `<` and `>` as brackets, so the `>` in `=>` inside a parameter type would cause the same issue there too.

**BUG 1 (MEDIUM, CONFIRMED) — `splitTopLevel` and the paramEnd scanner treat `>` in `=>` as a bracket closer.** For the signature `(fn: (x: string) => boolean, y: number) => Result`, `splitTopLevel` on the inner param string `fn: (x: string) => boolean, y: number` would track:

```
f,n,:, ,(: depth=1, x,:, ,s,t,r,i,n,g,): depth=0, ,=,>: depth=-1
```

At depth -1, the `,` between `boolean` and `y` is at depth -1 (not 0), so `splitTopLevel` would **fail to split the two parameters** and treat `fn: (x: string) => boolean, y: number` as a single parameter. The extracted param types would be wrong.

**Impact:** Any function whose parameter list contains an arrow-type callback (e.g., `predicate: (x: T) => boolean`) followed by additional parameters will have incorrect `paramTypes`. The arrow-type parameter and all subsequent parameters will be collapsed into one.

**Fix:** In both the paramEnd scanner and `splitTopLevel`, only treat `<`/`>` as depth changers when they are not part of `=>` or `>=`/`<=`. Alternatively, since these are TypeScript type signatures (not arbitrary code), a simpler fix is to not track `<`/`>` in the depth counter at all for `splitTopLevel` and instead only track `(`/`)`, `[`/`]`, `{`/`}` — angle brackets in types are only needed if a generic contains a comma (e.g., `Map<string, number>`), so they must stay. The cleanest fix: check that `>` is not preceded by `=` before decrementing depth.

### 5. Does attachDiagnostics correctly map SCIP 0-indexed lines to ParsedSymbol 1-indexed lines?

**PASS.** Line 70: `line: diag.range[0] + 1` converts 0-indexed SCIP line to 1-indexed for `DiagnosticInfo.line`. Line 81: `const line1 = diag.range[0] + 1` does the same conversion before comparing against `entry.parsed.startLine` / `entry.parsed.endLine` (which are 1-indexed from tree-sitter). Correct.

### 6. Does findContainingFunction handle the 0-to-1 index conversion?

**PASS.** Line 126: `const line1 = line + 1` converts the 0-indexed SCIP line to 1-indexed before comparing against `sym.startLine` / `sym.endLine`. The function signature documents this: `line: number // 0-indexed (SCIP convention)`. Correct.

---

## DATA FLOW

### 7. Are the types consistent between symbol-table.ts outputs and node-enricher.ts inputs?

**PASS.** `buildSymbolTable` returns `{ table: Map<string, SymbolTableEntry>, unmatchedCount }`. `enrichSymbols` takes `table: Map<string, SymbolTableEntry>`. The `SymbolTableEntry` interface is defined in `symbol-table.ts` and imported by `node-enricher.ts` (line 1). Type-consistent.

### 8. Does the typeErrors shape on ParsedSymbol match what attachDiagnostics writes?

**PASS.** `ParsedSymbol.typeErrors` is typed as `Array<{ severity: "error" | "warning" | "info"; code: string; message: string; line: number }>` (parser.ts lines 21). `attachDiagnostics` pushes objects with `{ severity, code: diag.code, message: diag.message, line: line1 }` (node-enricher.ts lines 87-91). The shapes match.

Note: `typeErrors` on `ParsedSymbol` does **not** include `filePath`, while `DiagnosticInfo` does. This is correct — the `filePath` is redundant on `typeErrors` since it's already on the `ParsedSymbol` itself.

### 9. Does DiagnosticInfo from types.ts match what attachDiagnostics returns?

**PASS.** `DiagnosticInfo` (types.ts lines 6-12) has `{ severity, code, message, filePath, line }`. `attachDiagnostics` builds `diagInfo` on lines 65-71 with all five fields: `severity` from `mapSeverity()`, `code: diag.code`, `message: diag.message`, `filePath: doc.relativePath`, `line: diag.range[0] + 1`. All fields present and correctly typed.

---

## EDGE CASES

### 10. What happens with duplicate symbol names in the same file?

**Handled, but with a limitation.** `buildSymbolTable` line 35: `if (!parsedIndex.has(key)) { parsedIndex.set(key, sym); }` — keeps the **first** ParsedSymbol with a given `relPath::name` key. If there are overloaded functions with the same name in the same file (valid in TypeScript), only the first overload gets matched. SCIP will have separate symbol entries for each overload, but they'll all resolve to the same first ParsedSymbol.

**Impact:** Low for v1. TypeScript function overloads are relatively uncommon, and the first overload typically has the most complete signature. The `unmatchedCount` will NOT be incremented for the later overloads — they'll all match the same ParsedSymbol, which could lead to the symbol table having multiple entries pointing to the same `ParsedSymbol` object. This is harmless for `enrichSymbols` (it will just overwrite the same fields multiple times, last write wins).

### 11. What happens when parseScipSymbolId returns a containerName (class method)?

**BUG 2 (MEDIUM) — Class method matching falls back to matching the *container* (class), not the method.**

In `buildSymbolTable` lines 59-76: when the primary key `file::methodName` doesn't match (because tree-sitter stores class methods as `ClassName.methodName`), the fallback tries `file::containerName` where `containerName` is the class name. This matches the **class** ParsedSymbol, not the method.

But tree-sitter (parser.ts line 184) stores class methods as `ParsedSymbol.name = "ClassName.methodName"`. So the correct fallback key should be `file::ClassName.methodName`, i.e., `` `${parsed.filePath}::${parsed.containerName}.${parsed.name}` ``.

Currently the code tries `file::ClassName` which matches the class itself. The method's SCIP type info gets attached to the class's ParsedSymbol instead of the method's. This means:
- The class node gets enriched with the method's signature (wrong).
- The method node never gets enriched (missed).

**Fix:** Change line 63 from:
```ts
const altKey = `${parsed.filePath}::${parsed.containerName}`;
```
to:
```ts
const altKey = `${parsed.filePath}::${parsed.containerName}.${parsed.name}`;
```

This matches tree-sitter's `ClassName.methodName` convention.

### 12. What about symbols in nested directories?

**PASS.** `parseScipSymbolId` extracts the full relative path including directories. For example, from `scip-typescript npm . . src/utils/`helper.ts`/doSomething.`, it extracts `filePath: "src/utils/helper.ts"`. The `buildSymbolTable` strips the repo prefix from `ParsedSymbol.filePath` to get the same relative path. Nested directories are handled correctly as long as the SCIP path prefix extraction (4 spaces from the start) is correct.

### 13. Does splitTopLevel handle unbalanced brackets gracefully?

**BUG 3 (LOW) — `splitTopLevel` can go to negative depth on unbalanced input.**

Line 202: `depth--` happens unconditionally for `)`, `>`, `]`, `}`. If the input has an unbalanced closer (e.g., a `>` from `=>` as discussed in Bug 1), depth goes negative. At negative depth, the delimiter check `depth === 0 && char === delimiter` will never fire, so all remaining content gets merged into a single part.

The function does not crash — it just returns fewer parts than expected. Combined with Bug 1, this means some parameter lists will return fewer `paramTypes` entries than the function actually has.

**Impact:** Incorrect `paramTypes` array for functions with arrow-type callback parameters.

**Fix:** Same as Bug 1 — prevent `>` preceded by `=` from decrementing depth.

---

## ADDITIONAL FINDINGS

### 14. attachDiagnostics uses first-match containment, not innermost-match

**MINOR CONCERN.** In `attachDiagnostics` (node-enricher.ts lines 82-95), diagnostics are attached to the **first** symbol whose range contains the diagnostic line (`break` on line 94). The symbol entries in `fileSymbols` are not sorted, so for nested functions (a function inside a class), the diagnostic could be attached to either the class or the inner method depending on insertion order.

Compare with `findContainingFunction` in `symbol-table.ts` (lines 129-136), which correctly finds the **innermost** (smallest range) containing function.

**Impact:** A type error inside a class method could be attached to the class node instead of the method node. Low severity for v1 since `typeErrors` is informational.

**Fix:** Either sort `fileSymbols` entries by range size (ascending) before iterating, or use the same innermost-match logic as `findContainingFunction`.

### 15. parseSignature generic detection only matches leading `<`

The generic regex on line 135 (`/^<([^>]+)>/`) only matches generics at the **start** of the signature. A signature like `function foo<T>(x: T): T` would not match because it doesn't start with `<`. However, SCIP's `signatureDocumentation.text` typically emits signatures in the form `<T>(x: T) => T` (without the `function` keyword), so this is likely fine in practice.

For class generics, the separate regex on line 143 handles `class Foo<T>` correctly.

### 16. No filePath on typeErrors pushed to ParsedSymbol — intentional and correct

The `typeErrors` array on `ParsedSymbol` omits `filePath` (compared to `DiagnosticInfo`). This is intentional since the file path is already on the parent `ParsedSymbol.filePath`. No issue.

---

## SUMMARY OF BUGS

| # | Severity | Location | Description |
|---|----------|----------|-------------|
| 1 | MEDIUM | `node-enricher.ts` lines 158-165, 200-202 | `splitTopLevel` and paramEnd scanner treat `>` in `=>` as a bracket closer, causing incorrect param splitting for arrow-type callback parameters |
| 2 | MEDIUM | `symbol-table.ts` line 63 | Class method fallback matches the class container instead of `ClassName.methodName`, so method SCIP data enriches the wrong node |
| 3 | LOW | `node-enricher.ts` line 202 | `splitTopLevel` goes to negative depth on unbalanced brackets (consequence of Bug 1) |

### Bonus finding (LOW)
`attachDiagnostics` uses first-match instead of innermost-match for containing symbol, unlike `findContainingFunction`. Diagnostics could attach to a class instead of the method within it.

---

## FIXES REQUIRED BEFORE PHASE 4

**Bug 2 is the most critical** — it will cause all class method enrichment to silently fail (methods never enriched, classes wrongly enriched with method signatures). Single-line fix:

```ts
// symbol-table.ts line 63, change:
const altKey = `${parsed.filePath}::${parsed.containerName}`;
// to:
const altKey = `${parsed.filePath}::${parsed.containerName}.${parsed.name}`;
```

**Bug 1** should also be fixed before Phase 4 since CALLS edge extraction (Phase 4) will rely on accurate `paramTypes` for type mismatch detection. Fix: in `splitTopLevel`, check that `>` is not preceded by `=` before decrementing depth. Same for the paramEnd scanner.

**Bonus finding** is low priority but easy to fix — sort `fileSymbols` entries by range size or adopt innermost-match logic.
