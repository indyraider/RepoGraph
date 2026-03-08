# Audit: CodeQL Data Flow — Phase 1 (Types + Config + Runner)
**Date:** 2026-03-07
**Auditor:** Claude Code (dependency audit)
**MCP Note:** Files are newly created and not yet indexed by RepoGraph. All verification done via local file reads.

## Files Audited
- `/packages/backend/src/config.ts` (codeql section added)
- `/packages/backend/src/pipeline/codeql/types.ts` (new file)
- `/packages/backend/src/pipeline/codeql/runner.ts` (new file)

---

## 1. EXECUTION CHAINS

### config.ts — codeql section
- **PASS.** Three fields: `enabled`, `timeoutMs`, `maxDiskMb`. All read from env vars with correct defaults.
- `enabled` uses `=== "true"` (opt-in), matching plan requirement. Contrast with SCIP which uses `!== "false"` (opt-out). This is intentional per plan Issue 3.
- `timeoutMs` default 900000 (15 min) matches plan spec.
- `maxDiskMb` default 2048 matches plan spec.

### runner.ts — isCodeQLAvailable()
- **PASS.** Spawns `codeql --version`, resolves true on exit code 0, false on error. 10s timeout on spawn.
- Uses `settled` guard to prevent double-resolve. Correct pattern, matches SCIP.

### runner.ts — createCodeQLDatabase()
- **PASS.** Real logic, not a stub. Spawns `codeql database create` with correct args: `--language`, `--source-root`, `--overwrite`.
- Timeout handling: `setTimeout` → `SIGKILL` → settle with error. Correct.
- ENOENT handling: on `error` event, checks `code === "ENOENT"` → returns `"not_installed"`. Correct.
- Exit code handling: code 0 → success, non-zero → error with stderr or exit code. Correct.
- `settled` guard prevents double-resolve from timeout + close race. Correct.
- `clearTimeout(timer)` called in `settle()`. Correct.

### runner.ts — runCodeQLAnalysis()
- **PASS.** Same spawn pattern as createCodeQLDatabase. Correct args: `database analyze`, `--format=sarif-latest`, `--output=<path>`, querySuite.
- Timeout, ENOENT, exit code handling all present and correct.
- **MINOR NOTE:** ENOENT handling in `runCodeQLAnalysis` error handler does NOT map to `"not_installed"` like `createCodeQLDatabase` does — it just passes `err.message`. This is acceptable since `isCodeQLAvailable()` is called first by the orchestrator, and `createCodeQLDatabase` runs before analysis. If CodeQL disappears mid-run, the raw error message is fine.

### runner.ts — cleanupCodeQLDatabase()
- **PASS.** Checks `existsSync`, then `rm` with `{ recursive: true, force: true }`. Error caught and logged as warning, not thrown. Correct — cleanup failures should not crash the pipeline.

### runner.ts — getCodeQLDbPath() / getSarifOutputPath()
- **PASS.** Uses `config.tempDir` + `codeql-jobs` + jobId + language-based filename. Produces clean paths.

### runner.ts — getCodeQLConfigsForLanguages()
- **PASS.** Deduplicates by `cfg.language` (not by map key). Correct — typescript/tsx/javascript all map to the same config, and `seen.has(cfg.language)` prevents duplicates.

---

## 2. DATA FLOW (Types → Runner)

### Types exported from types.ts and used in runner.ts:
| Type | Exported from types.ts | Imported in runner.ts | Used correctly |
|---|---|---|---|
| `CodeQLLanguageConfig` | Yes | Yes | Yes — `javascriptConfig` satisfies the interface (language, querySuite, extensions, label) |
| `CodeQLRunResult` | Yes | Yes | Yes — all runner functions return `CodeQLRunResult` |
| `CodeQLStageInput` | Yes | Not imported | Correct — not needed yet, used by orchestrator (Phase 3) |
| `CodeQLStageResult` | Yes | Not imported | Correct — Phase 3 |
| `CodeQLStats` | Yes | Not imported | Correct — Phase 3 |
| `CodeQLFinding` | Yes | Not imported | Correct — Phase 2 (SARIF parser) |
| `MatchedFinding` | Yes | Not imported | Correct — Phase 2 (node matcher) |
| `CodeQLLocation` | Yes | Not imported | Correct — Phase 2 |
| `CodeQLPathStep` | Yes | Not imported | Correct — Phase 2 |

### Config fields referenced:
| Config field | Used in runner.ts | How |
|---|---|---|
| `config.codeql.timeoutMs` | Yes | Default parameter in `createCodeQLDatabase()` and `runCodeQLAnalysis()` |
| `config.codeql.maxDiskMb` | **NO** | Not referenced anywhere in runner.ts |
| `config.codeql.enabled` | Not in runner.ts | Correct — checked by orchestrator (Phase 3) |
| `config.tempDir` | Yes | Used in `getCodeQLDbPath()` and `getSarifOutputPath()` |

---

## 3. FINDINGS

### FINDING 1 — `maxDiskMb` config is never used (MEDIUM)
**Location:** `config.ts:40`, `runner.ts` (absent)
**Issue:** `config.codeql.maxDiskMb` is defined in config but never referenced in runner.ts. The CodeQL CLI has a `--ram` flag for memory and various disk-related options, but no `--max-disk` flag is passed. The `maxDiskMb` value is read from the environment but has no effect on behavior.
**Impact:** Users setting `CODEQL_MAX_DISK_MB` would expect it to limit disk usage, but it does nothing.
**Recommendation:** Either:
- (a) Pass `--ram` flag to `codeql database create` and `codeql database analyze` (CodeQL uses `--ram` for memory limits).
- (b) Implement pre-flight disk space check: `const freeSpace = ...; if (freeSpace < config.codeql.maxDiskMb) skip`.
- (c) Document that it's reserved for future use and will be enforced in a later phase.
**Severity:** Medium — config value exists but is dead code.

### FINDING 2 — CodeQLStats field names diverge from plan (LOW)
**Location:** `types.ts:31`
**Issue:** The plan (Contract 7) specifies stats fields named `status`, `durationMs`. The type uses `codeqlStatus`, `codeqlDurationMs`. This is intentional namespacing (these stats get merged into a larger stats object), so the prefixed names avoid collision. However, the plan's spec at line 156-166 shows `status` and `durationMs` without prefixes, nested under a `codeql: { ... }` key.
**Impact:** Low — the orchestrator (Phase 3) will need to decide whether to nest under `codeql: {}` (using unprefixed names) or flatten (using prefixed names). Either works, but the plan and types disagree on the convention.
**Recommendation:** Clarify before Phase 3. If the stats are nested under `codeql: {}` in the JSON, the prefixed names are redundant and should be `status`, `durationMs`. If flattened, the prefixes are correct.

### FINDING 3 — CodeQLStats has `"partial"` status not in plan (LOW)
**Location:** `types.ts:31`
**Issue:** `CodeQLStats.codeqlStatus` includes `"partial"` as a valid value. The plan (Contract 7, line 157) specifies only `'success' | 'failed' | 'skipped' | 'timeout'`.
**Impact:** Low — `"partial"` is a reasonable addition for multi-language runs where some languages succeed and others fail. This is forward-thinking but diverges from the plan.
**Recommendation:** Accept as an enhancement, but document when `"partial"` should be set.

### FINDING 4 — CodeQLStats has `reason` field not in plan (LOW)
**Location:** `types.ts:37`
**Issue:** The `reason` field exists in the type but is not in the plan's stats shape (Contract 7). Appears to be intended for skip reasons (e.g., "not_installed", "disabled").
**Impact:** Low — additive, no breakage.
**Recommendation:** Accept as an enhancement.

### FINDING 5 — No `index.ts` barrel export (LOW)
**Location:** `packages/backend/src/pipeline/codeql/` (missing `index.ts`)
**Issue:** The plan lists `codeql/index.ts` as the orchestrator file (Phase 3). Currently there is no barrel export or index.ts. The SCIP pipeline has `scip/index.ts`. This is expected — the orchestrator is Phase 3 work.
**Impact:** None for Phase 1. Just noting it for Phase 3 tracking.

### FINDING 6 — `.env.example` not updated (LOW)
**Location:** Project root (no `.env.example` file found)
**Issue:** The plan wiring checklist says "Add env vars to .env.example: CODEQL_ENABLED, CODEQL_TIMEOUT_MS, CODEQL_MAX_DISK_MB". No `.env.example` file exists in the project at all, so this checklist item is moot.
**Impact:** None — there's no `.env.example` to update.

---

## 4. STUBS AND PLACEHOLDERS

- **No TODO/FIXME/HACK/XXX/STUB comments found.** All functions contain real logic.
- **No hardcoded return values where real logic should be.** All functions perform actual work.
- The commented-out language configs (`pythonConfig`, `javaConfig`, `goConfig` in the registry) are intentional placeholders per the plan — design for multi-language, implement JS/TS only.

---

## 5. CONFIGURATION VERIFICATION

| Env Var | Read in config.ts | Default | Matches Plan |
|---|---|---|---|
| `CODEQL_ENABLED` | Yes, `=== "true"` | false (opt-in) | Yes |
| `CODEQL_TIMEOUT_MS` | Yes, `parseInt(..., 10)` | 900000 (15 min) | Yes |
| `CODEQL_MAX_DISK_MB` | Yes, `parseInt(..., 10)` | 2048 | Yes (but unused — see Finding 1) |

---

## 6. IMPORT VERIFICATION

| Import in runner.ts | Source | Exists |
|---|---|---|
| `spawn` from `child_process` | Node.js built-in | Yes |
| `existsSync` from `fs` | Node.js built-in | Yes |
| `rm` from `fs/promises` | Node.js built-in | Yes |
| `path` from `path` | Node.js built-in | Yes |
| `config` from `../../config.js` | `packages/backend/src/config.ts` | Yes — verified codeql section exists |
| `CodeQLLanguageConfig, CodeQLRunResult` from `./types.js` | `packages/backend/src/pipeline/codeql/types.ts` | Yes — both types exported |

---

## 7. ERROR PATH VERIFICATION

| Error Scenario | Handled | How |
|---|---|---|
| CodeQL CLI not on PATH (ENOENT) | Yes | `isCodeQLAvailable()` returns false; `createCodeQLDatabase` error handler maps ENOENT to `"not_installed"` |
| Database creation timeout | Yes | `setTimeout` → `SIGKILL` → settle with timeout error |
| Analysis timeout | Yes | Same pattern as database creation |
| Non-zero exit code (database) | Yes | stderr captured and returned as error |
| Non-zero exit code (analysis) | Yes | stderr captured and returned as error |
| Cleanup failure | Yes | Caught, logged as warning, does not throw |
| Double-settle race (timeout + close) | Yes | `settled` boolean guard in all spawn functions |

---

## 8. RUNTIME ENVIRONMENT

### CodeQL binary resolution
- Uses bare `codeql` command (no path resolution). This relies on PATH.
- **Acceptable** per plan Issue 3: CodeQL is opt-in, expected to be installed by the user. The SCIP runner resolves local `node_modules/.bin` paths, but CodeQL is a standalone ~500MB CLI, not an npm package — bare PATH lookup is the correct approach.

### File paths
- `getCodeQLDbPath()` → `{tempDir}/codeql-jobs/{jobId}/{language}-db` — valid structure.
- `getSarifOutputPath()` → `{tempDir}/codeql-jobs/{jobId}/{language}-results.sarif` — valid structure.
- **Note:** The parent directory `{tempDir}/codeql-jobs/{jobId}/` is never explicitly created via `mkdir -p`. The `codeql database create` command will fail if the parent directory doesn't exist. The orchestrator (Phase 3) must ensure `mkdirSync(parentDir, { recursive: true })` is called before invoking the runner.

### The `--overwrite` flag
- `createCodeQLDatabase` passes `--overwrite` to `codeql database create`. This is **safe and correct** — it allows re-running without manually deleting the previous database. Since the path includes `jobId`, collisions between jobs won't occur. The `--overwrite` flag only overwrites the target database directory, not arbitrary files.

### Process cleanup after SIGKILL
- After timeout triggers `SIGKILL`, the CodeQL process is killed. However, `codeql database create` spawns child processes (compilers, extractors). `SIGKILL` on the parent may orphan children.
- **Mitigated** by the fact that CodeQL databases are cleaned up by `cleanupCodeQLDatabase()`, and the orchestrator should call this on failure paths. Orphaned processes will eventually exit when their parent's pipes close.

---

## 9. PATTERN ALIGNMENT WITH SCIP RUNNER

The CodeQL runner follows the same patterns as SCIP's runner.ts:
- Same `settled` boolean guard pattern for spawn races
- Same `setTimeout` → `SIGKILL` timeout pattern
- Same stderr capture pattern
- Same `CodeQLRunResult` shape (mirrors `ScipRunResult` minus `indexPath`)
- Same config registry pattern (`Map<string, Config>` with deduplication)
- **Good alignment.** No gratuitous divergences.

---

## SUMMARY

| Category | Status |
|---|---|
| Execution chains | PASS — all functions have real logic |
| Data flow (types → runner) | PASS — all imported types used correctly |
| Stubs/placeholders | PASS — none found |
| Configuration | PASS with caveat — `maxDiskMb` is dead code (Finding 1) |
| Error paths | PASS — all covered |
| Runtime environment | PASS with note — parent dirs not created (Phase 3 responsibility) |
| Pattern alignment | PASS — follows SCIP conventions |

### Blockers: None

### Action Items for Phase 2/3:
1. **Decide on `maxDiskMb` enforcement** (Finding 1) — either use it or remove it.
2. **Clarify stats field naming convention** (Finding 2) — prefixed vs nested.
3. **Ensure `mkdirp` for output directories** in orchestrator (Phase 3).

### Verdict: PHASE 1 APPROVED — proceed to Phase 2.
