# Brainstorm: Runtime Context Layer
**Created:** 2026-03-06
**Status:** Reviewed
**PRD:** repograph-runtime-prd.md

## Vision

The Runtime Context Layer connects live production logs to the existing Neo4j code graph so Claude Code can debug production errors without the developer ever leaving the terminal. It ingests logs from deployment platforms (Vercel, Railway, GitHub Actions) into Supabase via a pluggable adapter architecture, parses stack traces into structured file/line references, and exposes everything through 5 new MCP tools. The flagship `trace_error` tool takes a stack trace and returns the containing function, all callers, all imports, and full source — a complete debugging context in one call.

## Existing Context

### What Already Exists
- **Monorepo** with 3 packages: `backend` (Express API), `frontend` (React + Vite), `mcp-server` (stdio MCP)
- **Neo4j code graph** with nodes: Repository, File, Function, Class, TypeDef, Constant, Package, PackageExport
- **Neo4j edges:** CONTAINS_FILE, CONTAINS, CALLS, IMPORTS, DEPENDS_ON, PROVIDES
- **Supabase tables:** repositories, digest_jobs, file_contents, sync_events, user_connections
- **8 MCP tools** already registered: search_code, get_file, get_repo_structure, get_symbol, get_dependencies, trace_imports, get_upstream_dep, query_graph
- **Backend patterns:** singleton Neo4j driver (`getNeo4jDriver()`), singleton Supabase client (`getSupabase()`), AES-256-GCM credential encryption, JWT auth with GitHub OAuth
- **Sync system:** SyncManager with webhook + watcher modes, coalescing pattern for concurrent digests
- **Frontend:** DashboardView (repo list + sync), SettingsView (credentials + MCP panel), GraphExplorer, Sidebar navigation
- **Config:** `packages/backend/src/config.ts` reads env vars for Neo4j, Supabase, GitHub, ports

### Key Integration Points
- **MCP server** (`packages/mcp-server/src/index.ts`, 660 lines) — new runtime tools register here alongside existing 8 tools
- **Backend routes** (`packages/backend/src/routes.ts`, 346 lines) — new API endpoints for log source CRUD + test connection
- **Supabase client** (`packages/backend/src/db/supabase.ts`) — reused for runtime_logs, deployments, log_sources tables
- **Neo4j client** (`packages/backend/src/db/neo4j.ts`) — reused for trace_error cross-referencing
- **Frontend API client** (`packages/frontend/src/api.ts`, 286 lines) — new functions for log source config
- **Frontend SettingsView** (`packages/frontend/src/views/SettingsView.tsx`) — log source config zone lives here
- **Encryption utils** in `packages/backend/src/connections.ts` — reuse encrypt/decrypt for API tokens

## Components Identified

### 1. Log Adapter Interface
- **Responsibility**: Define the TypeScript contract all platform adapters implement
- **Upstream (receives from)**: Nothing — it's a type definition
- **Downstream (sends to)**: Implemented by Vercel, Railway, GitHub Actions adapters
- **External dependencies**: None
- **Hands test**: PASS — pure interface definition

### 2. Vercel Adapter
- **Responsibility**: Fetch logs and deployments from Vercel REST API
- **Upstream (receives from)**: Log Collector passes AdapterConfig (API token, project ID) and `since` timestamp
- **Downstream (sends to)**: Returns NormalizedLogEntry[] and NormalizedDeployment[] to Log Collector
- **External dependencies**: Vercel REST API (`/v2/deployments/{id}/events`, `/v6/deployments`), VERCEL_API_TOKEN or per-source encrypted token
- **Hands test**: PASS — if it has a valid API token and project ID, it can fetch real logs

### 3. Railway Adapter
- **Responsibility**: Fetch logs and deployments from Railway GraphQL API
- **Upstream (receives from)**: Log Collector passes AdapterConfig (API token, project/service/environment IDs) and `since` timestamp
- **Downstream (sends to)**: Returns NormalizedLogEntry[] and NormalizedDeployment[] to Log Collector
- **External dependencies**: Railway GraphQL API (`https://backboard.railway.app/graphql/v2`), RAILWAY_API_TOKEN or per-source encrypted token
- **Hands test**: PASS — if it has a valid API token and project context, it can fetch real logs

### 4. GitHub Actions Adapter
- **Responsibility**: Fetch CI/CD workflow run logs from GitHub Actions REST API
- **Upstream (receives from)**: Log Collector passes AdapterConfig (GitHub token, owner/repo) and `since` timestamp
- **Downstream (sends to)**: Returns NormalizedLogEntry[] and NormalizedDeployment[] to Log Collector
- **External dependencies**: GitHub REST API (`/repos/{owner}/{repo}/actions/runs`, `/runs/{run_id}/logs`), GitHub PAT or app token
- **Hands test**: PASS — if it has a valid GitHub token with actions:read scope, it can fetch real logs. Note: log archives are zip files that need extraction.

### 5. Stack Trace Parser
- **Responsibility**: Extract file paths and line numbers from raw stack trace strings
- **Upstream (receives from)**: Log Collector passes raw stack trace strings from error-level log entries
- **Downstream (sends to)**: Returns parsed { filePath, lineNumber, functionName }[] to Log Collector for storage on runtime_logs columns
- **External dependencies**: None — pure regex parsing
- **Hands test**: PASS — pure function, no external dependencies. Handles Node.js, Vercel serverless, Python, Go formats.

### 6. Log Collector (Scheduler + Worker)
- **Responsibility**: Run on a configurable interval, load enabled log_sources from Supabase, invoke each adapter's fetchSince(), run stack trace parser on errors, batch-insert into runtime_logs, update last_poll_at
- **Upstream (receives from)**: log_sources table (enabled sources with config), adapters (normalized log entries)
- **Downstream (sends to)**: runtime_logs table (inserts), deployments table (inserts), log_sources table (updates last_poll_at)
- **External dependencies**: Supabase client (read/write), adapter modules (loaded by platform identifier)
- **Hands test**: NEEDS ATTENTION — The collector needs:
  1. A scheduler mechanism (setInterval or cron) — must be started when the backend boots
  2. Access to adapter registry to resolve platform → adapter module
  3. Error handling for individual adapter failures (one failing adapter shouldn't block others)
  4. Rate limit handling (exponential backoff on 429s)

### 7. Adapter Registry
- **Responsibility**: Map platform identifiers to adapter module instances
- **Upstream (receives from)**: Log Collector looks up adapters by platform string from log_sources
- **Downstream (sends to)**: Returns instantiated adapter to Log Collector
- **External dependencies**: None — in-memory map
- **Hands test**: PASS — simple registry pattern. Must be populated at boot time with all first-party adapters.

### 8. Log Retention Worker
- **Responsibility**: Prune runtime_logs entries older than 30 days (configurable)
- **Upstream (receives from)**: Runs on cron schedule (e.g., daily)
- **Downstream (sends to)**: Deletes from runtime_logs table
- **External dependencies**: Supabase client
- **Hands test**: PASS — straightforward DELETE WHERE timestamp < NOW() - retention_period

### 9. Supabase Migration (3 new tables)
- **Responsibility**: Create runtime_logs, deployments, log_sources tables with indexes
- **Upstream (receives from)**: Applied manually or via migration runner
- **Downstream (sends to)**: All runtime components read/write these tables
- **External dependencies**: Supabase/Postgres
- **Hands test**: PASS — SQL migration file, same pattern as existing supabase-migration.sql

### 10. Backend API Routes (Log Source CRUD)
- **Responsibility**: REST endpoints for creating, listing, updating, deleting, and testing log sources
- **Upstream (receives from)**: Frontend UI sends requests via API client
- **Downstream (sends to)**: log_sources table (CRUD), adapter.testConnection() for validation
- **External dependencies**: Express router (existing), auth middleware (existing), encryption utils (existing in connections.ts)
- **Hands test**: NEEDS ATTENTION —
  1. API token encryption must reuse existing AES-256-GCM pattern from connections.ts
  2. Test connection must actually instantiate the adapter and call testConnection()
  3. Routes must be registered in backend index.ts

### 11. MCP Runtime Tools (5 new tools)
- **Responsibility**: Expose log querying and error bridging to Claude Code via MCP protocol
- **Upstream (receives from)**: Claude Code calls tools via stdio MCP transport
- **Downstream (sends to)**:
  - get_recent_logs → queries runtime_logs
  - search_logs → full-text search on runtime_logs
  - get_deploy_errors → queries runtime_logs + deployments
  - get_deployment_history → queries deployments + aggregated counts from runtime_logs
  - trace_error → queries runtime_logs for stack trace, then Neo4j for Function node + callers + imports, then Supabase file_contents for source
- **External dependencies**: Supabase client, Neo4j driver, @modelcontextprotocol/sdk (already used)
- **Hands test**: NEEDS ATTENTION —
  1. trace_error is the most complex — it chains: stack parse → Neo4j Function lookup → caller query → imports query → file content fetch. Every link must work.
  2. All 5 tools need repo_id resolution (the PRD tools accept repo name, need to resolve to UUID)
  3. The existing MCP server connects directly to Neo4j and Supabase (not through the backend API). New tools follow same pattern.

### 12. Frontend Log Source Config UI
- **Responsibility**: UI for adding/editing/deleting log sources with platform selector, API token input, config fields, test connection, enable/disable toggle
- **Upstream (receives from)**: User interaction, backend API responses
- **Downstream (sends to)**: Backend API (log source CRUD + test connection)
- **External dependencies**: React, existing SettingsView layout, existing API client patterns
- **Hands test**: NEEDS ATTENTION —
  1. Dynamic config fields per platform (Vercel needs project ID, Railway needs project + service + environment, GitHub Actions needs owner/repo)
  2. API token is write-only — must never be returned in GET responses
  3. Test connection button must invoke adapter.testConnection() through backend API and display result
  4. Status indicator per source (active/error/disabled with last_poll_at)

## Rough Dependency Map

```
                    ┌─────────────────────┐
                    │   Frontend UI       │
                    │  (Log Source Config) │
                    └──────────┬──────────┘
                               │ REST API
                    ┌──────────▼──────────┐
                    │  Backend API Routes  │
                    │  (Log Source CRUD)   │
                    └──────────┬──────────┘
                               │ reads/writes
                    ┌──────────▼──────────┐
                    │    log_sources       │
                    │    (Supabase)        │
                    └──────────┬──────────┘
                               │ reads enabled sources
                    ┌──────────▼──────────┐
                    │   Log Collector      │◄──── Adapter Registry
                    │   (Scheduler)        │         │
                    └──┬───┬───┬───────────┘    ┌────┴────┐
                       │   │   │                │ Vercel  │
          ┌────────────┘   │   └──────┐         │ Railway │
          ▼                ▼          ▼         │ GitHub  │
   runtime_logs      deployments   Stack        └─────────┘
   (Supabase)        (Supabase)    Trace
        │                           Parser
        │
   ┌────▼────────────────────────────────┐
   │         MCP Runtime Tools           │
   │  get_recent_logs, search_logs,      │
   │  get_deploy_errors,                 │
   │  get_deployment_history,            │
   │  trace_error                        │
   └────┬───────────────┬───────────────┘
        │               │
        ▼               ▼
   Supabase          Neo4j
   (runtime_logs,    (Function, File,
    file_contents)    CALLS, IMPORTS)
```

## Resolved Decisions

1. **Log Collector runs in the backend process.** setInterval in the Express server, same pattern as the existing job timeout checker. Has access to Supabase, encryption keys, and adapter modules. No new process to configure.

2. **API tokens encrypted in log_sources.config JSONB.** Reuse existing AES-256-GCM encryption from connections.ts. Token stored encrypted inside the config column. Collector decrypts at poll time. No extra tables or columns.

3. **Repo name → UUID resolution via Supabase in MCP server.** Add a shared helper that queries the `repositories` table by name. The MCP server already has a Supabase client. All 5 new runtime tools use this helper.

4. **GitHub Actions adapter deferred to v1.1.** Zip archive parsing is significantly more complex. v1 ships Vercel + Railway only (both return structured JSON). GitHub Actions added as fast-follow once the adapter pattern is proven.

## Risks and Concerns

1. **trace_error complexity:** This tool chains 4+ queries (stack parse → Neo4j function lookup → callers → imports → file content). If any link returns empty (e.g., the file was renamed since last digest, or the function isn't in Neo4j yet), the tool needs graceful degradation — return partial context rather than failing entirely.

2. **Vercel API structure:** Vercel logs are per-deployment, not per-project. The adapter needs to first list recent deployments, then fetch logs for each. This is 2+ API calls per poll cycle, multiplied by number of recent deployments. Rate limits could be tight.

3. **Railway GraphQL complexity:** Railway's API requires knowing the deployment ID to fetch logs. Similar to Vercel, need to list deployments first, then fetch logs per deployment.

4. **Polling vs. real-time:** The PRD explicitly says polling is acceptable for v1. But 30-second polling with multiple API calls per source could add up. Need to handle adapter failures gracefully so one slow/broken adapter doesn't delay others.

5. **MCP server is a separate process:** The MCP server (`packages/mcp-server/`) runs as a stdio process, separate from the backend. It connects directly to Neo4j and Supabase. The new MCP tools need Supabase access to query runtime_logs — this is fine since the MCP server already has a Supabase client. But the stack trace parser needs to be importable from the MCP server package.

6. **Encryption key availability:** The existing encryption uses `SESSION_SECRET` from the backend. The Log Collector needs to decrypt API tokens from log_sources. If the collector runs in the backend process, it has access. If it runs separately, it needs the same secret.
