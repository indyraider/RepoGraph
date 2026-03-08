# Phase 4 Dependency Audit
**Phase:** 4 — Digest Wiring + Split Orchestrator
**Date:** 2026-03-07
**Status:** PASS

## Files Audited

| File | Status | Notes |
|------|--------|-------|
| `codeql/index.ts` | REWRITTEN | Split into `createCodeQLDatabasesIfEnabled` + `runCodeQLAnalysisStage` |
| `digest.ts` | MODIFIED | Lines 16, 521-594: import + sync DB creation + async fire-and-forget |
| `config.ts` | OK | `codeql` section present (lines 37-41) |

---

## Verified Connections

- [x] **Import chain** — `digest.ts:16` imports `{ createCodeQLDatabasesIfEnabled, runCodeQLAnalysisStage }` from `./codeql/index.js` → both functions are exported from `codeql/index.ts` (lines 97, 161). (source: local file read)

- [x] **Sync DB creation call** — `digest.ts:524-526` calls `createCodeQLDatabasesIfEnabled(scanPath, job.id, detectedLanguages)`. Arguments match the function signature `(repoPath: string, jobId: string, detectedLanguages: string[])` at `index.ts:97-101`. (source: local file read)

- [x] **detectedLanguages derivation** — `digest.ts:523` computes `[...new Set(allFiles.map((f) => f.language))]`. `allFiles` is `ScannedFile[]` which has a `language` property. This feeds `getCodeQLConfigsForLanguages()` in the runner. (source: local file read)

- [x] **Clone lifecycle ordering** — `createCodeQLDatabasesIfEnabled` called at `digest.ts:524` (inside try block). `cleanupClone` called at `digest.ts:616` (in finally block). CodeQL DB creation happens BEFORE cleanup. Databases are self-contained copies, so analysis doesn't need the clone. **Critical wiring: CORRECT.**

- [x] **Async fire-and-forget** — `digest.ts:585-594` calls `runCodeQLAnalysisStage(...).catch(...)` without `await`. Correctly fires async analysis after job is marked "complete" (line 557-565) but before `return` (line 596). (source: local file read)

- [x] **CodeQLDatabaseResult flow** — `createCodeQLDatabasesIfEnabled` returns `CodeQLDatabaseResult` with `{ databases, hasWork, skipped, skipReason? }`. `digest.ts:585` checks `codeqlDbResult.hasWork`, `digest.ts:589` checks `codeqlDbResult.skipped`. Both branches pass the full result to `runCodeQLAnalysisStage`. Types match. (source: local file read)

- [x] **Stats update** — `updateJobStats` (index.ts:60-84) reads existing stats via `sb.from("digest_jobs").select("stats").eq("id", jobId)`, merges `{ ...existingStats, codeql: codeqlStats }`, writes back. Targets specific `jobId`, no race with new digests. (source: local file read)

- [x] **Never-throw guarantee** — `runCodeQLAnalysisStage` has top-level try/catch at lines 169-319. Even the stats update in the error path has its own try/catch (lines 309-316). The `.catch()` in digest.ts is a last-resort safety net. (source: local file read)

- [x] **Config wiring** — `index.ts:102` reads `config.codeql.enabled`. `config.ts:37-41` defines `codeql: { enabled, timeoutMs, maxDiskMb }`. Import at `index.ts:3` resolves correctly. (source: local file read)

- [x] **Skip case stats recording** — When CodeQL is skipped (disabled, no CLI, no languages), `digest.ts:589-593` still calls `runCodeQLAnalysisStage` to record the skip reason in job stats. `runCodeQLAnalysisStage` handles `dbResult.skipped` at lines 171-175, calling `updateJobStats`. (source: local file read)

## Stubs & Placeholders Found

None found. All functions have real implementations.

## Broken Chains

None found.

## Missing Configuration

- [x] `config.codeql.enabled` — defined at `config.ts:38`
- [x] `config.codeql.timeoutMs` — defined at `config.ts:39`
- [x] `config.tempDir` — defined at `config.ts:22`, used in `runner.ts` for DB paths

**Note:** `config.codeql.maxDiskMb` (config.ts:40) is defined but never enforced in runner or orchestrator. Flagged in Phase 1 audit, accepted as low priority.

## Carried Forward from Phase 3

- **F-03 (SARIF cleanup):** Fixed in index.ts:225 — `cleanupCodeQLDatabase(sarifPath)` after each iteration, plus job-level directory cleanup at line 288.
- **F-07 (Transaction atomicity):** Still not implemented — purge + write use separate auto-commit transactions. Accepted as low priority (unlikely crash window).

## Runtime Issues

Not yet deployed — no runtime data available.

## Summary

Phase 4 is clean. The split orchestrator correctly separates sync DB creation (before clone cleanup) from async analysis (after digest returns). The digest.ts wiring is properly ordered: sync DB creation → mark complete → fire async analysis → return → finally cleanup. All argument types match, the never-throw guarantee holds, and stats recording covers all exit paths including skip cases. No blocking issues found.
