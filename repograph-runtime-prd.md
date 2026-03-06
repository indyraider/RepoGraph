# RepoGraph — Runtime Context Layer
## Product Requirements Document

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | March 5, 2026 |
| **Status** | Draft |
| **Parent PRD** | RepoGraph v1.0 |
| **Phase** | Phase 5 — Runtime Context Layer |

---

## 1. Overview

The Runtime Context Layer is a focused extension to RepoGraph that eliminates the browser tab-switching loop during production debugging. It ingests live logs from any connected deployment or observability platform into Supabase, bridges those logs to the existing Neo4j code graph, and exposes everything through new MCP tools so Claude Code can surface the full debugging context — error logs, deployment events, stack-trace-to-code cross-references — without the developer ever leaving the terminal.

The system is designed around a platform-agnostic adapter architecture. Vercel and Railway are the two first-party adapters shipped in v1, but any platform that exposes logs via an API — GitHub Actions, Datadog, Sentry, AWS CloudWatch, Render, Fly.io, and others — can be added by implementing a single adapter interface. All adapters normalize into the same schema, and all MCP tools work uniformly regardless of source.

This document covers the requirements, architecture, data model, MCP tool specification, and adapter interface for Phase 5 of RepoGraph. It assumes Phases 1–4 are complete: Neo4j is populated with the code graph, the MCP server is running, and Claude Code is connected.

---

## 2. Problem Statement

The current production debugging workflow is manual, slow, and context-fragmented:

- Something breaks in production on Vercel, Railway, or any other platform.
- The developer opens the platform dashboard in a browser.
- They read through log output, find the relevant error, and copy the stack trace.
- They paste the error into Claude Code and wait for it to process.
- Claude asks for the source file. The developer opens it, copies it, pastes it.
- This cycle repeats for every related file, import, and dependency.

The full loop — from noticing an error to having Claude understand its full context — routinely takes 10–15 minutes of manual work. The code graph already exists in Neo4j. The only missing piece is connecting live runtime signals to it.

The problem compounds as the stack grows. A typical Qwikr debugging session might involve Vercel serverless logs, Railway background worker logs, and GitHub Actions CI logs — three separate dashboards, three separate copy-paste cycles, all to reconstruct context that a unified log layer could serve in a single MCP tool call.

---

## 3. Goals & Non-Goals

### 3.1 Goals

1. Collect logs from any platform via a pluggable adapter interface. Ship first-party adapters for Vercel and Railway; define the interface clearly enough that new adapters are trivial to add.
2. Normalize all platform-specific log formats into a single unified schema stored in Supabase.
3. Parse stack traces from error logs to extract file paths and line numbers as structured fields.
4. Bridge runtime errors to the code graph: given a stack trace, return the containing function, its callers, and its imports from Neo4j.
5. Expose log querying and error bridging through new MCP tools so Claude Code can interrogate production state directly.
6. Provide a minimal UI for configuring log sources (platform selector, API credentials, project IDs, polling intervals).
7. Implement a log retention policy (default: 30 days) with automatic pruning.

### 3.2 Non-Goals

- Real-time streaming to the Claude Code UI — polling is acceptable for v1.
- Alerting, dashboards, or visualizations — this is a query layer for Claude, not a monitoring product.
- Log aggregation or analytics — the goal is debuggability, not observability at scale.
- Automatic adapter discovery — new adapters require a code change, not just UI configuration.

---

## 4. Architecture

The Runtime Context Layer slots into the existing RepoGraph architecture as two new components: a **Log Collector** (adapter workers + scheduler) and an extended **MCP Server** with runtime tools. Everything else — Neo4j, Supabase, the web UI, the existing MCP tools — remains unchanged.

| Component | Technology | Responsibility |
|---|---|---|
| Log Collector | Node.js background workers | Run adapters on schedule; normalize and store logs in Supabase |
| Adapter Interface | TypeScript interface | Common contract all platform adapters implement |
| First-Party Adapters | TypeScript modules | Vercel (REST), Railway (GraphQL), GitHub Actions (REST) |
| Stack Trace Parser | Regex + AST lookup | Extract file/line from stack traces; resolve to Neo4j Function nodes |
| Runtime MCP Tools | TypeScript (@modelcontextprotocol/sdk) | Expose log querying and error bridging to Claude Code |
| Log Source Config UI | React (existing Web UI) | New section in existing UI for adapter config |
| Log Retention Worker | Node.js cron job | Prune runtime_logs entries older than retention window |

### 4.1 Adapter Architecture

Every platform integration implements the `LogAdapter` interface. The collector scheduler is platform-agnostic — it loads all enabled adapters from the `log_sources` table, calls `fetchSince()` on each, normalizes the results, and stores them. Adding a new platform means writing one adapter module and registering it — no changes to the scheduler, the data model, or the MCP tools.

```typescript
interface LogAdapter {
  platform: string;                         // e.g. "vercel", "railway", "datadog"
  displayName: string;                      // shown in UI
  
  // Validate credentials and return a connection status
  testConnection(config: AdapterConfig): Promise<ConnectionResult>;
  
  // Fetch all log entries after `since`. Return normalized entries.
  fetchSince(config: AdapterConfig, since: Date): Promise<NormalizedLogEntry[]>;
  
  // Fetch recent deployments (optional — not all platforms have this concept)
  fetchDeployments?(config: AdapterConfig, since: Date): Promise<NormalizedDeployment[]>;
}

interface NormalizedLogEntry {
  source: string;           // adapter platform name
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: Date;
  deploymentId?: string;
  functionName?: string;
  filePath?: string;        // pre-parsed if available from platform
  lineNumber?: number;      // pre-parsed if available from platform
  stackTrace?: string;
  metadata: Record<string, unknown>;  // platform-specific extras
}
```

### 4.2 Log Collection Flow

1. Scheduler wakes on interval (default: 30 seconds). Reads `log_sources` for enabled entries.
2. For each source, loads the corresponding adapter by `platform` identifier.
3. Calls `adapter.fetchSince(config, source.last_poll_at)`.
4. Adapter fetches from platform API, normalizes entries, returns them.
5. Collector runs stack trace parser on any error-level entries lacking a parsed `file_path`.
6. Batch-inserts normalized entries into `runtime_logs`. Updates `log_sources.last_poll_at`.

### 4.3 First-Party Adapters (v1)

#### Vercel
- **API:** REST — `GET /v2/deployments/{id}/events` for function logs; `GET /v6/deployments` for deployment list.
- **Log levels:** Vercel `type` field (info / warning / error) → normalized.
- **Metadata:** function name, region, duration (ms), deployment ID.
- **Auth:** Bearer token via `VERCEL_API_TOKEN` or per-source encrypted config.

#### Railway
- **API:** GraphQL at `https://backboard.railway.app/graphql/v2`.
- **Query:** `deploymentLogs(deploymentId, filter)` with `startDate` as cursor.
- **Log levels:** Railway `severity` field → normalized.
- **Metadata:** service name, replica ID, environment.
- **Auth:** Bearer token via `RAILWAY_API_TOKEN` or per-source encrypted config.

#### GitHub Actions
- **API:** REST — `GET /repos/{owner}/{repo}/actions/runs` for workflow runs; `GET /runs/{run_id}/logs` for log archives.
- **Log levels:** GitHub Actions logs are unleveled; errors are detected via regex on step conclusions (`failure`, `cancelled`) and log line patterns.
- **Metadata:** workflow name, job name, step name, run ID, trigger (push/PR).
- **Auth:** GitHub Personal Access Token or GitHub App installation token.

### 4.4 Adding New Adapters

The following platforms are natural candidates for future adapters. Each one is a self-contained module — no architectural changes required:

| Platform | API Type | Notes |
|---|---|---|
| Sentry | REST | Rich structured errors, already parsed stack traces, release tracking |
| Datadog | REST | High-volume; recommend filtering to error level only by default |
| AWS CloudWatch | REST (SDK) | Requires AWS credentials; log group selection in UI |
| Render | REST | Similar shape to Vercel; straightforward adapter |
| Fly.io | REST / nats | Log streaming available |
| Heroku | REST / Logplex | Drain-based or polling |
| PagerDuty | REST | Incident events, not raw logs — useful for alerting context |
| Linear / GitHub Issues | REST | Link runtime errors to existing bug reports |

### 4.5 Stack Trace Bridging

When a log entry contains a stack trace, the collector parses it to extract structured location data. This enables the `trace_error` MCP tool to cross-reference runtime failures with the code graph.

The parser handles the following formats:

- **Node.js:** `at functionName (src/api/payments.ts:142:18)`
- **Vercel serverless:** `at handler (/var/task/src/api/payments.ts:142)`
- **Python:** `File "src/api/payments.py", line 142, in process_payment`
- **Go:** `goroutine panic: src/api/payments.go:142`
- **Railway / Docker:** standard Node.js or Python tracebacks

Extracted `file_path` and `line_number` are stored as first-class columns on `runtime_logs` so they can be indexed and joined. The raw stack trace is preserved in `stack_trace` for full fidelity. When source maps are available in the repository (parsed during digest), the collector resolves minified paths back to original source paths before storing.

---

## 5. Data Model

### 5.1 New Supabase Tables

#### `runtime_logs`

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | Auto-generated |
| `repo_id` | uuid (FK) | Reference to `repositories` table |
| `source` | text | Adapter platform identifier (e.g. `vercel`, `railway`, `github_actions`) |
| `level` | text | `info`, `warn`, or `error` |
| `message` | text | Log message body |
| `timestamp` | timestamptz | Log event time (from platform) |
| `deployment_id` | text | Platform-specific deployment/run identifier (nullable) |
| `function_name` | text | Serverless function, service, or job name (nullable) |
| `file_path` | text | Parsed from stack trace (nullable) |
| `line_number` | integer | Parsed from stack trace (nullable) |
| `stack_trace` | text | Full raw stack trace (nullable) |
| `metadata` | jsonb | Platform-specific extras (region, duration, replica, workflow, etc.) |

#### `deployments`

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | Auto-generated |
| `repo_id` | uuid (FK) | Reference to `repositories` table |
| `source` | text | Adapter platform identifier |
| `deployment_id` | text | Platform-native deployment/run ID |
| `status` | text | `ready`, `error`, `building`, `cancelled`, `running` |
| `branch` | text | Git branch deployed (nullable) |
| `commit_sha` | text | Git commit SHA (nullable) |
| `started_at` | timestamptz | Deployment/run start time |
| `completed_at` | timestamptz | End time (nullable) |
| `url` | text | Deployment URL or run URL (nullable) |

#### `log_sources`

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | Auto-generated |
| `repo_id` | uuid (FK) | Reference to `repositories` table |
| `platform` | text | Adapter identifier — must match a registered adapter |
| `display_name` | text | User-defined label for this source |
| `api_key_ref` | text | Encrypted API token reference |
| `config` | jsonb | Adapter-specific config (project ID, log group, team slug, etc.) |
| `polling_interval_sec` | integer | Polling cadence (default: 30) |
| `min_level` | text | Minimum log level to store — `info`, `warn`, or `error` (default: `warn`) |
| `enabled` | boolean | Toggle without deleting config |
| `last_poll_at` | timestamptz | Cursor for incremental fetch |

### 5.2 Required Indexes

| Index | Purpose |
|---|---|
| `runtime_logs (timestamp DESC)` | Primary sort for `get_recent_logs` |
| `runtime_logs (level, timestamp DESC)` | Filtered queries by level |
| `runtime_logs (source, timestamp DESC)` | Per-platform queries |
| `runtime_logs (deployment_id, source)` | Join with `deployments` table |
| `runtime_logs USING GIN(to_tsvector('english', message))` | Full-text search for `search_logs` |
| `deployments (started_at DESC)` | Deployment history ordering |

---

## 6. MCP Tool Specification

Five new tools are added to the MCP server. All existing code graph tools remain unchanged. The new tools are grouped under a `runtime` namespace in the tool manifest.

### `get_recent_logs`

Fetch the most recent log entries across any or all connected sources. The primary tool for a quick "what's happening right now" check.

| Parameter | Type | Description |
|---|---|---|
| `source` | string (optional) | Platform identifier or `all`. Default: `all` |
| `minutes` | integer (optional) | Look-back window in minutes. Default: 30 |
| `level` | string (optional) | Filter to `info` \| `warn` \| `error`. Default: all levels |
| `max_results` | integer (optional) | Cap on returned entries. Default: 50 |

**Returns:** Array of log entries with `id`, `timestamp`, `source`, `level`, `message`, `function_name`, `file_path`, `line_number`.

---

### `search_logs`

Full-text search across stored log messages using a Postgres GIN index. Useful for finding a specific error class, endpoint pattern, or string across any time range or source.

| Parameter | Type | Description |
|---|---|---|
| `query` | string (required) | Search string matched against log message body |
| `source` | string (optional) | Platform identifier or `all`. Default: `all` |
| `since` | string (optional) | ISO 8601 timestamp lower bound |
| `level` | string (optional) | Filter to `error` \| `warn` \| `info` |

**Returns:** Matching log entries ordered by `timestamp` descending.

---

### `get_deploy_errors`

Fetch error-level logs scoped to one or more recent deployments or CI runs. The primary entry point for "what broke in the last deploy."

| Parameter | Type | Description |
|---|---|---|
| `source` | string (optional) | Platform identifier or `all`. Default: `all` |
| `deployment_id` | string (optional) | Specific deployment ID to scope the query |
| `last_n_deploys` | integer (optional) | Scope to the N most recent deployments. Default: 1 |

**Returns:** Error entries with deployment context (branch, commit, status) included.

---

### `get_deployment_history`

List recent deployments and CI runs with their status, branch, commit SHA, and aggregated error/warning counts. Used to understand the deployment timeline and select a specific run to investigate.

| Parameter | Type | Description |
|---|---|---|
| `source` | string (optional) | Platform identifier or `all`. Default: `all` |
| `repo` | string (optional) | Filter to a specific repo by name or ID |
| `max_results` | integer (optional) | Number of deployments to return. Default: 10 |

**Returns:** Deployments ordered by `started_at` DESC, each with `error_count` and `warn_count` aggregated from joined `runtime_logs`.

---

### `trace_error`

The flagship tool of the Runtime Context Layer. Given an error log ID or raw stack trace string, this tool parses file paths and line numbers from the stack, queries Neo4j for the containing function and its callers, fetches the relevant source file, and returns a fully assembled debugging context in a single response.

| Parameter | Type | Description |
|---|---|---|
| `log_id` | string (optional) | ID of a `runtime_logs` entry. Tool fetches the stack trace automatically. |
| `stack_trace` | string (optional) | Raw stack trace string. Use when log entry is not yet stored. |
| `repo` | string (required) | Repository name to scope the Neo4j lookup. |

At least one of `log_id` or `stack_trace` must be provided.

**Returns a composite object containing:**
- Parsed error location: file path, line number, function name
- Full source of the containing file (via Supabase `file_contents`)
- The specific `Function` node from Neo4j covering the error line, with signature and docstring
- All callers of that function (`CALLS` edges in reverse) with their file paths
- All imports of the containing file (`IMPORTS` edges) with target paths and symbols
- Original log entry context (timestamp, level, full message, deployment info, source platform)

---

## 7. Composite Workflow Example

The following illustrates what Claude Code executes automatically when a developer asks "what broke in the last deploy?":

```
Step 1 → get_deploy_errors(source='all', last_n_deploys=1)
         Returns: TypeError in src/api/payments.ts:142 (Railway, 3 occurrences)
                  Build failure in .github/workflows/deploy.yml step "run tests" (GitHub Actions)

Step 2 → trace_error(log_id='<id>', repo='qwikr')
         Parses stack → looks up Function at payments.ts:142 in Neo4j
         Returns: processPayment(), callers: [handleCheckout, retryFailedPayments]
                  Imports: [src/models/order.ts, stripe@14.1.0]
                  Full source of src/api/payments.ts

Step 3 → get_symbol(name='handleCheckout', repo='qwikr')
         Returns: caller context, signature, file location

Step 4 → Claude synthesizes: full error context, root function, call path,
         upstream dependency usage — and proposes a fix.

Total tool calls: 3-4   |   Time: ~10 seconds   |   Tab switches: 0
```

---

## 8. Web UI Additions

One new section is added to the existing single-page web UI: the **Log Source Configuration Zone**. No other UI changes are required.

### Log Source Configuration Zone

- **Platform selector:** dropdown of all registered adapters (Vercel, Railway, GitHub Actions, and any future adapters).
- **Display name field:** user-defined label for this source (e.g. "Qwikr Production — Vercel").
- **API token input:** write-only; stored encrypted; never displayed after save.
- **Config fields:** adapter-specific fields rendered dynamically (e.g. Project ID for Vercel, Team Slug for Railway, org/repo for GitHub Actions).
- **Minimum log level selector:** `info`, `warn`, or `error` — controls what gets stored (default: `warn`).
- **Polling interval selector:** 30s, 60s, 5min, 15min.
- **Test Connection button:** fires a single API call to verify credentials, returns a sample entry count and the most recent log timestamp.
- **Status indicator per source:** Active / Error / Disabled with `last_poll_at` timestamp and error message if connection failed.
- **Enable / Disable toggle:** suspends polling without deleting configuration.

---

## 9. Performance Targets

| Metric | Target | Notes |
|---|---|---|
| Log ingestion latency (poll to stored) | < 60 seconds | From log event on platform to queryable in Supabase |
| `get_recent_logs` response time | < 300ms | Indexed `timestamp + level` query |
| `search_logs` response time | < 500ms | GIN full-text index on `message` column |
| `get_deploy_errors` response time | < 300ms | Scoped to `deployment_id` FK |
| `trace_error` response time | < 2 seconds | Stack parse + Neo4j cross-reference + file fetch |
| Log storage (30-day retention) | < 1 GB | With automatic pruning; `warn`/`error` stored by default |

---

## 10. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Platform API rate limits | Medium | Exponential backoff on 429 responses; configurable polling interval per source; cache deployment list separately from log entries. |
| Adapter API breaking changes | Medium | Platform-specific logic is fully isolated per adapter. A breaking change to Railway's GraphQL schema only affects the Railway adapter — no impact on MCP tools, scheduler, or data model. |
| Log volume overwhelms Supabase storage | Medium | Default `min_level` is `warn`. Info-level is opt-in. Auto-prune on 30-day retention. UI warns when storage exceeds configurable threshold. |
| Stack trace parser fails on minified/bundled code | Medium | Use source maps when available (parsed during digest). Fall back to raw path matching. `trace_error` returns partial context with original stack trace even when path resolution fails. |
| API tokens stored insecurely | High | Encrypt tokens at rest in Supabase. Never return token values via API or MCP. Recommend environment variables over UI input for production use. |
| Polling misses logs during outage | Low | `last_poll_at` acts as a durable cursor; collector backtracks on resume. `deployments` table provides independent anchor for scoped log queries. |
| New adapter quality variance | Medium | Define a test harness as part of the adapter interface spec. First-party adapters must pass it; community adapters documented as unsupported. |

---

## 11. Success Criteria

The Runtime Context Layer is complete when all of the following are true:

1. **Claude Code can call `get_deploy_errors`** and receive structured error entries from the most recent deployment or CI run — from any connected platform — without any manual copy-paste from the developer.
2. **Claude Code can call `trace_error`** on any returned error and receive the containing function, all callers, all imports, and the full file source — cross-referenced from the live code graph.
3. **The end-to-end debugging loop** (error noticed → root cause identified in Claude Code) is reduced from ~15 minutes of manual tab-switching to under 2 minutes of MCP tool calls.
4. **The developer never needs to open Vercel, Railway, or GitHub Actions** to debug a production error — all log context is available directly through Claude Code.
5. **New platforms can be added** by implementing the `LogAdapter` interface without modifying the scheduler, data model, or MCP tools.
6. **Log ingestion runs continuously and reliably** with no manual intervention after initial configuration.
7. **The 30-day retention policy runs automatically** with no storage growth beyond the defined cap.

---

## Appendix A: Example Runtime Queries

### Get errors from the last deployment (any platform)
```sql
SELECT rl.timestamp, rl.source, rl.level, rl.message, rl.file_path, rl.line_number, rl.stack_trace
FROM runtime_logs rl
JOIN deployments d ON rl.deployment_id = d.deployment_id AND rl.source = d.source
WHERE rl.level = 'error'
  AND d.id IN (
    SELECT DISTINCT ON (source) id FROM deployments
    ORDER BY source, started_at DESC
  )
ORDER BY rl.timestamp DESC
LIMIT 50;
```

### Search for a specific error pattern across all sources
```sql
SELECT timestamp, source, level, message, file_path, line_number
FROM runtime_logs
WHERE to_tsvector('english', message) @@ plainto_tsquery('english', 'TypeError undefined')
  AND timestamp > NOW() - INTERVAL '24 hours'
ORDER BY timestamp DESC;
```

### Deployment history with error counts across all platforms
```sql
SELECT d.source, d.branch, d.commit_sha, d.status, d.started_at,
       COUNT(rl.id) FILTER (WHERE rl.level = 'error') AS error_count,
       COUNT(rl.id) FILTER (WHERE rl.level = 'warn')  AS warn_count
FROM deployments d
LEFT JOIN runtime_logs rl ON rl.deployment_id = d.deployment_id AND rl.source = d.source
GROUP BY d.id
ORDER BY d.started_at DESC
LIMIT 10;
```

## Appendix B: trace_error Full Cross-Reference Chain

```
Input: stack trace from runtime_logs
       "TypeError: Cannot read property 'amount' of undefined
        at processPayment (src/api/payments.ts:142)"

1. Parse stack trace → file_path: "src/api/payments.ts", line: 142

2. Supabase: fetch full source from file_contents where file_path = 'src/api/payments.ts'

3. Neo4j: MATCH (f:File {path: 'src/api/payments.ts'})-[:CONTAINS]->(fn:Function)
          WHERE fn.start_line <= 142 AND fn.end_line >= 142
          RETURN fn
   → Function { name: "processPayment", signature: "(order: Order) => Promise<PaymentResult>",
                start_line: 128, end_line: 165 }

4. Neo4j: MATCH (fn:Function {name: 'processPayment'})<-[:CALLS]-(caller)<-[:CONTAINS]-(f:File)
          RETURN f.path, caller.name
   → [ { path: "src/api/routes.ts", caller: "handleCheckout" },
       { path: "src/jobs/retry-payments.ts", caller: "retryFailedPayments" } ]

5. Neo4j: MATCH (f:File {path: 'src/api/payments.ts'})-[:IMPORTS]->(dep)
          RETURN dep.path, dep.name
   → [ { path: "src/models/order.ts" }, { name: "stripe", version: "14.1.0" } ]

6. Assembled response to Claude Code: full function source, all callers,
   all imports, upstream dependency info, and the original error context.
```
