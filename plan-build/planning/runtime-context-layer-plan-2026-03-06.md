# Build Plan: Runtime Context Layer
**Created:** 2026-03-06
**Brainstorm:** ../brainstorm/runtime-context-layer-brainstorm-2026-03-06.md
**PRD:** repograph-runtime-prd.md
**Status:** Draft

## Overview

The Runtime Context Layer connects live production logs to the existing Neo4j code graph. It ingests logs from Vercel and Railway into Supabase via a pluggable adapter architecture, parses stack traces into structured file/line references, and exposes 5 new MCP tools — including `trace_error`, which chains stack trace parsing, Neo4j function lookup, caller resolution, and file content fetch into a single debugging context. v1 ships Vercel + Railway adapters; GitHub Actions deferred to v1.1.

## Component Inventory

| Component | Location | Inputs | Outputs | External Deps |
|---|---|---|---|---|
| Supabase Migration | `supabase-runtime-migration.sql` | Manual apply | 3 tables + indexes | Postgres |
| Adapter Interface | `packages/backend/src/runtime/adapters/types.ts` | — | Type defs | — |
| Vercel Adapter | `packages/backend/src/runtime/adapters/vercel.ts` | AdapterConfig, since Date | NormalizedLogEntry[], NormalizedDeployment[] | Vercel REST API |
| Railway Adapter | `packages/backend/src/runtime/adapters/railway.ts` | AdapterConfig, since Date | NormalizedLogEntry[], NormalizedDeployment[] | Railway GraphQL API |
| Adapter Registry | `packages/backend/src/runtime/adapters/registry.ts` | platform string | LogAdapter instance | — |
| Stack Trace Parser | `packages/backend/src/runtime/stack-parser.ts` | raw stack string | ParsedFrame[] | — |
| Log Collector | `packages/backend/src/runtime/collector.ts` | log_sources rows | Inserts to runtime_logs + deployments | Supabase |
| Log Retention Worker | `packages/backend/src/runtime/retention.ts` | cron interval | Deletes from runtime_logs | Supabase |
| Backend API Routes | `packages/backend/src/runtime/routes.ts` | HTTP requests | log_sources CRUD + test | Supabase, adapters |
| Encryption Utils | `packages/backend/src/lib/crypto.ts` | — | encrypt/decrypt functions | crypto |
| MCP Runtime Tools | `packages/mcp-server/src/runtime-tools.ts` | MCP tool calls | Query results | Supabase, Neo4j |
| Repo Resolver | `packages/mcp-server/src/repo-resolver.ts` | repo name | repo UUID | Supabase |
| Frontend Log Source UI | `packages/frontend/src/components/LogSourcePanel.tsx` | User interaction | API calls | React |
| Frontend API Extensions | `packages/frontend/src/api.ts` | — | New API functions | — |

## Integration Contracts

### Contract 1: Frontend → Backend (Log Source CRUD)

```
[Frontend LogSourcePanel] → [Backend /api/log-sources/*]
  What flows:     Log source config (platform, display_name, api_token, config, polling_interval, min_level)
  How it flows:   REST API calls via authedFetch()
  Auth/Config:    JWT cookie (existing auth middleware)
  Error path:     400 validation errors, 500 server errors → displayed in UI
```

**Endpoints:**
- `GET /api/log-sources` → list all sources for current user's repos (masked tokens)
- `POST /api/log-sources` → create new source (encrypts api_token before storage)
- `PUT /api/log-sources/:id` → update source config
- `DELETE /api/log-sources/:id` → remove source
- `POST /api/log-sources/:id/test` → invoke adapter.testConnection(), return result
- `POST /api/log-sources/:id/toggle` → flip enabled flag

**Request body (POST/PUT):**
```typescript
{
  repo_id: string;           // UUID
  platform: string;          // "vercel" | "railway"
  display_name: string;
  api_token: string;         // plaintext — encrypted before storage
  config: {                  // platform-specific
    project_id?: string;     // Vercel
    team_slug?: string;      // Vercel
    project_id?: string;     // Railway
    service_id?: string;     // Railway
    environment_id?: string; // Railway
  };
  polling_interval_sec?: number;  // default 30
  min_level?: string;             // default "warn"
}
```

**Response (GET list):**
```typescript
{
  id: string;
  repo_id: string;
  platform: string;
  display_name: string;
  config: { /* adapter-specific, token NEVER included */ };
  polling_interval_sec: number;
  min_level: string;
  enabled: boolean;
  last_poll_at: string | null;
  last_error: string | null;
}[]
```

### Contract 2: Backend Routes → Supabase (log_sources table)

```
[Backend routes.ts] → [Supabase log_sources]
  What flows:     CRUD operations on log source configuration
  How it flows:   Supabase JS client (getSupabase())
  Auth/Config:    SUPABASE_SERVICE_KEY (already configured)
  Error path:     Supabase errors propagated as 500 to client
```

**Encryption flow:**
1. Route receives plaintext `api_token` in request body
2. Route calls `encrypt(api_token)` using shared crypto utils (extracted from connections.ts)
3. Encrypted token stored in `log_sources.config.encrypted_api_token`
4. On read: token field stripped from response (never returned)
5. On collector poll: `decrypt()` called to get plaintext for adapter

### Contract 3: Log Collector → Adapters

```
[Log Collector] → [Adapter.fetchSince() + Adapter.fetchDeployments?()]
  What flows:     AdapterConfig (decrypted api_token + platform config) + since Date
  How it flows:   Direct function call — collector loads adapter from registry by platform string.
                  Two calls per adapter: fetchSince() for logs, fetchDeployments() for deployments (if implemented).
  Auth/Config:    API tokens decrypted from log_sources.config at poll time
  Error path:     Per-adapter try/catch — one failing adapter doesn't block others.
                  Errors logged + stored in log_sources.last_error column. Collector continues.
```

**Note:** `fetchDeployments()` is optional on the `LogAdapter` interface. Collector must check
`if (adapter.fetchDeployments)` before calling. Both v1 adapters (Vercel, Railway) implement it.

**camelCase → snake_case mapping:** `NormalizedLogEntry` and `NormalizedDeployment` use camelCase
(TypeScript convention). Collector must map to snake_case DB columns before insert:
`deploymentId → deployment_id`, `functionName → function_name`, `filePath → file_path`,
`lineNumber → line_number`, `stackTrace → stack_trace`, `commitSha → commit_sha`,
`startedAt → started_at`, `completedAt → completed_at`.

**AdapterConfig shape:**
```typescript
interface AdapterConfig {
  apiToken: string;                    // decrypted at poll time
  platformConfig: Record<string, unknown>;  // from log_sources.config (minus encrypted_api_token)
}
```

**Collector scheduling:**
- `setInterval` in backend `start()` function, checking every 10 seconds
- Each tick: query `log_sources` WHERE `enabled = true` AND `last_poll_at + polling_interval_sec < NOW()`
- For each due source: load adapter, call fetchSince(), run stack parser on errors, batch-insert
- Update `last_poll_at` after successful poll
- On adapter error: update `last_error` on log_sources, do NOT update last_poll_at (retry next tick)

### Contract 4: Adapters → Platform APIs

#### Vercel Adapter → Vercel REST API

```
[Vercel Adapter] → [Vercel API]
  What flows:     GET /v6/deployments?projectId=X&since=T → deployment list
                  GET /v2/deployments/{id}/events → function logs per deployment
  How it flows:   fetch() with Authorization: Bearer <VERCEL_API_TOKEN>
  Auth/Config:    Bearer token from AdapterConfig.apiToken
  Error path:     429 → exponential backoff (1s, 2s, 4s, max 30s)
                  401 → mark source as error, stop polling until re-auth
                  5xx → retry once, then mark error
```

**Normalization:**
- Vercel `type` field: `stdout` → info, `stderr` → error, `warning` → warn
- `deploymentId`: from deployment object
- `functionName`: from log event payload
- `metadata`: `{ region, duration_ms }`

#### Railway Adapter → Railway GraphQL API

```
[Railway Adapter] → [Railway GraphQL]
  What flows:     query { deployments(projectId) } → deployment list
                  query { deploymentLogs(deploymentId, filter: {startDate}) } → log entries
  How it flows:   POST https://backboard.railway.app/graphql/v2 with Bearer token
  Auth/Config:    Bearer token from AdapterConfig.apiToken
  Error path:     Same pattern as Vercel (429 backoff, 401 error, 5xx retry)
```

**Normalization:**
- Railway `severity` field → normalized level
- `deploymentId`: from deployment object
- `metadata`: `{ serviceName, replicaId, environment }`

### Contract 5: Collector → Stack Trace Parser

```
[Log Collector] → [parseStackTrace()]
  What flows:     Raw stack trace string from error-level log entries
  How it flows:   Direct function call (pure function, no side effects)
  Auth/Config:    None
  Error path:     Returns empty array if no frames parsed (never throws)
```

**Function signature:**
```typescript
interface ParsedFrame {
  filePath: string;
  lineNumber: number;
  columnNumber?: number;
  functionName?: string;
}

function parseStackTrace(stackTrace: string): ParsedFrame[]
```

**Supported formats:**
- Node.js: `at functionName (src/api/payments.ts:142:18)`
- Vercel serverless: `at handler (/var/task/src/api/payments.ts:142)`
- Python: `File "src/api/payments.py", line 142, in process_payment`
- Go: `goroutine panic: src/api/payments.go:142`

**Path normalization:** Strip `/var/task/`, `/app/`, Docker container prefixes. Match against repo file paths.

### Contract 6: Collector → Supabase (runtime_logs + deployments)

```
[Log Collector] → [Supabase runtime_logs / deployments]
  What flows:     Batch INSERT of normalized log entries and deployments
  How it flows:   Supabase JS client — sb.from("runtime_logs").insert(entries)
  Auth/Config:    SUPABASE_SERVICE_KEY (existing)
  Error path:     Supabase insert errors → logged, source marked as error
```

**runtime_logs insert shape:**
```typescript
{
  repo_id: string;
  source: string;          // "vercel" | "railway"
  level: string;           // "info" | "warn" | "error"
  message: string;
  timestamp: string;       // ISO 8601 from platform
  deployment_id?: string;
  function_name?: string;
  file_path?: string;      // from stack parser
  line_number?: number;    // from stack parser
  stack_trace?: string;    // raw, preserved
  metadata: object;        // platform-specific extras
}
```

### Contract 7: MCP Tools → Supabase (runtime queries)

```
[MCP Runtime Tools] → [Supabase]
  What flows:     SELECT queries against runtime_logs, deployments
  How it flows:   Supabase JS client (getSupabase() — already exists in MCP server)
  Auth/Config:    SUPABASE_URL + SUPABASE_SERVICE_KEY (already configured for MCP server)
  Error path:     Query errors → return error text in MCP response content
```

**Repo resolution (all 5 tools):**
```typescript
// packages/mcp-server/src/repo-resolver.ts
async function resolveRepoId(repoNameOrUrl: string): Promise<string | null> {
  const sb = getSupabase();
  const { data } = await sb
    .from("repositories")
    .select("id")
    .or(`name.eq.${repoNameOrUrl},url.eq.${repoNameOrUrl}`)
    .limit(1)
    .single();
  return data?.id ?? null;
}
```

### Contract 8: trace_error → Neo4j (code graph cross-reference)

```
[trace_error MCP tool] → [Neo4j]
  What flows:     Cypher queries: Function lookup by file+line, caller resolution, import resolution
  How it flows:   Neo4j driver session (getSession() — already exists in MCP server)
  Auth/Config:    NEO4J_URI + NEO4J_USERNAME + NEO4J_PASSWORD (already configured)
  Error path:     Neo4j errors or empty results → return partial context with explanation
```

**Query chain:**

1. **Lookup function at file:line:**
```cypher
MATCH (f:File {path: $filePath})-[:CONTAINS]->(fn:Function)
WHERE fn.start_line <= $line AND fn.end_line >= $line
RETURN fn.name AS name, fn.signature AS signature, fn.docstring AS docstring,
       fn.start_line AS start_line, fn.end_line AS end_line
```

2. **Get callers:**
```cypher
MATCH (fn:Function {name: $fnName})<-[:CALLS]-(caller:Function)<-[:CONTAINS]-(f:File)
RETURN caller.name AS caller_name, f.path AS caller_file,
       caller.start_line AS caller_line
```

3. **Get imports of containing file:**
```cypher
MATCH (f:File {path: $filePath})-[r:IMPORTS]->(target)
RETURN target.path AS target_path, target.name AS target_name,
       labels(target)[0] AS target_type, r.symbols AS symbols
```

4. **Get file source from Supabase:**
```typescript
const { data } = await sb.from("file_contents")
  .select("content")
  .eq("file_path", filePath)
  .limit(1)
  .single();
```

### Contract 9: Backend startup → Collector + Retention initialization

```
[Backend index.ts start()] → [Log Collector + Retention Worker]
  What flows:     Initialization calls — startCollector(), startRetentionWorker()
  How it flows:   Import and call from start() function, after Supabase verified
  Auth/Config:    None — uses existing Supabase singleton
  Error path:     Initialization failure logged as warning (non-fatal to server startup)
```

**Integration points in `packages/backend/src/index.ts`:**
```typescript
// After line 108 (after restartWatchers):
import { startCollector, stopCollector } from "./runtime/collector.js";
import { startRetention, stopRetention } from "./runtime/retention.js";

// In start(), after restartWatchers block:
if (sbOk) {
  try {
    startCollector();
    startRetention();
    console.log("Runtime: log collector and retention worker started");
  } catch (err) {
    console.warn("Runtime: failed to start collector:", err);
  }
}

// In SIGINT handler:
stopCollector();
stopRetention();
```

### Contract 10: Frontend SettingsView → LogSourcePanel

```
[SettingsView] → [LogSourcePanel]
  What flows:     Renders LogSourcePanel component below MCP Configuration section
  How it flows:   React component import and render
  Auth/Config:    None — LogSourcePanel manages its own state and API calls
  Error path:     Component-level error handling (same pattern as existing forms)
```

**Integration point in `packages/frontend/src/views/SettingsView.tsx`:**
```tsx
// After the MCP Configuration card (line 501):
import { LogSourcePanel } from "../components/LogSourcePanel";

{/* Log Sources */}
<div className="card-glass rounded-xl overflow-hidden mt-6">
  <LogSourcePanel />
</div>
```

## End-to-End Flows

### Flow 1: Add a new log source (happy path)

```
1. User navigates to Settings page
2. User clicks "Add Log Source" in LogSourcePanel
3. User selects platform (Vercel) from dropdown
4. Platform-specific config fields render (Project ID, Team Slug)
5. User enters API token, project ID, display name
6. User clicks "Test Connection"
7. Frontend calls POST /api/log-sources/test-connection
   body: { platform: "vercel", api_token: "...", config: { project_id: "..." } }
8. Backend instantiates VercelAdapter from registry
9. Backend calls adapter.testConnection(config) → Vercel API GET /v6/deployments?limit=1
10. Vercel returns 200 with deployment data → testConnection returns { ok: true, latestLog: "..." }
11. Backend returns { ok: true, ... } to frontend
12. Frontend shows green success indicator
13. User clicks "Save"
14. Frontend calls POST /api/log-sources
15. Backend encrypts api_token → stores in log_sources table
16. Backend returns { id: "...", status: "saved" }
17. LogSourcePanel refreshes list, shows new source as "Active"
18. Next collector tick (within 10s): picks up new source, calls fetchSince()
19. Logs start appearing in runtime_logs table
```

### Flow 2: Debug a production error (the flagship workflow)

```
1. Developer asks Claude Code: "what broke in the last deploy?"
2. Claude calls get_deploy_errors(source='all', last_n_deploys=1)
3. MCP tool resolves repo name → UUID via resolveRepoId()
4. Tool queries Supabase:
   - Get latest deployment from deployments table
   - Get error-level runtime_logs WHERE deployment_id matches
5. Returns: "TypeError in src/api/payments.ts:142 (Railway, 3 occurrences)"
6. Claude calls trace_error(log_id='<uuid>', repo='my-app')
7. MCP tool fetches runtime_logs entry by ID → gets stack_trace
8. Parses stack trace → file_path: "src/api/payments.ts", line: 142
9. Neo4j query: MATCH Function at payments.ts covering line 142
   → Function { name: "processPayment", start: 128, end: 165 }
10. Neo4j query: MATCH callers of processPayment
    → [handleCheckout in routes.ts, retryFailedPayments in retry-payments.ts]
11. Neo4j query: MATCH imports of payments.ts
    → [src/models/order.ts, stripe@14.1.0]
12. Supabase query: fetch full source of src/api/payments.ts
13. Returns composite response: function, callers, imports, full source, error context
14. Claude synthesizes the full picture and proposes a fix
```

### Flow 3: Collector poll cycle (normal operation)

```
1. Collector timer fires (every 10 seconds)
2. Query log_sources WHERE enabled = true AND due for poll
3. For each due source:
   a. Load adapter from registry by platform string
   b. Decrypt api_token from config
   c. Call adapter.fetchSince(config, last_poll_at)
   d. Adapter fetches from platform API
   e. Adapter returns NormalizedLogEntry[] and optionally NormalizedDeployment[]
   f. For each error-level entry with stack_trace but no file_path:
      - Run parseStackTrace(entry.stackTrace)
      - Set entry.filePath and entry.lineNumber from first frame
   g. Batch insert entries into runtime_logs
   h. Batch upsert deployments into deployments (ON CONFLICT deployment_id, source)
   i. Update log_sources.last_poll_at = NOW()
4. If adapter throws: catch, log, set log_sources.last_error, skip to next source
5. Collector timer resets for next tick
```

### Flow 4: Error path — adapter returns 429

```
1. Collector calls adapter.fetchSince()
2. Adapter calls Vercel API → receives 429 Too Many Requests
3. Adapter implements exponential backoff: wait 1s, retry
4. Second attempt → still 429 → wait 2s, retry
5. Third attempt → still 429 → wait 4s, retry
6. Fourth attempt → success or max retries (3) exceeded
7. If max retries exceeded: throw error with "Rate limited after 3 retries"
8. Collector catches error, sets log_sources.last_error = "Rate limited..."
9. Does NOT update last_poll_at (will retry next tick with same cursor)
10. Other sources continue unaffected
```

## Issues Found

### Dead Ends
- None identified — all outputs have consumers.

### Missing Sources
1. **`log_sources.last_error` column** — referenced in collector error handling and frontend status display, but not in the PRD schema. Must add to migration.
2. **`runtime_logs.repo_id` index** — needed for the MCP tools that filter by repo. The PRD indexes don't include a compound `(repo_id, timestamp DESC)` index. Must add.
3. **`deployments.repo_id` + `source` unique constraint** — needed for upsert. The PRD doesn't specify this. Must add `UNIQUE(repo_id, deployment_id, source)`.

### Phantom Dependencies
1. **Encryption utils** — currently live inside `packages/backend/src/connections.ts` as module-level functions. The collector needs them too. Must extract `encrypt()`/`decrypt()` into a shared module (`packages/backend/src/runtime/crypto.ts` or `packages/backend/src/lib/crypto.ts`).
2. **Adapter registry** — the collector needs to load adapters by platform string. Must create a registry that maps "vercel" → VercelAdapter, "railway" → RailwayAdapter.

### One-Way Streets
1. **Collector → log_sources.last_error** — errors are written but never cleared on successful poll. Must clear `last_error = null` on successful poll.

### Permission Gaps
- None — all external API calls use per-source tokens. No CORS issues (backend-to-API calls, not browser-to-API).

## Wiring Checklist

### Phase 1: Foundation (Database + Types + Crypto)
- [ ] Create `supabase-runtime-migration.sql` with runtime_logs, deployments, log_sources tables
- [ ] Add `last_error TEXT` column to log_sources (not in PRD, but needed)
- [ ] Add `UNIQUE(repo_id, deployment_id, source)` on deployments
- [ ] Add compound index `runtime_logs (repo_id, timestamp DESC)`
- [ ] Create `packages/backend/src/runtime/` directory structure
- [ ] Extract encrypt/decrypt from connections.ts → `packages/backend/src/lib/crypto.ts`
- [ ] Update connections.ts to import from shared crypto module
- [ ] Create adapter interface types at `packages/backend/src/runtime/adapters/types.ts`
- [ ] Create stack trace parser at `packages/backend/src/runtime/stack-parser.ts`

### Phase 2: Adapters + Registry
- [ ] Create Vercel adapter at `packages/backend/src/runtime/adapters/vercel.ts`
- [ ] Implement Vercel testConnection() → GET /v6/deployments?limit=1
- [ ] Implement Vercel fetchSince() → list deployments + fetch logs per deployment
- [ ] Implement Vercel fetchDeployments() → list recent deployments with status
- [ ] Create Railway adapter at `packages/backend/src/runtime/adapters/railway.ts`
- [ ] Implement Railway testConnection() → query { me { name } } (auth check)
- [ ] Implement Railway fetchSince() → list deployments + fetch logs per deployment
- [ ] Implement Railway fetchDeployments() → list recent deployments with status
- [ ] Both adapters: implement exponential backoff on 429 responses
- [ ] Both adapters: normalize log levels to info/warn/error
- [ ] Create adapter registry at `packages/backend/src/runtime/adapters/registry.ts`
- [ ] Register vercel + railway adapters in registry

### Phase 3: Log Collector + Retention
- [ ] Create collector at `packages/backend/src/runtime/collector.ts`
- [ ] Implement startCollector() — setInterval(10s) that queries due sources
- [ ] Implement stopCollector() — clearInterval
- [ ] Collector: load adapter from registry by platform
- [ ] Collector: decrypt api_token from log_sources.config
- [ ] Collector: call adapter.fetchSince(), handle errors per-source
- [ ] Collector: run parseStackTrace() on error entries lacking file_path
- [ ] Collector: batch insert into runtime_logs
- [ ] Collector: batch upsert into deployments
- [ ] Collector: update last_poll_at on success, last_error on failure, clear last_error on success
- [ ] Create retention worker at `packages/backend/src/runtime/retention.ts`
- [ ] Implement startRetention() — setInterval(1 hour), DELETE WHERE timestamp < NOW() - 30 days
- [ ] Implement stopRetention() — clearInterval
- [ ] Wire collector + retention into backend index.ts start() (after Supabase verified)
- [ ] Wire stopCollector + stopRetention into SIGINT handler

### Phase 4: Backend API Routes
- [ ] Create routes at `packages/backend/src/runtime/routes.ts`
- [ ] GET /api/log-sources — list sources with masked tokens
- [ ] POST /api/log-sources — create source (encrypt token, validate platform)
- [ ] PUT /api/log-sources/:id — update source
- [ ] DELETE /api/log-sources/:id — remove source
- [ ] POST /api/log-sources/:id/test — test connection via adapter
- [ ] POST /api/log-sources/:id/toggle — flip enabled
- [ ] Mount routes in backend index.ts: `app.use("/api/log-sources", logSourceRoutes)`
- [ ] Validate platform against adapter registry (reject unknown platforms)

### Phase 5: MCP Runtime Tools
- [ ] Create repo resolver at `packages/mcp-server/src/repo-resolver.ts`
- [ ] Create runtime tools file at `packages/mcp-server/src/runtime-tools.ts`
- [ ] Implement get_recent_logs — query runtime_logs with source/minutes/level/max_results filters
- [ ] Implement search_logs — full-text search on runtime_logs.message using GIN index
- [ ] Implement get_deploy_errors — query runtime_logs + deployments, scoped by deployment
- [ ] Implement get_deployment_history — query deployments with aggregated error/warn counts
- [ ] Implement trace_error — full chain: log fetch → stack parse → Neo4j function lookup → callers → imports → file source
- [ ] trace_error: graceful degradation when Neo4j returns empty (return partial context)
- [ ] Register all 5 tools in MCP server (import + call registerRuntimeTools(server) in index.ts)
- [ ] All tools: resolve repo name → UUID via resolveRepoId()

### Phase 6: Frontend Log Source UI
- [ ] Add API functions to `packages/frontend/src/api.ts`: getLogSources, createLogSource, updateLogSource, deleteLogSource, testLogSourceConnection, toggleLogSource
- [ ] Create LogSourcePanel component at `packages/frontend/src/components/LogSourcePanel.tsx`
- [ ] Platform selector dropdown (Vercel, Railway)
- [ ] Dynamic config fields per platform
- [ ] API token input (write-only, password type)
- [ ] Display name, polling interval, min level selectors
- [ ] Test Connection button with result display
- [ ] Source list with status indicators (Active/Error/Disabled + last_poll_at)
- [ ] Enable/Disable toggle per source
- [ ] Delete source with confirmation
- [ ] Mount LogSourcePanel in SettingsView.tsx below MCP Configuration section

## Build Order

**Phase 1: Foundation** — Database schema, types, crypto extraction, stack parser. Everything else depends on these.

**Phase 2: Adapters + Registry** — Vercel and Railway adapters implementing the interface from Phase 1. Can be tested independently with real API tokens.

**Phase 3: Log Collector + Retention** — Wires adapters to database. Depends on Phase 1 (tables, types, crypto) and Phase 2 (adapters). After this phase, logs flow into Supabase automatically.

**Phase 4: Backend API Routes** — CRUD for log sources. Depends on Phase 1 (tables, crypto) and Phase 2 (adapter registry for test connection). Enables the frontend to configure sources.

**Phase 5: MCP Runtime Tools** — The 5 new tools. Depends on Phase 1 (tables, stack parser) and Phase 3 (data in runtime_logs). This is the primary user-facing value.

**Phase 6: Frontend UI** — Log source configuration panel. Depends on Phase 4 (API routes). Could be built in parallel with Phase 5 since they're independent.

**Checkpoint gate:** After each phase, run the Phase Checkpoint before starting the next.
