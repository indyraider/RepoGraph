# RepoGraph — Feature Add-On PRD: Runtime Heatmapping

**Add-On To:** RepoGraph v1.0 PRD  
**Version:** 1.0  
**Date:** March 7, 2026  
**Status:** Draft  
**Phase:** 5 Extension (depends on Runtime Context Layer)  

---

## 1. Overview

Runtime heatmapping upgrades the Phase 5 Runtime Context Layer from a log viewer into a quantitative production intelligence layer. Where Phase 5 captures log messages and error traces, the heatmap captures *metrics*: how often a function is invoked, how frequently it errors, how long it takes, and how those numbers trend over time. It maps these metrics directly onto the code graph — so every Function and File node in Neo4j carries a production profile.

Without heatmapping, Claude Code can tell you *that* `processPayment` errored. With it, Claude Code knows that `processPayment` handles 12,000 invocations per day, errors 2.3% of the time, has a p95 latency of 820ms, and that its error rate doubled after last Tuesday's deploy. This is information Claude has zero access to through file reading — no amount of `cat` and `grep` will surface production invocation counts.

The direct impact on development is risk awareness. When Claude Code is about to refactor a function, add a dependency, or change an interface, the heatmap tells it whether it is touching a hot path that processes half the application's traffic or a cold utility that fires once a week. That distinction changes everything — the level of caution, the testing strategy, the rollout approach, and whether Claude should suggest the change at all.

---

## 2. Problem Statement

Phase 5 gives Claude Code access to runtime *events* — individual log entries, error messages, stack traces. This is valuable for debugging specific incidents, but it leaves three critical gaps that affect how Claude operates during active development:

**No production volume awareness.** Claude Code cannot distinguish between a function that handles 50,000 requests per day and one that is effectively dead code. Both look identical in the graph. When Claude is asked to refactor a module, it treats every function with equal weight — but the developer knows intuitively that touching the payments hot path requires more caution than touching a one-off migration script. That intuition is not in the graph, and Claude cannot develop it from log messages alone.

**No error rate context for code changes.** Phase 5 can show Claude the *most recent* errors. But during active development, the important question is not "what errored last" — it is "how reliable is this code in production right now?" A function that errored once in a million invocations is healthy. A function that errors on 5% of calls is broken. Phase 5 cannot distinguish these because it stores events, not rates. Claude Code therefore cannot assess whether a given area of code is healthy, degraded, or failing — and cannot prioritize its own work accordingly.

**No performance profile for architectural decisions.** When Claude Code suggests splitting a module, adding a caching layer, or introducing an abstraction, it should factor in the runtime performance characteristics of the code it is touching. A function with a p95 latency of 2 seconds is a candidate for optimization. A function that responds in 5ms is not. Without performance metrics mapped to the code graph, Claude makes architectural suggestions that are structurally sound but performance-blind.

**No change-impact correlation.** The developer deploys a change and something degrades. Phase 5 shows the new errors. But the heatmap shows something subtler: the error rate on `processPayment` went from 0.5% to 3.2% coinciding with deployment `deploy_abc`. Without heatmapping, Claude can report the errors. With heatmapping, Claude can report the *regression* — and link it to the structural change that caused it, using the code graph.

---

## 3. Goals & Non-Goals

### 3.1 Goals

1. Aggregate runtime logs into per-function and per-file metrics: invocation count, error count, error rate, and latency percentiles (p50, p95, p99).
2. Map aggregated metrics onto Neo4j graph nodes so Claude Code can query "what are the hottest functions in this module" or "what's the error rate on this endpoint."
3. Compute metrics over configurable time windows (last hour, last 24 hours, last 7 days) to give Claude both current state and recent trend.
4. Detect metric regressions correlated with deployments — error rate spikes, latency increases, invocation pattern changes — and surface them proactively through MCP tools.
5. Store metric time-series in Supabase for trend queries and historical comparison.
6. Expose heatmap data through new MCP tools and enrich existing tools with production context.
7. Build on the Phase 5 log infrastructure — no new external data sources required. Metrics are computed from the same Vercel and Railway logs already being collected.

### 3.2 Non-Goals

- Application Performance Monitoring (APM) replacement. This is not Datadog or New Relic. It is a lightweight metrics layer derived from existing logs, not a full observability platform.
- Custom instrumentation or SDK integration. The heatmap works with whatever logs Vercel and Railway already produce. If a function does not appear in logs, it does not appear in the heatmap.
- Sub-second metric freshness. Metrics are computed from polled logs. Latency from log event to queryable metric is bounded by the polling interval (default 30 seconds) plus aggregation time. This is not real-time monitoring.
- Alerting or paging. The heatmap informs Claude Code's decisions during development sessions. It does not send notifications or trigger alerts outside of Claude Code.
- Metrics for upstream dependencies. If `stripe.charges.create` is slow, that appears as latency on the calling function, not as a metric on the Stripe package node.

---

## 4. How Heatmapping Fits the Existing System

The heatmap does not modify the digest pipeline. It operates entirely on the runtime side — consuming data that Phase 5's log collector already writes to Supabase, aggregating it into metrics, and mapping those metrics onto graph nodes.

### 4.1 Data Flow

```
Phase 5 Log Collector (already running)
    ↓ writes to
Supabase runtime_logs table (already exists)
    ↓ read by
Metric Aggregator (new background worker)
    ↓ computes
Supabase function_metrics table (new)
    ↓ mapped to
Neo4j Function/File nodes via file_path + function_name
    ↓ exposed through
MCP Server heatmap tools (new)
```

The critical design choice: metrics are stored in Supabase, not Neo4j. Time-series aggregation is a Postgres strength. The mapping to graph nodes happens at query time — the MCP server joins Supabase metrics with Neo4j structural data when a tool is called.

### 4.2 Relationship to Other Phases

**Phase 2 (Structural Graph):** The heatmap maps metrics onto Function and File nodes. Without the structural graph, metrics would be keyed to raw file paths and function names with no relational context. With it, Claude can ask "show me the hottest functions in the import chain of `processPayment`" — a query that joins heatmap data with graph traversal.

**Phase 5 (Runtime Context Layer):** The heatmap is a direct consumer of Phase 5's log data. It adds no new data sources. It transforms event-level data into aggregate metrics. Phase 5 answers "what happened?" The heatmap answers "how often does this happen, and is it getting worse?"

**Phase 6 (Temporal Graph):** The heatmap and temporal graph are complementary lenses on change. The temporal graph tracks *structural* change over time (when did this function's signature change). The heatmap tracks *runtime behavior* change over time (when did this function's error rate spike). Together they enable a powerful composite query: "this function's error rate spiked on March 3 → the temporal graph shows its signature changed on March 2 → that commit was authored by X."

**Name Resolution:** Resolved import chains allow the heatmap to propagate risk. If a hot-path function imports a utility, and that utility changes, the heatmap context on the hot-path function makes Claude Code more cautious about the utility change even though the utility itself might be low-traffic.

---

## 5. Technical Specification

### 5.1 Metric Aggregation

The Metric Aggregator is a background worker that runs periodically (default: every 5 minutes). It reads recent `runtime_logs` entries from Supabase, groups them by function identity, and computes aggregate metrics.

**Function identity:** A function is identified by the tuple `(repo_id, file_path, function_name)`. These fields are already extracted from log entries and stack traces by the Phase 5 log collector. For Vercel serverless functions, `function_name` maps to the route handler. For Railway services, `function_name` is extracted from structured log fields or stack traces.

**Aggregation windows:** Metrics are computed over three rolling windows:

| Window | Purpose |
|---|---|
| Last 1 hour | Current state. "Is this function healthy right now?" |
| Last 24 hours | Recent baseline. "What's the normal pattern for this function?" |
| Last 7 days | Trend. "Is this getting better or worse?" |

**Computed metrics per function per window:**

| Metric | Type | Computation |
|---|---|---|
| `invocation_count` | int | Count of log entries (info + warn + error) |
| `error_count` | int | Count of error-level log entries |
| `error_rate` | float | `error_count / invocation_count` (0.0–1.0) |
| `warn_count` | int | Count of warn-level log entries |
| `latency_p50` | int (ms) | 50th percentile of duration, if available in log metadata |
| `latency_p95` | int (ms) | 95th percentile |
| `latency_p99` | int (ms) | 99th percentile |
| `last_error_at` | datetime | Timestamp of most recent error |
| `last_invocation_at` | datetime | Timestamp of most recent invocation |

**Latency computation:** Vercel logs include function duration in the metadata jsonb column. Railway logs may include duration depending on the application's logging configuration. If duration data is not available for a function, latency metrics are null — not zero. The MCP tools clearly indicate when latency data is unavailable vs. when latency is actually low.

### 5.2 Regression Detection

The aggregator compares the 1-hour window against the 24-hour window to detect regressions. A regression is flagged when:

| Condition | Threshold | Severity |
|---|---|---|
| Error rate increase | 1-hour rate > 2× 24-hour rate AND absolute increase > 1% | `warning` |
| Error rate spike | 1-hour rate > 5× 24-hour rate OR absolute rate > 10% | `critical` |
| Latency increase | 1-hour p95 > 2× 24-hour p95 AND absolute increase > 200ms | `warning` |
| Latency spike | 1-hour p95 > 5× 24-hour p95 OR absolute p95 > 5000ms | `critical` |
| New errors | Function had zero errors in 24-hour window but has errors in 1-hour window | `info` |
| Traffic drop | 1-hour invocation rate < 0.1× 24-hour rate (adjusted for time of day) | `info` |

Detected regressions are stored in a `metric_regressions` table and correlated with the most recent deployment from the `deployments` table. The MCP server surfaces these proactively when Claude queries related functions.

### 5.3 Deployment Correlation

When a regression is detected, the aggregator checks the `deployments` table for any deployment that completed within the regression window. If found, the regression is annotated with the deployment ID, commit SHA, and branch. This enables the composite query: "error rate spiked → correlated with deployment X → that deployment included commit Y → here's what changed in that commit."

The correlation is temporal (deployment happened before the regression started) and is presented as a *correlation*, not a causal claim. Claude Code evaluates whether the correlation is causal using the code graph — checking whether the deployment actually touched the affected function or its dependencies.

### 5.4 Supabase Schema Additions

| Table | Columns | Purpose |
|---|---|---|
| function_metrics | id, repo_id, file_path, function_name, window (1h\|24h\|7d), invocation_count, error_count, error_rate, warn_count, latency_p50, latency_p95, latency_p99, last_error_at, last_invocation_at, computed_at | Aggregated per-function metrics per time window |
| metric_regressions | id, repo_id, file_path, function_name, regression_type (error_rate\|latency\|traffic), severity (info\|warning\|critical), current_value, baseline_value, detected_at, deployment_id, resolved_at | Detected regressions with deployment correlation |
| metric_snapshots | id, repo_id, file_path, function_name, timestamp, invocation_count, error_count, latency_p50, latency_p95 | Hourly snapshots for trend queries. Retained for 30 days, then aggregated to daily. |

**Indexes:**

- `function_metrics`: composite on `(repo_id, file_path, function_name, window)` for fast lookup.
- `metric_regressions`: composite on `(repo_id, severity, detected_at)` for "show me active regressions."
- `metric_snapshots`: composite on `(repo_id, file_path, function_name, timestamp)` for trend queries.

### 5.5 Mapping Metrics to the Code Graph

Metrics live in Supabase. The code graph lives in Neo4j. The join happens at query time in the MCP server, not at storage time.

When an MCP tool needs to return metrics for a graph node, the flow is:

1. Query Neo4j for the Function node → get `file_path` and `name`.
2. Query Supabase `function_metrics` for the matching `(repo_id, file_path, function_name)`.
3. Merge the results and return to Claude Code.

This keeps Neo4j focused on structural data and Supabase focused on time-series data. The alternative — storing metrics as properties on Neo4j nodes — was rejected because metrics update every 5 minutes and Neo4j property updates on every node are unnecessarily expensive for data that is not used in graph traversals.

**Matching accuracy:** The join depends on `file_path` and `function_name` being consistent between log entries (Phase 5) and graph nodes (Phase 2). Phase 5 extracts these from stack traces and structured log fields. Phase 2 extracts them from source code via tree-sitter. Mismatches occur when:

- Minified/bundled production code uses different paths than source. Mitigation: source map support (already a Phase 5 goal).
- A function is anonymous or arrow-function-assigned. Mitigation: fall back to file-level metrics when function-level matching fails.
- The function name in the log does not match the function name in the AST (e.g., decorated functions, method aliases). Mitigation: a configurable alias map in the digest config.

Unmatched metrics are stored and queryable at the file level even when function-level matching fails. The MCP server clearly indicates the match confidence.

### 5.6 Heat Tiers

For intuitive querying, functions are classified into heat tiers based on their metrics:

| Tier | Criteria | Label |
|---|---|---|
| `critical_path` | Top 5% by invocation count AND error rate < 1% | High traffic, healthy — the backbone |
| `hot` | Top 20% by invocation count | High traffic |
| `warm` | 20th–60th percentile by invocation count | Moderate traffic |
| `cold` | Bottom 40% by invocation count | Low traffic |
| `dead` | Zero invocations in the 7-day window | Possibly unused in production |
| `degraded` | Any active `warning` or `critical` regression | Currently unhealthy |

Tiers are computed during the aggregation cycle and stored as a column on `function_metrics`. Claude Code can query by tier: "show me all degraded functions in the payments module" or "what are the critical path functions that this PR touches."

---

## 6. MCP Server Specification

### 6.1 New Heatmap Tools

| Tool Name | Description | Key Parameters |
|---|---|---|
| get_function_heatmap | Return production metrics for a specific function: invocation count, error rate, latency percentiles, heat tier, and any active regressions. | repo (string), file_path (string), function_name (string), window? (1h\|24h\|7d, default 24h) |
| get_hot_paths | Return the highest-traffic functions in a repo, module, or directory. Answers "what are the most important functions in production?" | repo (string), path? (string — file or directory), limit? (int, default 20), min_invocations? (int) |
| get_degraded_functions | Return all functions with active regressions (error rate spikes, latency increases). Answers "what's broken or degrading right now?" | repo (string), severity? (info\|warning\|critical), source? (vercel\|railway\|all) |
| get_change_risk | Given a list of files or functions about to be changed, return their production profiles — invocation counts, error rates, heat tiers, and any active regressions. Designed to be called before Claude makes a code change. | repo (string), targets (string[] — file paths or function names) |
| get_metric_trend | Return the time-series trend for a function's metrics over a specified period. Answers "how has this function's error rate changed over the last week?" | repo (string), file_path (string), function_name (string), metric (invocation_count\|error_rate\|latency_p95), since? (ISO timestamp), granularity? (hourly\|daily) |
| get_deploy_impact | For a given deployment, show which functions' metrics changed after the deploy. Answers "what did this deploy affect in production?" | repo (string), deployment_id? (string), last_n_deploys? (int, default 1) |

### 6.2 Enrichments to Existing Tools

Existing MCP tools gain production context annotations:

| Tool | Enrichment |
|---|---|
| get_symbol | Response includes the function's heat tier, 24h invocation count, and error rate when heatmap data is available. Claude sees "this function is on the critical path (45K invocations/day, 0.1% error rate)" alongside the structural information. |
| get_dependencies | Each dependency in the response is annotated with its heat tier. Claude sees which dependencies are on hot paths and which are cold. |
| trace_imports | Each node in the import chain includes its heat tier. Claude can identify where a hot-path dependency chain transitions to cold code — a common source of overlooked risk. |
| trace_error | The error trace response includes the function's recent metrics: invocation count, error rate, and whether the error rate constitutes a regression from the baseline. |
| get_deploy_errors | Error results include per-function regression annotations: "this function's error rate went from 0.2% to 4.1% in this deployment." |

### 6.3 Active Development Workflows

These workflows show how the heatmap changes Claude Code's behavior during active development — not just debugging.

**"Refactor this module" — risk-aware refactoring:**

1. Developer asks Claude to refactor `src/api/payments/`.
2. Claude calls `get_hot_paths(path="src/api/payments/")` → learns `processPayment` handles 45K calls/day and `validateOrder` handles 38K calls/day.
3. Claude calls `get_change_risk(targets=["src/api/payments/processPayment.ts", "src/api/payments/validateOrder.ts"])` → sees both are `critical_path` tier with low error rates.
4. Claude adjusts its approach: suggests incremental refactoring with backward-compatible interfaces rather than a big-bang rewrite. Recommends adding feature flags. Prioritizes test coverage for the hot functions.

**"Add error handling to this function" — proportional response:**

1. Claude is about to add error handling to a function.
2. Claude calls `get_function_heatmap(function_name="formatCurrency")` → sees 200 invocations/day, 0% error rate, `warm` tier.
3. Claude adds basic try/catch with logging — appropriate for a low-risk utility.
4. Compare: if the same request were for `processPayment` at `critical_path` tier, Claude would add comprehensive error handling with retry logic, circuit breaking, and alerting integration.

**"What should I work on?" — production-informed prioritization:**

1. Developer asks Claude what to focus on.
2. Claude calls `get_degraded_functions()` → finds 3 functions with active regressions.
3. Claude calls `get_function_heatmap` for each → ranks them by blast radius (invocation count × error rate increase).
4. Claude recommends: "The highest-impact issue is `handleWebhook` — it processes 8K events/day and its error rate jumped from 0.3% to 7.2% after yesterday's deploy. I'd start there."

**"Review this PR" — impact-aware code review:**

1. Developer shares a set of changed files.
2. Claude calls `get_change_risk(targets=[...changed files...])` → sees that 2 of 12 files are on critical paths.
3. Claude focuses its review attention on those 2 files, checking for changes that could affect the hot-path behavior.
4. Claude notes: "Most of these changes are in low-traffic utilities, but `src/api/orders/create.ts` is on the critical path (28K invocations/day). The type change on line 45 deserves extra scrutiny."

---

## 7. Implementation Plan

Runtime heatmapping is implemented as a Phase 5 extension. It requires Phase 5 (log collection) to be operational and Phase 2 (structural graph) for meaningful code-graph mapping. It does not depend on Phase 6 (temporal graph) but integrates cleanly with it when both are present.

### 7.1 Subtasks

**1. Metric Aggregator worker** (~4 hours with Claude Code)

Build the background worker that reads `runtime_logs`, groups by function identity, and computes the metrics defined in §5.1. Write results to `function_metrics` table. Support the three aggregation windows. Schedule on a 5-minute interval with configurable override.

**2. Supabase schema and indexes** (~1 hour with Claude Code)

Create `function_metrics`, `metric_regressions`, and `metric_snapshots` tables. Add composite indexes per §5.4. Add migration script for existing RepoGraph installations.

**3. Regression detector** (~3 hours with Claude Code)

Extend the aggregator to compare 1-hour metrics against 24-hour baselines per §5.2. Write detected regressions to `metric_regressions`. Implement deployment correlation per §5.3. Include resolution detection — when a regression's metric returns to baseline, set `resolved_at`.

**4. Heat tier classifier** (~1 hour with Claude Code)

Compute heat tiers from aggregated metrics per §5.6. Store as a column on `function_metrics`. Recompute on each aggregation cycle.

**5. Hourly snapshot writer** (~1 hour with Claude Code)

At the end of each aggregation cycle, write a snapshot row to `metric_snapshots` for trend queries. Implement retention policy: hourly for 30 days, then aggregate to daily.

**6. New MCP tools** (~4 hours with Claude Code)

Implement the six heatmap tools: `get_function_heatmap`, `get_hot_paths`, `get_degraded_functions`, `get_change_risk`, `get_metric_trend`, `get_deploy_impact`. Each queries Supabase for metrics and optionally joins with Neo4j for structural context.

**7. Existing tool enrichment** (~3 hours with Claude Code)

Add heatmap annotations to `get_symbol`, `get_dependencies`, `trace_imports`, `trace_error`, and `get_deploy_errors`. Each enriched tool performs an additional Supabase query for the relevant function's metrics and includes it in the response.

**8. Function identity matching** (~2 hours with Claude Code)

Build the module that matches `(file_path, function_name)` between Supabase metrics and Neo4j graph nodes. Handle the mismatch cases described in §5.5: source maps, anonymous functions, method aliases. Include a configurable alias map.

**9. Validation against live environment** (~4–6 hours, developer-led)

Deploy the aggregator against live Vercel/Railway logs from the target codebase. Verify that function metrics match manual inspection of the Vercel dashboard. Spot-check regression detection against known incident timelines. Validate heat tiers against developer intuition about hot paths.

### 7.2 Total Estimated Effort

| Subtask | Implementation | Validation |
|---|---|---|
| Metric Aggregator | 4 hours | 1 hour |
| Schema and indexes | 1 hour | 30 minutes |
| Regression detector | 3 hours | 1 hour |
| Heat tier classifier | 1 hour | 30 minutes |
| Snapshot writer | 1 hour | 30 minutes |
| New MCP tools | 4 hours | 1.5 hours |
| Existing tool enrichment | 3 hours | 1 hour |
| Function identity matching | 2 hours | 1 hour |
| **Total** | **~19 hours** | **~7 hours** |

Approximately **3–4 focused days** end-to-end. The aggregator and function identity matching are the highest-risk components.

---

## 8. Testing Strategy

### 8.1 Unit Tests

- **Metric Aggregator:** Feed a synthetic `runtime_logs` dataset with known invocation counts and error rates. Verify computed metrics match expected values for all three windows.
- **Regression detector:** Feed metrics with a known 3× error rate increase. Verify regression is detected, classified correctly, and correlated with a deployment in the time window.
- **Heat tier classifier:** Feed a set of 100 functions with known invocation counts. Verify tier assignments match the percentile thresholds.
- **Function identity matching:** Test exact match, source-mapped path match, anonymous function fallback to file-level, and alias map lookup.

### 8.2 Integration Tests

**Test A — end-to-end metric flow.** Insert synthetic log entries into `runtime_logs`. Run the aggregator. Query the MCP tools. Verify that `get_function_heatmap` returns the correct metrics for a known function.

**Test B — regression detection and resolution.** Insert logs that simulate a healthy baseline (24 hours of normal traffic), then a spike (1 hour of elevated errors). Verify regression is detected. Then insert logs showing recovery. Verify `resolved_at` is set.

**Test C — tool enrichment accuracy.** Call `get_symbol` for a function with known heatmap data. Verify the response includes the correct heat tier and metrics alongside the structural information.

### 8.3 Acceptance Criteria

- `get_function_heatmap` returns metrics within 5% of manually computed values for a sample of functions on the target codebase.
- `get_hot_paths` returns the same top-10 functions that the developer identifies as hot paths from their knowledge of the codebase.
- `get_degraded_functions` correctly identifies functions with active regressions, verified against the Vercel dashboard.
- `get_change_risk` returns meaningful risk profiles for files the developer knows are high-traffic.
- Regression detection fires within 10 minutes of an error rate spike exceeding the threshold.
- Heat tiers are stable across aggregation cycles when traffic patterns are stable (no flapping).
- The enriched `get_symbol` response includes heatmap data without increasing response time by more than 100ms.

---

## 9. Performance Considerations

The heatmap's dominant cost is the aggregation query over `runtime_logs`. For a high-traffic application producing 100K log entries per day, the 7-day window query touches ~700K rows.

- **Aggregate incrementally.** The 7-day and 24-hour windows do not need to be recomputed from scratch every cycle. Maintain running aggregates and adjust by adding new entries and dropping entries that have aged out of the window.
- **Index `runtime_logs` for aggregation.** Composite index on `(repo_id, file_path, function_name, timestamp, level)` — the exact columns the aggregation query groups and filters by.
- **Partition `metric_snapshots` by month.** Retention policy drops old partitions efficiently without vacuuming.
- **Cache heat tiers.** Tiers change infrequently. Cache them in the MCP server process with a 5-minute TTL matching the aggregation interval.
- **Query Supabase and Neo4j concurrently.** When an MCP tool needs both metrics and structural data, fire both queries in parallel and merge results. Do not waterfall.

**Performance targets:**

| Metric | Target | Notes |
|---|---|---|
| Aggregation cycle (100K logs/day) | < 30 seconds | Incremental aggregation, indexed queries |
| `get_function_heatmap` response | < 200ms | Single-row Supabase lookup |
| `get_hot_paths` response | < 300ms | Top-N query on indexed `invocation_count` |
| `get_change_risk` response (10 targets) | < 500ms | Batch Supabase lookup + Neo4j structural context |
| `get_metric_trend` response (7 days, hourly) | < 400ms | Indexed range query on `metric_snapshots` |
| Enriched `get_symbol` overhead | < 100ms additional | Parallel Supabase query during Neo4j query |
| Storage (30-day snapshots, 5K functions) | < 200MB | Hourly snapshots with daily aggregation for older data |

---

## 10. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Function identity matching between logs and graph is unreliable | High | Multiple matching strategies: exact path+name, source-mapped path, file-level fallback. Surface match confidence in tool responses. Configurable alias map for known mismatches. |
| Vercel/Railway logs lack duration data for latency computation | Medium | Latency metrics are nullable. MCP tools clearly distinguish "no latency data available" from "latency is zero." Encourage structured logging with duration fields in developer documentation. |
| Aggregation query is slow on high-volume logs | Medium | Incremental aggregation, composite indexes, consider materialized views if query time exceeds target. |
| Regression detector produces false positives (normal traffic fluctuations trigger warnings) | Medium | Require both relative threshold (2×) AND absolute threshold (>1%) to trigger. Add time-of-day adjustment for traffic drop detection. Allow per-function suppression of known-noisy regressions. |
| Heat tiers flap for functions near percentile boundaries | Low | Add a hysteresis band: a function must sustain its new tier for 2 consecutive cycles before reclassification. |
| Metric data lags behind deploys, causing stale risk assessments | Medium | Include `computed_at` timestamp in all tool responses. Claude Code can see how fresh the data is. Flag metrics older than 15 minutes as potentially stale. |

---

## 11. Success Criteria

Runtime heatmapping is complete when:

1. Claude Code can tell the developer the invocation count and error rate for any function that appears in production logs, without the developer checking the Vercel or Railway dashboard.
2. `get_change_risk` accurately identifies high-traffic functions in a set of changed files, confirmed by developer knowledge of the codebase.
3. Claude Code adjusts its refactoring approach based on heatmap data — demonstrably suggesting more caution for hot-path functions and less ceremony for cold code.
4. Regression detection correctly identifies error rate spikes within 10 minutes and correlates them with the triggering deployment.
5. The enriched `get_symbol` response gives Claude production context that visibly improves the relevance of its suggestions during active development.
6. The developer stops opening the Vercel/Railway dashboard to check "is this function important?" because Claude already knows.

---

## 12. Decision Map

### 12.1 At Aggregation Time

**How frequently should the aggregator run?**
Default: every 5 minutes. This balances freshness against query cost. A 1-minute interval would increase Supabase load 5× for marginally fresher data. A 15-minute interval would mean Claude Code could be working with metrics that are up to 15 minutes stale during a debugging session. 5 minutes is the sweet spot for a local developer tool — adjust per installation if needed.

**What if a function appears in logs but not in the graph?**
Store the metrics anyway, keyed to `(file_path, function_name)`. The function may not be in the graph because the digest is stale, or because the function is in generated code or a dependency. File-level metrics are still valuable even without graph mapping. Mark these as `graph_match: false` so the MCP server can indicate the match status.

**How do you handle functions with identical names in different files?**
The identity key is `(file_path, function_name)`, not just `function_name`. Two `handleRequest` functions in different files are tracked independently. The MCP tools resolve ambiguity by requiring `file_path` in specific queries and by annotating results with the file path.

### 12.2 During Regression Detection

**When is a regression "resolved"?**
When the 1-hour metric returns to within 1.5× the 24-hour baseline for two consecutive aggregation cycles. The hysteresis prevents flapping — a brief dip below the threshold does not resolve the regression if it immediately spikes again.

**Should regressions auto-expire?**
Yes. If a regression has not resolved after 72 hours, it is reclassified as the new baseline. The function may have a legitimately higher error rate after a change, and treating it as an ongoing regression indefinitely produces noise. The 72-hour window is configurable.

### 12.3 For MCP Tool Responses

**Should heatmap data appear in every `get_symbol` response, even when not asked for?**
Yes, but concisely. Include the heat tier, 24h invocation count, and error rate as a single annotation block at the end of the response. If the function has no heatmap data (not in production logs), omit the block entirely rather than showing empty fields. Claude Code can choose to act on it or ignore it — but it should always have it available.

**Should `get_change_risk` refuse to proceed if heatmap data is stale?**
No. Return the stale data with a `stale: true` flag and the `computed_at` timestamp. Let Claude Code decide whether to trust it. In practice, 15-minute-old metrics are still more useful than no metrics at all.

### 12.4 Decisions Requiring Product Judgment

**Percentile thresholds for heat tiers.** The current spec uses top 5% for `critical_path`, top 20% for `hot`, etc. These are reasonable defaults but should be validated against your codebase. If your repo has 500 functions and only 5 are genuinely on the critical path (1%), the 5% threshold is too generous. If you have a broad service with 200 important functions, 5% may be too strict. Consider making tiers configurable per-repo, or allow the developer to manually pin specific functions to a tier.

**Whether to surface heatmap data unsolicited.** The current spec enriches `get_symbol` with automatic heatmap annotations. An alternative is to only surface heatmap data when Claude calls a heatmap-specific tool. The automatic approach is recommended — Claude Code should *always* have production context when looking at a function, because the developer is not going to remember to ask for it. But it does add a Supabase query to every `get_symbol` call.

**Latency metric source.** Vercel includes function duration in its log metadata. Railway may or may not, depending on the application's logging setup. Decide whether to document a "recommended logging format" that includes duration, or accept that latency metrics will be spotty for non-Vercel deployments. The recommended path: document a structured logging format but design the system to work without it.

**Integration with temporal graph.** When both heatmap and temporal graph are active, the composite query "this function's error rate spiked → here's the commit that changed it" becomes possible. But this requires the MCP server to join across three data stores (Supabase metrics, Supabase commits, Neo4j graph). Decide whether to build this as a dedicated composite tool (`trace_regression`?) or let Claude Code chain existing tools. Chaining is simpler to implement but relies on Claude correctly identifying the workflow.
