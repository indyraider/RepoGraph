# RepoGraph — Product Requirements Document

**GitHub Repository Knowledge Graph for Claude Code Integration**

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | March 5, 2026 |
| **Status** | Draft |

---

## 1. Overview

RepoGraph is a local-first developer tool that ingests GitHub repositories into a Neo4j knowledge graph and exposes that graph to Claude Code via an MCP (Model Context Protocol) server. The goal is to give Claude Code full structural awareness of your codebase and its upstream dependencies so it can debug, refactor, and build features with deep contextual understanding.

The primary use case is accelerating development on Qwikr by allowing Claude Code to query the entire codebase topology, trace import chains, look up symbol definitions across packages, and understand how upstream libraries are consumed — all without requiring the developer to manually paste files into context.

---

## 2. Problem Statement

When working with Claude Code on a non-trivial codebase like Qwikr, the AI lacks holistic awareness of the project. It can only see files that are explicitly provided or that it discovers by walking the file tree. This leads to several recurring pain points:

- Claude Code does not understand the full import/dependency graph and frequently misattributes where a function or type originates.
- Upstream dependency APIs (node_modules, pip packages) are invisible unless the developer manually surfaces them.
- Debugging multi-file issues requires repeatedly pasting context that a knowledge graph could serve instantly.
- There is no persistent, queryable representation of the codebase that survives across Claude Code sessions.

RepoGraph solves this by creating a durable, structured, queryable knowledge graph of the entire codebase and its dependencies, then bridging that graph to Claude Code over MCP.

---

## 3. Goals & Non-Goals

### 3.1 Goals

1. Provide a simple web UI to paste a GitHub repo URL and trigger ingestion into a Neo4j knowledge graph.
2. Parse the repository into a structural graph: files, modules, functions, classes, imports, exports, and their relationships.
3. Resolve and index direct upstream dependencies (public APIs only) from lockfiles.
4. Expose the knowledge graph to Claude Code through an MCP server with purpose-built query tools.
5. Support re-ingestion to keep the graph in sync as the repo evolves.
6. Run entirely locally (or on a private server) with no external SaaS dependency for the core loop.

### 3.2 Non-Goals

- Production-grade multi-tenant SaaS deployment.
- Support for private repos requiring OAuth flows (SSH clone or local path is sufficient for v1).
- Real-time live-sync with Git (polling or manual re-digest is acceptable).
- Full recursive dependency resolution (direct deps only for v1).
- Fancy UI with dashboards, visualizations, or analytics (paste-and-go is the bar).

---

## 4. System Architecture

The system is composed of five layers that form a pipeline from repo URL to Claude Code tool call.

| Layer | Component | Technology | Responsibility |
|---|---|---|---|
| Presentation | Web UI | React (Vite) + Tailwind | Paste repo URL, trigger digest, view status |
| API | Backend Server | Node.js (Express) or Python (FastAPI) | Handle digest requests, orchestrate pipeline, serve MCP |
| Parsing | Code Analyzer | tree-sitter (multi-lang) | AST parsing, symbol extraction, import/export resolution |
| Storage | Knowledge Graph | Neo4j (primary) + Supabase (metadata) | Store code graph nodes/edges; store job metadata and repo state |
| Integration | MCP Server | TypeScript (@modelcontextprotocol/sdk) | Expose graph query tools to Claude Code |

### 4.1 Data Flow

The ingestion pipeline follows a linear flow with discrete, resumable stages:

1. **Clone** — Shallow-clone the repository to a temp directory. For repos requiring auth, support SSH URLs or local paths.
2. **Scan** — Walk the file tree. Catalog every file by path, language (inferred from extension), and size. Store raw content.
3. **Parse** — Run tree-sitter on each supported file. Extract functions, classes, type definitions, constants, imports, and exports as graph nodes.
4. **Resolve** — Map import statements to their targets (internal file or external package). Create IMPORTS, EXPORTS, CALLS, and CONTAINS edges.
5. **Deps** — Parse lockfiles (package-lock.json, yarn.lock, poetry.lock, go.sum). Fetch or extract public API signatures for direct dependencies.
6. **Load** — Batch-insert all nodes and edges into Neo4j. Update job status in Supabase.

### 4.2 Neo4j Graph Schema

#### 4.2.1 Node Labels

| Label | Description | Key Properties |
|---|---|---|
| Repository | Top-level repo node | name, url, branch, last_digest_at |
| File | A single file in the repo | path, language, size_bytes, content_hash |
| Module | A logical module / namespace | name, path, language |
| Function | A function or method definition | name, signature, docstring, start_line, end_line |
| Class | A class or interface definition | name, docstring, start_line, end_line |
| TypeDef | A type alias or interface | name, definition, start_line |
| Constant | An exported constant / config value | name, value_preview, start_line |
| Package | An upstream dependency package | name, version, registry (npm/pypi/etc) |
| PackageExport | A public API symbol from a package | name, signature, kind (function/class/type) |

#### 4.2.2 Relationship Types

| Relationship | From | To | Properties |
|---|---|---|---|
| CONTAINS_FILE | Repository | File | — |
| CONTAINS | File \| Class | Function \| Class \| TypeDef \| Constant | — |
| IMPORTS | File | File \| Package | symbols (list), alias |
| EXPORTS | File | Function \| Class \| TypeDef \| Constant | is_default (bool) |
| CALLS | Function | Function | call_site_line |
| EXTENDS | Class | Class | — |
| IMPLEMENTS | Class | TypeDef | — |
| DEPENDS_ON | Repository | Package | version_spec, resolved_version |
| PROVIDES | Package | PackageExport | — |

### 4.3 Supabase Role

Supabase serves as the metadata and operational database, not the knowledge graph itself. It handles:

- **Digest Jobs:** Track ingestion state (queued, cloning, parsing, loading, complete, failed) with timestamps and error logs.
- **Repository Registry:** Record of all indexed repos, their last digest time, branch, commit SHA, and digest config overrides.
- **User Preferences:** Optional. If the tool is ever multi-user, store per-user repo lists and settings.
- **File Content Store:** Raw file content stored in Supabase Storage (or as text columns) so the MCP server can serve full file contents without re-cloning.

### 4.4 Supabase Schema

| Table | Columns | Purpose |
|---|---|---|
| repositories | id, url, name, branch, commit_sha, last_digest_at, status, config (jsonb) | Registry of all tracked repos |
| digest_jobs | id, repo_id, status, stage, started_at, completed_at, error_log, stats (jsonb) | Ingestion job tracking and history |
| file_contents | id, repo_id, file_path, content (text), content_hash, language, size_bytes | Raw file storage for MCP retrieval |

---

## 5. MCP Server Specification

The MCP server is the primary integration point with Claude Code. It exposes a focused set of tools that let Claude query the knowledge graph naturally during debugging and development sessions.

### 5.1 Tool Definitions

| Tool Name | Description | Key Parameters |
|---|---|---|
| search_code | Full-text search across all indexed file contents | query (string), language? (string), max_results? (int) |
| get_file | Retrieve full content of a specific file by path | repo (string), path (string) |
| get_symbol | Look up a function, class, or type by name. Returns definition, signature, docstring, file location, and usages. | name (string), kind? (function\|class\|type), repo? (string) |
| get_dependencies | For a given file, return all imports (what it depends on) and all reverse imports (what depends on it). | repo (string), path (string), direction? (in\|out\|both) |
| get_upstream_dep | Look up the public API of an upstream npm/pip/go package as indexed from the lockfile. | package_name (string), symbol? (string) |
| get_repo_structure | Return the full file tree of a repository, optionally filtered by directory or depth. | repo (string), root? (string), depth? (int) |
| trace_imports | Multi-hop traversal: starting from a file or symbol, walk the full import chain up to N hops. | start_path (string), repo (string), max_depth? (int), direction? (upstream\|downstream) |
| query_graph | Escape hatch: run a raw Cypher query against the Neo4j graph for advanced or ad-hoc queries. | cypher (string), params? (object) |

### 5.2 MCP Server Configuration

Claude Code connects to the MCP server via its config file. The server runs on localhost and communicates over stdio or SSE, depending on deployment preference.

```json
{
  "mcpServers": {
    "repograph": {
      "command": "node",
      "args": ["path/to/repograph/mcp-server/index.js"],
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "SUPABASE_URL": "http://localhost:54321",
        "SUPABASE_KEY": "your-local-key"
      }
    }
  }
}
```

---

## 6. Web UI Specification

The web interface is intentionally minimal. It is a utility, not a product. The entire UI is a single page with two zones.

### 6.1 Digest Input Zone

- A text input field accepting a GitHub HTTPS or SSH URL, or a local file path.
- A branch selector (defaults to main/master, auto-detected).
- A **Digest** button that submits the job to the backend.
- Inline validation: reject malformed URLs, show immediate feedback.

### 6.2 Repository Status Zone

- A list/table of all previously digested repositories.
- Each row shows: repo name, branch, last digest timestamp, status (idle / digesting / error), and a Re-Digest button.
- Clicking a repo expands inline to show digest stats (file count, node count, edge count, duration) and any error logs.
- A Delete button to remove a repo and purge its graph data.

### 6.3 Live Progress (During Digest)

While a digest job is running, the UI should show a progress indicator with the current stage (cloning, scanning, parsing, resolving, loading) and a count of files processed vs. total. This can be implemented with a simple polling endpoint or WebSocket.

---

## 7. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| Web UI | React (Vite) + Tailwind CSS | Fast to scaffold, familiar tooling, minimal build config. |
| API Server | Node.js with Express (TypeScript) | Single language across the stack. TypeScript for MCP SDK compatibility. |
| Code Parsing | tree-sitter (via node bindings) | Best-in-class multi-language AST parsing. Supports JS/TS, Python, Go, Rust, Java, and more. |
| Knowledge Graph | Neo4j Community Edition (Docker) | Native graph DB with Cypher query language. Ideal for multi-hop traversals like import chains. |
| Metadata DB | Supabase (local via CLI or hosted) | Postgres-backed with built-in auth, storage, and realtime subscriptions for job status. |
| File Storage | Supabase Storage or local disk | Store raw file contents for MCP retrieval without re-cloning. |
| MCP Server | @modelcontextprotocol/sdk (TypeScript) | Official SDK for building MCP servers. First-class Claude Code support. |
| Containerization | Docker Compose | Single docker-compose.yml spins up Neo4j, Supabase, and the app server. |

---

## 8. Phased Delivery Plan

### Phase 1 — Foundation (MVP)

**Goal:** Paste a repo URL, get all files indexed and queryable from Claude Code.
**Duration:** 1–2 weeks

- Web UI with paste input and status table.
- Backend: clone repo, walk file tree, store file nodes and raw content.
- Neo4j: Repository and File nodes with CONTAINS_FILE edges.
- Supabase: repositories and digest_jobs tables, file_contents storage.
- MCP server with search_code, get_file, and get_repo_structure tools.
- Docker Compose for Neo4j + app.

**Exit Criteria:** Claude Code can connect to the MCP server, search the codebase, and retrieve any file by path.

### Phase 2 — Structural Graph

**Goal:** Parse code into symbols and relationships so Claude can query the graph structurally.
**Duration:** 2–3 weeks

- Integrate tree-sitter for JS/TS, Python, and Go (extensible to other languages).
- Extract Function, Class, TypeDef, Constant nodes.
- Resolve import/export relationships into IMPORTS, EXPORTS, CONTAINS, and CALLS edges.
- Add get_symbol, get_dependencies, and trace_imports MCP tools.

**Exit Criteria:** Claude Code can look up any symbol, see where it is defined and used, and trace an import chain across files.

### Phase 3 — Upstream Dependencies

**Goal:** Index the public APIs of direct upstream dependencies so Claude understands library usage.
**Duration:** 1–2 weeks

- Parse lockfiles to identify direct dependencies and their resolved versions.
- Fetch or extract dependency source and parse their public exports (exported functions, classes, types).
- Create Package and PackageExport nodes with DEPENDS_ON and PROVIDES edges.
- Add get_upstream_dep MCP tool.

**Exit Criteria:** Claude Code can query the public API of any direct dependency and understand how it is consumed in the codebase.

### Phase 4 — Polish & Resilience

**Goal:** Harden the system for daily use.
**Duration:** 1 week

- Incremental re-digest: diff against previous commit SHA and only re-parse changed files.
- Error recovery: retry failed stages, resume from last successful stage.
- Add query_graph escape-hatch MCP tool for raw Cypher.
- Performance tuning: Neo4j indexes on name, path, and content_hash properties.
- Documentation: README with setup instructions and MCP tool reference.

---

## 9. Performance Considerations

RepoGraph is a local developer tool, not a production service. Performance targets are oriented around developer experience, not enterprise scale.

| Metric | Target | Notes |
|---|---|---|
| Initial digest (medium repo, ~5K files) | < 5 minutes | Includes clone, parse, and Neo4j load. |
| Incremental re-digest | < 30 seconds | Only re-parse changed files (diff against stored SHA). |
| MCP tool response (search_code) | < 500ms | Full-text index on file content in Supabase. |
| MCP tool response (get_symbol) | < 200ms | Neo4j Cypher with indexed name property. |
| MCP tool response (trace_imports, 5 hops) | < 1 second | Neo4j graph traversal. |
| Neo4j graph size (large monorepo, ~50K files) | < 2GB disk | Nodes + relationships + indexes. |

---

## 10. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| tree-sitter fails on edge-case syntax (decorators, macros) | Medium | Graceful fallback: index the file as raw content without structural nodes. Log and surface parsing errors in UI. |
| Upstream dependency resolution is slow or flaky | Medium | Cache fetched dependency sources. Limit to direct deps only. Fail open (skip unresolvable deps, still index everything else). |
| Neo4j resource usage on large repos | Low | Set memory limits in Docker config. Use batch imports. Add property indexes. |
| MCP SDK breaking changes | Low | Pin SDK version. The protocol is relatively stable. |
| Stale graph after many code changes | Medium | Incremental re-digest in Phase 4. Visual indicator in UI when graph is stale (last digest > 24h). |

---

## 11. Success Criteria

RepoGraph is successful when it measurably improves the Claude Code development workflow on Qwikr. Specifically:

1. Claude Code can answer structural questions about the codebase (where is X defined, what imports Y, what does this dependency export) without the developer manually providing files.
2. Debugging sessions that previously required 5+ manual file pastes can be resolved with zero manual context loading.
3. The developer can digest a new repo and have it queryable from Claude Code within 5 minutes.
4. The system runs reliably on a single developer machine with Docker, requiring no external services beyond Supabase (local or hosted).

---

## 12. Appendix

### 12.1 Example Cypher Queries

These represent the kinds of queries the MCP server will execute under the hood.

**Find all functions in a file:**
```cypher
MATCH (f:File {path: 'src/api/routes.ts'})-[:CONTAINS]->(fn:Function)
RETURN fn.name, fn.signature, fn.start_line
```

**Trace the full import chain from a file:**
```cypher
MATCH path = (f:File {path: 'src/index.ts'})-[:IMPORTS*1..5]->(dep)
RETURN [n IN nodes(path) | n.path] AS chain
```

**Find all usages of a symbol across the codebase:**
```cypher
MATCH (fn:Function {name: 'processPayment'})<-[:CALLS]-(caller:Function)
MATCH (caller)<-[:CONTAINS]-(f:File)
RETURN f.path, caller.name, caller.start_line
```

**List public API of an upstream package:**
```cypher
MATCH (p:Package {name: 'express'})-[:PROVIDES]->(exp:PackageExport)
RETURN exp.name, exp.kind, exp.signature
```
