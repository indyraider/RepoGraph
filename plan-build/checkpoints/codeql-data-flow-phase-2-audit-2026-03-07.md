# Phase 2 Audit: SARIF Parser + Node Matcher
**Date:** 2026-03-07
**Auditor:** Claude Opus 4.6
**Verdict:** PASS WITH ISSUES — 1 bug (must fix), 3 warnings (should fix), 2 notes

---

## Files Audited

| File | Status | Lines |
|---|---|---|
| `packages/backend/src/pipeline/codeql/sarif-parser.ts` | Present, 213 lines | Implements `parseSarif()` |
| `packages/backend/src/pipeline/codeql/node-matcher.ts` | Present, 134 lines | Implements `matchFindings()` |
| `packages/backend/src/pipeline/codeql/types.ts` | Present, 77 lines | Reference types (Phase 1) |

---

## Checklist Verification

### Wiring Item 1: `parseSarif(filePath): CodeQLFinding[]`
- [x] Function exists and is exported
- [x] Signature matches plan: `parseSarif(filePath: string): Promise<CodeQLFinding[]>`
- [x] Returns `CodeQLFinding[]` matching the type in `types.ts`
- [x] Reads file with `readFile` from `fs/promises`
- [x] Handles invalid JSON (try/catch around `JSON.parse`, throws descriptive error)
- [x] Handles empty SARIF (no runs → returns `[]`)
- [x] Handles runs with no results (`if (!run.results) continue`)
- [x] Extracts `ruleId` as `queryId` (falls back to `"unknown"`)
- [x] Maps `level` to severity correctly (`error`/`warning`/`note`/`none`)
- [x] Severity cascade: result-level overrides rule-level default
- [x] Deduplication by `queryId:sourceFile:sourceLine:sinkFile:sinkLine`
- [x] codeFlows extraction: first threadFlow, first + last locations
- [x] Fallback for non-codeFlow results: primary location as source = sink
- [x] pathSteps includes ALL steps (source through sink), not just intermediates

### Wiring Item 2: `matchFindings(findings, repoUrl, session): MatchedFinding[]`
- [x] Function exists and is exported
- [x] Signature: `matchFindings(findings, repoUrl, session): Promise<{ matched, unmatchedCount }>`
- [x] Cypher query finds innermost Function node (ORDER BY range ASC, LIMIT 1)
- [x] Uses `elementId(f)` — consistent with Neo4j 5+ (no other files in the pipeline use `elementId`, but this is the correct modern API)
- [x] Drops findings where both source AND sink are unmatched
- [x] Keeps findings with one unmatched side, sets `pathComplete: false`
- [x] Logs unmatched and partial matches
- [x] Empty findings input returns early
- [x] Batch deduplication via `buildLocationMap` avoids redundant queries

---

## BUG — Must Fix

### BUG-1: `buildLocationMap` splits on first colon — breaks Windows paths and file paths containing colons (SEVERITY: HIGH)

**Location:** `node-matcher.ts:53`

```typescript
const [file, lineStr] = key.split(":");
```

This destructuring takes only the first two segments of a `":"` split. For a key like `src/utils/helpers.ts:42`, this works correctly. But consider:

- **Windows-style paths** (unlikely in SARIF but possible): `C:\src\file.ts:42` → `file = "C"`, `lineStr = "\\src\\file.ts"` — completely wrong.
- **Paths with colons** (valid on some filesystems, or from URI-encoded SARIF): `src/time:zone/config.ts:10` → `file = "src/time"`, `lineStr = "zone/config.ts"` — completely wrong.

More importantly, the key is constructed at line 48 with template literal `${loc.file}:${loc.line}`, and then destructured by splitting on `:`. This round-trip breaks whenever the file path itself contains a colon.

**Fix:** Use `lastIndexOf(":")` to split on the LAST colon, since line numbers never contain colons:

```typescript
const lastColon = key.lastIndexOf(":");
const file = key.substring(0, lastColon);
const lineStr = key.substring(lastColon + 1);
const line = parseInt(lineStr, 10);
```

**Alternative fix:** Store the locations as structured objects instead of stringifying them:

```typescript
const uniqueLocations: Map<string, CodeQLLocation> = new Map();
for (const loc of locations) {
  const key = `${loc.file}:${loc.line}`;
  if (!uniqueLocations.has(key)) {
    uniqueLocations.set(key, loc);
  }
}
for (const [key, loc] of uniqueLocations) {
  const nodeId = await matchLocationToNode(session, repoUrl, loc);
  locationMap.set(key, nodeId);
}
```

This avoids the parse-back-from-string problem entirely by keeping the original structured `CodeQLLocation` around.

---

## WARNINGS — Should Fix

### WARN-1: `extractSourceSink` requires `>= 2` threadFlow locations — drops single-step flows (SEVERITY: MEDIUM)

**Location:** `sarif-parser.ts:107`

```typescript
if (threadFlow && threadFlow.locations.length >= 2) {
```

If a codeFlow has exactly 1 location (source IS the sink — e.g., a tainted value used immediately), this condition fails and execution falls through to the `result.locations` fallback. That fallback works, but:

1. The pathSteps from the fallback use the result's primary location and message, not the codeFlow's location and message. These may differ.
2. A codeFlow with 1 step is a valid SARIF construct and should be handled explicitly.

**Fix:** Change `>= 2` to `>= 1` and handle the single-step case:

```typescript
if (threadFlow && threadFlow.locations.length >= 1) {
  const steps = threadFlow.locations;
  const sourceLoc = extractLocation(steps[0].location);
  const sinkLoc = steps.length > 1
    ? extractLocation(steps[steps.length - 1].location)
    : sourceLoc;
  // ...
}
```

### WARN-2: `matchFindings` return type differs from plan contract (SEVERITY: MEDIUM)

**Plan (Contract 4, line 109):** `matchFindings(findings, repoUrl, session): MatchedFinding[]`

**Actual:** Returns `Promise<{ matched: MatchedFinding[]; unmatchedCount: number }>`

The return type is a wrapper object, not a bare array. This is arguably better than the plan (it includes the unmatched count), but downstream consumers (the loader/orchestrator in Phase 3) need to know about this. The orchestrator code must destructure `{ matched, unmatchedCount }` instead of treating the result as `MatchedFinding[]`.

**Action:** This is fine to keep — it's an improvement. Just ensure Phase 3 accounts for this signature. Flag for Phase 3 builder.

### WARN-3: No Neo4j error handling in `matchLocationToNode` (SEVERITY: MEDIUM)

**Location:** `node-matcher.ts:17-32`

`session.run()` can throw if Neo4j is unavailable or the query fails. Currently, any Neo4j error will propagate unhandled through `buildLocationMap` and out of `matchFindings`. The plan says "Neo4j query failures" should be handled.

Per the plan (Contract 5): "orchestrator catches" — so the orchestrator in Phase 3 must wrap `matchFindings()` in a try/catch. This is acceptable IF the orchestrator actually does so. But the node-matcher itself could be more defensive for partial failures (e.g., one bad query shouldn't abort ALL location matching).

**Suggestion:** Wrap the `session.run()` in `matchLocationToNode` with a try/catch that logs the error and returns `null` instead of crashing the entire matching process:

```typescript
try {
  const result = await session.run(...);
  // ...
} catch (err) {
  console.warn(`[codeql] Neo4j query failed for ${location.file}:${location.line}:`, err);
  return null;
}
```

---

## NOTES — Informational

### NOTE-1: Sequential Neo4j queries in `buildLocationMap` could be slow for large finding sets

**Location:** `node-matcher.ts:52-61`

Each unique location fires a separate `session.run()` query sequentially. For a SARIF with 500 findings across 200 unique locations, this means 200 sequential round-trips to Neo4j.

This is acceptable for MVP. For optimization later, consider a single Cypher `UNWIND` query:

```cypher
UNWIND $locations AS loc
MATCH (f:Function {repo_url: $repoUrl, file_path: loc.file})
WHERE f.start_line <= loc.line AND f.end_line >= loc.line
WITH loc, f ORDER BY (f.end_line - f.start_line) ASC
WITH loc, collect(f)[0] AS bestMatch
RETURN loc.file AS file, loc.line AS line, elementId(bestMatch) AS nodeId
```

### NOTE-2: `extractLocation` strips `file://` and `./` but not other URI schemes

**Location:** `sarif-parser.ts:67`

```typescript
const file = uri.replace(/^file:\/\//, "").replace(/^\.\//, "");
```

CodeQL SARIF may also include `file:///` (triple slash for absolute paths). The regex `^file:\/\/` matches `file://` which would leave a leading `/` from `file:///path`. This seems intentional (preserving absolute paths), but worth noting.

Additionally, no percent-decoding is performed (e.g., `%20` in paths). Unlikely with CodeQL output, but worth a comment.

---

## Data Flow Verification

### Types Flow: `sarif-parser.ts` → `types.ts` → `node-matcher.ts`

| Type | Defined in | Used in sarif-parser | Used in node-matcher |
|---|---|---|---|
| `CodeQLLocation` | types.ts:42-46 | Imported, constructed | Imported, parameter type |
| `CodeQLPathStep` | types.ts:49-52 | Imported, constructed | Not used (correct — passed through via spread) |
| `CodeQLFinding` | types.ts:55-62 | Imported, returned | Imported, input parameter |
| `MatchedFinding` | types.ts:65-69 | Not imported (correct) | Imported, returned |

All type flows are correct. `MatchedFinding extends CodeQLFinding` and adds `sourceNodeId`, `sinkNodeId`, `pathComplete` — all three are populated in `node-matcher.ts:120-124`.

### Import Paths

Both files use `./types.js` imports (ESM with `.js` extension). Consistent with codebase convention.

---

## Edge Case Analysis

| Scenario | sarif-parser | node-matcher |
|---|---|---|
| Empty SARIF (no runs) | Returns `[]` (line 163-165) | N/A |
| Empty SARIF (runs with no results) | Skips via `continue` (line 182) | N/A |
| Empty findings array | N/A | Returns `{ matched: [], unmatchedCount: 0 }` (line 80-82) |
| codeFlows with 1 location | Falls through to `result.locations` fallback — **WARN-1** | N/A |
| File path with colon | N/A | **BUG-1** — incorrect split |
| Invalid JSON | Throws `"Invalid SARIF JSON in {path}"` | N/A |
| File not found | `readFile` throws ENOENT — propagates to caller | N/A |
| Missing ruleId | Falls back to `"unknown"` (line 185) | N/A |
| Missing message text | Falls back to `""` (line 202) | N/A |
| Missing startColumn | Falls back to `1` (line 73) | N/A |
| Duplicate findings | Deduplicated by query+source+sink key | N/A |
| No Function node match | N/A | Returns `null`, counted as unmatched |
| Both source+sink unmatched | N/A | Finding dropped with warning log |
| One side unmatched | N/A | Finding kept, `pathComplete: false` |

---

## Summary

**Must fix before Phase 3:**
1. **BUG-1:** `buildLocationMap` colon-split breaks file paths containing colons. Use `lastIndexOf(":")` or keep structured objects.

**Should fix (recommended before Phase 3):**
1. **WARN-1:** Single-step codeFlows (length === 1) fall through to a different extraction path with potentially different metadata.
2. **WARN-2:** Return type of `matchFindings` is `{ matched, unmatchedCount }` not bare `MatchedFinding[]` — Phase 3 builder must account for this.
3. **WARN-3:** Neo4j errors in `matchLocationToNode` crash the entire matching process instead of gracefully degrading.

**No action needed:**
1. **NOTE-1:** Sequential Neo4j queries acceptable for MVP, optimize later with UNWIND.
2. **NOTE-2:** URI handling is adequate for CodeQL output.
