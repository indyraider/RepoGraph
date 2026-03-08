# Phase 2 Audit: SCIP Subprocess Runner & Parser

**Date:** 2026-03-06
**Phase:** 2 — SCIP Subprocess Runner & Parser
**Status:** PASS WITH FINDINGS (2 bugs, 3 risks, 2 observations)

---

## Files Audited

| File | Lines | Verdict |
|---|---|---|
| `packages/backend/src/pipeline/scip/runner.ts` | 100 | BUG: double-resolve race |
| `packages/backend/src/pipeline/scip/parser.ts` | 181 | BUG: wrong import path; RISK: no error handling on readFileSync |
| `packages/backend/src/pipeline/scip/cache.ts` | 62 | Clean |

---

## Wiring Checklist Verification

| Checklist Item | Status | Notes |
|---|---|---|
| `runner.ts` with `runScipTypescript()` | PRESENT | Correctly spawns `scip-typescript index` with `--cwd`, `--output`, `--infer-tsconfig` |
| `runner.ts` with `isScipAvailable()` | PRESENT | Spawns `scip-typescript --version`, resolves false on error |
| `parser.ts` with `parseScipIndex()` | PRESENT | Reads binary file, calls `deserializeBinary`, iterates documents |
| `parser.ts` with `parseScipSymbolId()` | PRESENT | Regex-based parser for SCIP symbol ID format |
| `cache.ts` with `checkCache()` | PRESENT | Checks `{tempDir}/scip-cache/{hash}/{commitSha}.scip` |
| `cache.ts` with `cacheIndex()` | PRESENT | mkdirSync + copyFileSync |
| `cache.ts` with `getScipOutputPath()` | PRESENT | Creates temp dir and returns `{tempDir}/scip-jobs/{jobId}.scip` |
| `cache.ts` with `cleanupScipOutput()` | PRESENT | Try/catch best-effort unlink |

---

## BUG-01 (Severity: HIGH) — Double-resolve race in `runScipTypescript`

**File:** `runner.ts`, lines 62-98

**Problem:** When the timeout fires (line 62-70), it calls `proc.kill("SIGKILL")` and then immediately calls `resolve()` with the timeout result. However, killing the process will subsequently emit a `"close"` event (line 82), which also calls `resolve()`. The first `resolve()` wins (Promise semantics), so the returned value is correct, but:

1. The `clearTimeout(timer)` on line 83 runs after the timer already fired, so it's a no-op.
2. The `"close"` handler still executes all its logic (building result object, calling resolve) — wasted work and potentially confusing if logging is added later.
3. More critically: there is a symmetric race. If the process exits normally and `"close"` fires at nearly the same instant the timeout fires, both handlers run. The timeout handler calls `proc.kill("SIGKILL")` on an already-exited process (harmless — kill on dead PID throws no error in Node.js) and calls `resolve()` with the timeout error. Meanwhile `"close"` also calls `resolve()` with the success result. Which one wins depends on microtask ordering.

**Fix:** Add a `settled` boolean guard:

```typescript
let settled = false;
const settle = (result: ScipRunResult) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  resolve(result);
};
```

Then replace all three `resolve()` calls (timeout, error, close) with `settle()`.

---

## BUG-02 (Severity: HIGH) — Wrong import path for SCIP protobuf module

**File:** `parser.ts`, line 7

**Code:**
```typescript
const { scip } = require("@sourcegraph/scip-typescript/dist/src/scip.js");
```

**Problem:** The package `@sourcegraph/scip-typescript` is listed in `package.json` (v0.4.0) but is not yet installed (`node_modules/@sourcegraph/scip-typescript` does not exist). More importantly, the import path `dist/src/scip.js` assumes a specific internal file layout of the `scip-typescript` package that may not exist or may change between versions.

The build plan (Contract 3) specifies using `@sourcegraph/scip` as the protobuf parser package, and the plan's "Missing Package" issue (line 440) says to install `@sourcegraph/scip`. These are two different packages:
- `@sourcegraph/scip` — the protobuf definitions package (what the plan says to use)
- `@sourcegraph/scip-typescript` — the CLI tool (what's actually in package.json)

The parser is importing from the CLI tool's internals instead of the dedicated protobuf package. The API may also differ: the plan says `scip.Index.decode(buffer)` while the code uses `scip.Index.deserializeBinary(new Uint8Array(buffer))`. The method name depends on which protobuf library is used under the hood (`google-protobuf` uses `deserializeBinary`, `protobufjs` uses `decode`).

**Fix:** Verify which package actually exports the `Index` class and what method it provides. If `@sourcegraph/scip` is the correct package:
1. Add `@sourcegraph/scip` to `package.json` (may not need `scip-typescript` as a package dep at all — it's a CLI tool).
2. Update the import to `require("@sourcegraph/scip")` or the correct subpath.
3. Verify whether the method is `deserializeBinary` or `decode`.

Until the package is installed, this code will throw at module load time.

---

## RISK-01 (Severity: MEDIUM) — No error handling on `fs.readFileSync` in `parseScipIndex`

**File:** `parser.ts`, line 71

**Code:**
```typescript
const buffer = fs.readFileSync(indexPath);
```

**Problem:** If the `.scip` file does not exist (e.g., `scip-typescript` exited with code 0 but didn't write the file, or the file was cleaned up by another process), this throws an unhandled `ENOENT` error. If the file is 0 bytes, `readFileSync` returns an empty Buffer, and `deserializeBinary(new Uint8Array(emptyBuffer))` will either throw a protobuf parsing error or return an empty Index with no documents — the latter is actually fine, the former would be an uncaught exception.

The build plan (Contract 3, line 99) says: "Malformed protobuf -> throw, caught by SCIP stage -> skipped." This implies the caller (Phase 5 `runScipStage`) is expected to wrap the call in try/catch. However, `parseScipIndex` is a Phase 2 deliverable and there is no Phase 5 code yet. If any Phase 3/4 code calls `parseScipIndex` without try/catch before Phase 5 is wired, it will crash the process.

**Recommendation:** Add a guard at the top of `parseScipIndex`:

```typescript
if (!fs.existsSync(indexPath)) {
  throw new Error(`SCIP index file not found: ${indexPath}`);
}
const stat = fs.statSync(indexPath);
if (stat.size === 0) {
  return { documents: [], externalSymbols: [] };
}
```

This provides a clear error for missing files and a graceful empty result for 0-byte files.

---

## RISK-02 (Severity: LOW) — `isScipAvailable` can also double-resolve

**File:** `runner.ts`, lines 14-23

**Problem:** Same structural issue as BUG-01 but at a lower severity. The `spawn` call has `timeout: 5000`. When Node.js spawn timeout triggers, it kills the child process and then the `"close"` event fires. If the `"error"` event (ENOENT) and `"close"` event both fire (which happens when the binary is not found — error fires first, then close fires with null code), the promise resolves twice.

Since the promise ignores the second resolve and the result is only a boolean, this is functionally harmless but technically sloppy.

**Fix:** Same `settled` guard pattern as BUG-01.

---

## RISK-03 (Severity: LOW) — `cacheIndex` does not handle `copyFileSync` failure

**File:** `cache.ts`, line 39

**Problem:** If `copyFileSync` fails (disk full, permissions, source file already deleted), the exception propagates to the caller. The plan says cache operations should be best-effort (like `cleanupScipOutput` is), but `cacheIndex` has no try/catch.

**Fix:** Wrap in try/catch with a warning log, similar to how `cleanupScipOutput` is implemented.

---

## OBSERVATION-01 — `ScipRunResult` matches Contract 2

The `ScipRunResult` interface (runner.ts:4-9) matches Contract 2's specification:

| Contract 2 field | `ScipRunResult` field | Match? |
|---|---|---|
| `success: boolean` | `success: boolean` | Yes |
| `indexPath: string` | `indexPath: string` | Yes |
| `durationMs: number` | `durationMs: number` | Yes |
| `error?: string` | `error?: string` | Yes |

The contract is satisfied.

---

## OBSERVATION-02 — Parser interfaces diverge from Contract 3 (intentionally)

Contract 3 specifies a flat output `{ symbols, occurrences, diagnostics }`. The implementation uses a richer structure: `ScipIndexData { documents: ScipDocument[], externalSymbols: ScipSymbolInfo[] }` where each `ScipDocument` contains per-file `{ relativePath, symbols, occurrences, diagnostics }`.

This is a **better design** than the contract. Keeping data per-file preserves the file path context needed for symbol table building in Phase 3. The downstream consumer (Phase 3) will need to iterate `documents` instead of flat arrays, which is straightforward.

The parser also introduces `ScipSymbolInfo` (with `signatureText`) instead of the contract's `ScipSymbol` (with `signatureDocumentation.text`). This is a reasonable flattening — the nested object is collapsed to a nullable string. Phase 3 will need to use `signatureText` not `signatureDocumentation.text`.

The `ScipOccurrence` interface omits `overrideDocumentation` from Contract 3. This field is rarely populated by `scip-typescript` and is not needed for any downstream phase, so this is acceptable.

---

## OBSERVATION-03 — `parseScipSymbolId` regex parsing

The function at parser.ts:148-180 correctly handles the two main SCIP symbol ID patterns:
- Simple: `` scip-typescript npm . . src/`file.ts`/FunctionName. `` -> `{ filePath: "file.ts", name: "FunctionName" }`
- Class method: `` scip-typescript npm . . src/`file.ts`/Class#method(). `` -> `{ filePath: "file.ts", name: "method", containerName: "Class" }`

Edge cases considered:
- Returns `null` when no backtick-quoted path found (line 153)
- Returns `null` when no name after file path (line 159)
- Returns `null` when descriptor chain is empty after cleaning (line 168)

Potential edge case not handled: symbols with nested namespaces like `` `file.ts`/Outer.Inner.method(). `` — the current code would return `{ name: "method", containerName: "Outer" }`, dropping `Inner`. This is unlikely to cause issues in practice since nested namespaces are rare in TypeScript, but Phase 3's symbol table builder should be aware.

---

## OBSERVATION-04 — ESM/CJS interop via `createRequire`

**File:** `parser.ts`, lines 5-7

The project is ESM (`"type": "module"` in package.json, `"module": "NodeNext"` in tsconfig). The `createRequire` trick is the correct way to import CJS modules from ESM in Node.js. This pattern is sound **provided** the target module path is correct (see BUG-02).

---

## OBSERVATION-05 — Config wiring verified

- `runner.ts` reads `config.scip.timeoutMs` (line 33, as default parameter) — correct, matches config.ts line 31.
- `runner.ts` reads `config.scip.maxMemoryMb` (line 44) — correct, matches config.ts line 32.
- `cache.ts` reads `config.tempDir` (line 11) — correct, matches config.ts line 22.
- Neither file reads `config.scip.enabled` — this is correct; the enabled check is the responsibility of the Phase 5 orchestrator.

---

## OBSERVATION-06 — Diagnostics array is always empty

**File:** `parser.ts`, line 109

The `diagnostics` array for each document is initialized as `[]` and never populated. The comment (lines 110-113) explains this is because `scip-typescript` doesn't emit document-level diagnostics in the standard way. This means `collectDiagnostics` in Phase 4 will receive no diagnostics data.

This is acceptable for v1 if diagnostics are low priority, but it should be explicitly noted in the Phase 4 forward-guidance. The `ScipStats.scipDiagnosticCount` will always be 0.

---

## Summary of Required Fixes Before Phase 3

| ID | Severity | File | Fix |
|---|---|---|---|
| BUG-01 | HIGH | runner.ts | Add `settled` guard to prevent double-resolve race between timeout/close/error handlers |
| BUG-02 | HIGH | parser.ts | Fix import path — determine correct package (`@sourcegraph/scip` vs `scip-typescript` internals), install it, verify `deserializeBinary` vs `decode` method name |
| RISK-01 | MEDIUM | parser.ts | Add file-existence check and 0-byte guard before `readFileSync` |
| RISK-03 | LOW | cache.ts | Wrap `copyFileSync` in try/catch for best-effort caching |

BUG-01 and BUG-02 must be fixed before Phase 3 begins. RISK-01 should be fixed. RISK-03 can be deferred but is recommended.
