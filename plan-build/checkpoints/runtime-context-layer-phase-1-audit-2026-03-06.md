# Phase 1 Dependency Audit
**Phase:** Foundation (Database + Types + Crypto)
**Date:** 2026-03-06
**Status:** ISSUES FOUND

## Verified Connections

### 1. Migration: supabase-runtime-migration.sql
- **3 tables created:** `log_sources`, `deployments`, `runtime_logs` — all present with correct columns.
- **`last_error TEXT`** column on `log_sources` (line 18) — present, matches plan requirement.
- **`UNIQUE(repo_id, deployment_id, source)`** on `deployments` (line 38) — present, matches plan.
- **Compound index `idx_runtime_logs_repo_timestamp`** on `(repo_id, timestamp DESC)` (line 79) — present, matches plan.
- **GIN full-text index** on `runtime_logs.message` (line 83) — present, needed for Phase 5 `search_logs` tool.
- **All FK references** point to `repositories(id) ON DELETE CASCADE` — correct, consistent with existing schema pattern.
- **`runtime_logs` columns** match the plan's Contract 6 insert shape exactly: `repo_id, source, level, message, timestamp, deployment_id, function_name, file_path, line_number, stack_trace, metadata`.
- **`deployments` columns** match `NormalizedDeployment` fields (camelCase to snake_case mapping): `source, deployment_id, status, branch, commit_sha, started_at, completed_at, url`.
- **`log_sources` columns** match the plan's Contract 1 response shape and Contract 2 storage requirements.

### 2. Crypto Module: packages/backend/src/lib/crypto.ts
- **Location:** File is at `packages/backend/src/lib/crypto.ts`, matching the wiring checklist. (The Component Inventory table says `packages/backend/src/runtime/crypto.ts` — minor plan inconsistency, but the checklist is authoritative.)
- **Imports `config` from `../config.js`** — verified `config.ts` exists at that relative path and exports `config.sessionSecret` (line 26 of config.ts).
- **`deriveKey()`** uses `scryptSync` with salt `"repograph-connections"` — consistent with original connections.ts context, ensures backward compatibility with any pre-existing encrypted connection data.
- **`encrypt()`** returns `iv:tag:ciphertext` format (all base64). AES-256-GCM with 12-byte IV — correct usage.
- **`decrypt()`** splits on `:` and reconstructs — matches encrypt output format.
- **`encryptCredentials()` / `decryptCredentials()`** iterate over key-value pairs. `decryptCredentials` has try/catch per key, returning `""` for corrupt entries — safe.
- **`maskValue()`** handles short values (<= 8 chars) with full masking — safe.

### 3. connections.ts: Imports from Shared Crypto
- **File:** `packages/backend/src/connections.ts` (untracked, new file from connections migration).
- **Line 3-7:** Imports `encryptCredentials`, `decryptCredentials`, `maskValue` from `./lib/crypto.js` — correct relative path.
- **No residual inline crypto functions** — all encryption logic lives in the shared module.
- **Usage verified:** `decryptCredentials` called on lines 38, 71, 72; `encryptCredentials` called on line 115; `maskValue` called on line 41.

### 4. Adapter Interface Types: packages/backend/src/runtime/adapters/types.ts
- **`AdapterConfig`** shape: `{ apiToken: string; platformConfig: Record<string, unknown> }` — matches plan's Contract 3 exactly.
- **`NormalizedLogEntry`** fields match the plan's Contract 6 insert shape. `level` is typed as `"info" | "warn" | "error"` union — matches plan.
- **`NormalizedLogEntry.timestamp`** is `Date` type — Supabase JS client serializes Date to ISO 8601 for TIMESTAMPTZ columns, so this is compatible.
- **`NormalizedDeployment`** fields map to `deployments` table columns (camelCase to snake_case).
- **`ConnectionResult`** type: `{ ok: boolean; error?: string; meta?: { latestLogTimestamp?, entryCount? } }` — matches plan's test connection flow.
- **`LogAdapter` interface:** `testConnection`, `fetchSince` (required), `fetchDeployments` (optional with `?`) — matches plan. Adapters that don't support deployment listing can omit it.

### 5. Stack Parser: packages/backend/src/runtime/stack-parser.ts
- **`ParsedFrame`** interface: `{ filePath, lineNumber, columnNumber?, functionName? }` — matches plan's Contract 5 exactly.
- **`parseStackTrace()` signature:** `(stackTrace: string) => ParsedFrame[]` — matches plan.
- **Never throws:** Falsy input returns `[]` (line 50). Non-matching lines are simply skipped. No throw statements in the function.
- **Node.js regex** handles both `at fn (file:line:col)` and `at file:line:col` forms.
- **Python regex** handles `File "path", line N, in func` form.
- **Go regex** handles `path.go:line` form.
- **Path prefix stripping** covers: `/var/task/`, `/app/`, `/home/<user>/`, `/opt/<name>/`, `/workspace/` — matches plan's normalization requirement.
- **Noise filtering:** Skips `node_modules/`, `node:` internal frames, Python `site-packages/`, Go `/pkg/mod/` — good, only user code frames returned.

### 6. Directory Structure
- `packages/backend/src/runtime/` exists with `adapters/` subdirectory and `stack-parser.ts` — matches plan.
- `packages/backend/src/lib/` exists with `crypto.ts` — matches plan.

## Stubs & Placeholders Found

**None.** All functions in this phase have complete implementations. No TODO/FIXME comments. No empty function bodies. No hardcoded return values where real data should flow.

## Broken Chains

### ISSUE 1: `decrypt()` has no error handling — downstream callers must wrap (Medium Severity)

**Location:** `packages/backend/src/lib/crypto.ts`, lines 23-31

The bare `decrypt()` function does NOT have try/catch. If called with a corrupt ciphertext or wrong session secret, it throws a raw `Error` from Node's `crypto` module (e.g., `Unsupported state or unable to authenticate data`).

`decryptCredentials()` wraps `decrypt()` in try/catch (line 45-48), so connections.ts is safe. However, the plan's Contract 3 says the collector will call `decrypt()` directly on the single `api_token` string — NOT `decryptCredentials()`. If the collector calls bare `decrypt()` with a corrupt token, it will throw and could crash the poll cycle if not caught.

**Impact:** Phase 3 (collector) must either: (a) use try/catch around `decrypt()` calls, or (b) a `safeDecrypt()` wrapper should be added to the crypto module now.

**Recommendation:** Add a `safeDecrypt()` export that returns `null` on failure, or document that bare `decrypt()` is intentionally throw-on-failure and the collector must catch.

### ISSUE 2: Plan Component Inventory location mismatch (Low Severity)

**Location:** Plan line 24 says `packages/backend/src/runtime/crypto.ts`. Wiring checklist (line 458) says `packages/backend/src/lib/crypto.ts`. File was correctly placed at `lib/crypto.ts` per the checklist.

**Impact:** None on code. Future phases referencing the Component Inventory table may look for crypto at the wrong path. The collector in Phase 3 needs to import from `../lib/crypto.js`, not `./crypto.js`.

**Recommendation:** Update the Component Inventory table in the plan to reflect the actual location.

## Missing Configuration

**None.** All imports resolve:
- `crypto.ts` imports `crypto` (Node built-in) and `config` from `../config.js` (verified exists with `sessionSecret` property).
- `connections.ts` imports from `./lib/crypto.js` (verified exists).
- `stack-parser.ts` has no external imports (pure function module).
- `adapters/types.ts` has no imports (pure type definitions).

## Additional Observations

### Stack Parser Limitations (Not Bugs — Noted for Awareness)

1. **Go function names not captured:** Go stack traces put the function name on the line above the file:line reference. The parser's line-by-line approach doesn't capture this. `functionName` is optional in `ParsedFrame`, so this is acceptable but worth noting for Phase 5 (trace_error) where function names feed into Neo4j lookups.

2. **Go regex has redundant `\s*`:** The regex `GO_FRAME = /^\s*(.+\.go):(\d+)/` uses `\s*` after `^`, but the input is already `trimmed`. Not a bug — just dead code in the pattern.

3. **No Java/Ruby/Rust parsers:** The plan only specifies Node.js, Python, and Go. Java stack traces (`at com.example.Foo.bar(Foo.java:42)`) would partially match the Node.js regex but produce incorrect file paths. If Java apps are connected in the future, this will need a dedicated pattern. Not a Phase 1 concern.

### Crypto: Session Secret Default Value

`config.sessionSecret` defaults to `"dev-secret-change-me"` (config.ts line 26). In development, this is fine. In production, if `SESSION_SECRET` env var is unset, all encryption uses this weak default. This is an existing concern (predates this phase) but worth flagging since runtime log source API tokens will now also be encrypted with this key.

## Summary

**8 of 9 checklist items verified as correctly implemented.** The 9th item (update connections.ts to import from shared crypto) is also correct — connections.ts was written fresh with the shared import rather than being refactored from an existing committed file.

**1 medium-severity issue:** `decrypt()` lacks error handling and the collector (Phase 3) will need to handle this. Recommend adding a `safeDecrypt()` wrapper or documenting the throw behavior.

**1 low-severity issue:** Plan Component Inventory table has wrong path for crypto module. Actual file matches the wiring checklist. Recommend updating the plan table.

**No stubs, no placeholders, no missing configuration, no broken imports.** All data flow contracts between Phase 1 artifacts and downstream phases are correctly shaped. The migration schema, adapter types, stack parser output, and crypto functions are all mutually consistent and ready for Phase 2 (Adapters + Registry) to build upon.
