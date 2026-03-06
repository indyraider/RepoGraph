# Phase 3 Audit: Log Collector + Retention

**Date:** 2026-03-06
**Phase:** 3 — Log Collector + Retention
**Status:** PASS with findings

## Files Audited

- `packages/backend/src/runtime/collector.ts` (new, 222 lines)
- `packages/backend/src/runtime/retention.ts` (new, 57 lines)
- `packages/backend/src/index.ts` (modified)

### Context files reviewed

- `packages/backend/src/lib/crypto.ts` (safeDecrypt)
- `packages/backend/src/runtime/adapters/registry.ts`
- `packages/backend/src/runtime/stack-parser.ts`
- `packages/backend/src/runtime/adapters/types.ts`

---

## Wiring Checklist Verification

| Checklist Item | Status | Notes |
|---|---|---|
| Create collector at `collector.ts` | PASS | File exists, 222 lines |
| Implement startCollector() — setInterval(10s) | PASS | Line 25: `setInterval(pollCycle, POLL_CHECK_INTERVAL_MS)` with `POLL_CHECK_INTERVAL_MS = 10_000` |
| Implement stopCollector() — clearInterval | PASS | Lines 34-39: clears interval and nulls reference |
| Collector: load adapter from registry by platform | PASS | Line 92: `getAdapter(platform)`, returns early with error if null |
| Collector: decrypt api_token using safeDecrypt | PASS | Line 105: `safeDecrypt(encryptedToken)`, null check at line 106 |
| Collector: call adapter.fetchSince(), handle errors per-source | PASS | Line 121: `adapter.fetchSince(adapterConfig, since)`, wrapped in try/catch per source (line 207) |
| Collector: run parseStackTrace() on error entries lacking file_path | PASS | Lines 129-142: checks `entry.level === "error" && !entry.filePath` |
| Collector: batch insert into runtime_logs (camelCase to snake_case) | PASS | Lines 146-165: maps all fields correctly |
| Collector: batch upsert into deployments (camelCase to snake_case) | PASS | Lines 168-196: maps all fields, uses `onConflict: "repo_id,deployment_id,source"` |
| Collector: update last_poll_at on success, last_error on failure, clear last_error on success | PASS | Line 201: sets `last_poll_at` + `last_error: null` on success; line 210: `updateSourceError` on failure |
| Create retention worker at `retention.ts` | PASS | File exists, 57 lines |
| Implement startRetention() — setInterval(1 hour) | PASS | Line 19: `setInterval(pruneOldLogs, RETENTION_CHECK_INTERVAL_MS)` with 1-hour constant |
| Implement stopRetention() — clearInterval | PASS | Lines 28-33 |
| Implement DELETE WHERE timestamp < NOW() - 30 days | PASS | Lines 39-44: computes cutoff date, `.delete().lt("timestamp", cutoff)` |
| Wire collector + retention into backend index.ts start() | PASS | Lines 114-121: guarded by `if (sbOk)`, wrapped in try/catch |
| Wire stopCollector + stopRetention into SIGINT handler | PASS | Lines 164-165 in SIGINT handler |

---

## Execution Chain Trace

### Chain 1: startCollector() -> setInterval -> pollCycle -> processSource -> adapter -> insert

1. `startCollector()` (line 21) sets `collectorInterval = setInterval(pollCycle, 10000)` and calls `pollCycle()` immediately.
2. `pollCycle()` (line 45) guards with `isPolling` flag, queries `log_sources` where `enabled = true`, iterates sources, checks due time, calls `processSource()`.
3. `processSource()` (line 83) decrypts token, builds `AdapterConfig`, calls `adapter.fetchSince()`, filters by level, parses stack traces, batch inserts logs, optionally upserts deployments, updates `last_poll_at`.
4. On error: catch block at line 207 logs and calls `updateSourceError()`. Loop continues to next source (each source is independent in the for-loop).

**Verified:** One failing source does NOT block others. The try/catch is inside the for-loop body via `processSource()` having its own try/catch.

### Chain 2: startRetention() -> setInterval -> pruneOldLogs -> delete

1. `startRetention()` (line 15) sets interval and calls `pruneOldLogs()` immediately.
2. `pruneOldLogs()` (line 36) computes 30-day cutoff, calls `.delete({ count: "exact" }).lt("timestamp", cutoff)`.
3. Logs count of pruned entries if > 0.

**Verified:** Clean and correct.

### Chain 3: index.ts wiring

1. Imports at lines 12-13: `startCollector`, `stopCollector`, `startRetention`, `stopRetention`.
2. Start: lines 114-121, after `sbOk` check, wrapped in try/catch with `console.warn` on failure.
3. Stop: lines 164-165 in SIGINT handler, called unconditionally (safe — both stop functions check for null interval).

**Verified:** Matches the plan exactly.

---

## Data Flow Analysis

### camelCase to snake_case Mapping — runtime_logs

| NormalizedLogEntry field | DB column | Mapped? |
|---|---|---|
| source | source | YES (line 149) |
| level | level | YES (line 150) |
| message | message | YES (line 151) |
| timestamp | timestamp | YES (line 152) |
| deploymentId | deployment_id | YES (line 153) |
| functionName | function_name | YES (line 154) |
| filePath | file_path | YES (line 155) |
| lineNumber | line_number | YES (line 156) |
| stackTrace | stack_trace | YES (line 157) |
| metadata | metadata | YES (line 158) |

**Additional field:** `repo_id` injected from `source.repo_id` at line 148. Correct.

**Result:** All fields covered.

### camelCase to snake_case Mapping — deployments

| NormalizedDeployment field | DB column | Mapped? |
|---|---|---|
| source | source | YES (line 174) |
| deploymentId | deployment_id | YES (line 175) |
| status | status | YES (line 176) |
| branch | branch | YES (line 177) |
| commitSha | commit_sha | YES (line 178) |
| startedAt | started_at | YES (line 179) |
| completedAt | completed_at | YES (line 180) |
| url | url | YES (line 181) |

**Additional field:** `repo_id` injected from `source.repo_id` at line 173. Correct.

**Result:** All fields covered.

### repo_id Injection

`repo_id` is extracted from the `source` row at line 86 (`const repoId = source.repo_id as string`) and injected into both log rows (line 148) and deployment rows (line 173). Correct.

### min_level Filter

Lines 124-126: `levelPriority` maps `info: 0, warn: 1, error: 2`. Default `minPriority` is `1` (warn) if `minLevel` is not in the map, via `?? 1`. Entries are filtered where `(levelPriority[e.level] ?? 0) >= minPriority`.

**Verified:** Correct. Default min_level is "warn" (line 89), meaning info logs are excluded by default.

### Stack Trace Parsing Invocation

Lines 129-142: Invoked when ALL of:
- `entry.level === "error"`
- `!entry.filePath` (no file_path already set)
- `entry.message` is truthy (implicit — only used for fallback)

Parser is called with `entry.stackTrace || entry.message` — so it tries the dedicated stackTrace field first, falls back to message body.

**Verified:** Correct per plan: "run parseStackTrace() on error entries lacking file_path."

---

## Error Path Analysis

### What happens if safeDecrypt returns null?

Lines 106-109: If `safeDecrypt(encryptedToken)` returns null, `updateSourceError()` is called with "Failed to decrypt API token (corrupt or key changed)" and the function returns early. Source is skipped, others continue.

**Verdict:** Handled correctly.

### What happens if adapter.fetchSince throws?

Line 121 is inside the try block starting at line 119. The catch at line 207 catches the error, logs it, and calls `updateSourceError()`. The source's `last_poll_at` is NOT updated (only updated on success at line 201), so it will be retried on the next tick.

**Verdict:** Handled correctly per plan.

### What happens if batch insert fails?

Lines 162-164: If the insert into `runtime_logs` fails, the error is logged but execution continues. The function proceeds to deployment upsert and then to the success block (lines 199-202), which updates `last_poll_at` and clears `last_error`.

**FINDING [MEDIUM]:** A failed log insert is treated as a success for the source. `last_poll_at` is updated and `last_error` is cleared, meaning those logs are lost forever — the next poll will start from a later cursor. The insert error is only logged to console, not propagated. The plan says "Supabase insert errors -> logged, source marked as error" (Contract 6), but the code does NOT mark the source as error on insert failure.

### What happens if deployment upsert fails?

Lines 188-189: Error is logged. Execution continues to success block. Same issue as above — the upsert failure does not prevent `last_poll_at` from advancing.

**FINDING [LOW]:** Deployment upsert failure is non-fatal by design (line 192-195 has its own try/catch with "non-fatal" comment), which is reasonable since deployments are supplementary data. However, the comment and behavior are consistent.

### Does one failing source block others?

No. `processSource()` is called inside the for-loop at line 71, and it has its own complete try/catch. A failure in one source logs the error and updates `last_error`, then the loop continues to the next source.

**Verdict:** Correct per plan.

---

## Additional Findings

### FINDING 1 [MEDIUM]: Log insert failure silently advances cursor

**Location:** `collector.ts` lines 161-165, 199-202
**Issue:** When `sb.from("runtime_logs").insert(rows)` returns an error, the code logs it to console but still advances `last_poll_at` at line 201. This means failed log entries are permanently skipped.
**Plan says:** Contract 6: "Supabase insert errors -> logged, source marked as error."
**Fix:** After insert failure, either return early (skipping the `last_poll_at` update) or call `updateSourceError()`. Example:
```typescript
if (insertError) {
  console.error(`[collector] Failed to insert logs for source ${sourceId}:`, insertError.message);
  await updateSourceError(sourceId, `Insert failed: ${insertError.message}`);
  return; // Don't advance cursor
}
```

### FINDING 2 [LOW]: pollCycle queries ALL enabled sources every tick

**Location:** `collector.ts` lines 53-56
**Issue:** The query fetches all enabled sources (`SELECT * FROM log_sources WHERE enabled = true`) every 10 seconds, then filters due sources in JS (lines 67-69). The plan specifies "query `log_sources` WHERE `enabled = true` AND `last_poll_at + polling_interval_sec < NOW()`" — i.e., the filtering should happen in the database query.
**Impact:** Low — with a small number of sources this is negligible. But it's a deviation from the plan and will scale poorly.
**Fix:** Add a `.or()` filter to the Supabase query to push the due-check to the database.

### FINDING 3 [INFO]: Overlap guard uses boolean flag, not mutex

**Location:** `collector.ts` lines 16, 46-47, 76
**Issue:** The `isPolling` flag prevents overlapping poll cycles. This is adequate for a single-process Node.js backend since `setInterval` callbacks are serialized on the event loop. However, if `pollCycle` takes longer than 10 seconds (e.g., slow adapter responses), tasks will queue up behind the flag. This is correct behavior — just noting it works as intended.

### FINDING 4 [INFO]: Both workers run immediately on start

**Location:** `collector.ts` line 28, `retention.ts` line 22
**Issue:** Both `startCollector()` and `startRetention()` call their work function immediately (not just on the first interval tick). This is good — it means logs start flowing and old data gets pruned without waiting for the first timer tick.

### FINDING 5 [INFO]: Retention deletes without batch limiting

**Location:** `retention.ts` lines 41-44
**Issue:** The DELETE query has no LIMIT. If there are millions of old rows (e.g., first run after a long accumulation), this could be a heavy query. Not a bug, but worth noting for operational awareness. A batched approach (DELETE ... LIMIT 10000 in a loop) would be gentler on the database.

### FINDING 6 [LOW]: timestamp type mismatch between interface and DB

**Location:** `types.ts` line 25: `timestamp: Date`, `collector.ts` line 152: `timestamp: e.timestamp`
**Issue:** `NormalizedLogEntry.timestamp` is typed as `Date`. The Supabase JS client can handle `Date` objects (serializes to ISO string), so this works at runtime. However, the plan and DB schema expect ISO 8601 strings. Same for `NormalizedDeployment.startedAt` and `completedAt`. This is functionally correct but could cause subtle issues if an adapter returns a non-Date value in the timestamp field.

---

## Summary

| Category | Count |
|---|---|
| Checklist items verified | 16/16 |
| PASS | 14 |
| PASS with caveat | 2 |
| FAIL | 0 |
| Findings (MEDIUM) | 1 |
| Findings (LOW) | 2 |
| Findings (INFO) | 3 |

### Critical path assessment

The collector and retention worker are correctly wired, the execution chains are sound, and all camelCase-to-snake_case mappings are complete. The one meaningful issue is that a failed log insert still advances the polling cursor, which contradicts the plan and could cause data loss. This should be fixed before Phase 4.

### Verdict: PASS — fix FINDING 1 before proceeding to Phase 4.
