# Build Plan: RepoGraph

**Created:** 2026-03-05
**Brainstorm:** `../brainstorm/repograph-brainstorm-2026-03-05.md`
**Status:** Draft

## Overview

RepoGraph ingests GitHub repositories into a Neo4j knowledge graph and exposes that graph to Claude Code via an MCP server. It gives Claude Code structural awareness of any codebase — file trees, symbol definitions, import/export chains, and upstream dependency APIs — without manual context loading. The system is TypeScript throughout: React/Vite frontend, Node.js/Express backend, MCP server via `@modelcontextprotocol/sdk`, Neo4j for graph storage, hosted Supabase for metadata and file content.

---

## Component Inventory

| # | Component | Inputs | Outputs | Key Dependencies |
|---|-----------|--------|---------|-----------------|
| 1 | Web UI | User input (URL, branch), API responses | HTTP requests to backend | React, Vite, Tailwind |
| 2 | Backend API | HTTP requests from UI | Job orchestration, DB writes | Express, neo4j-driver, @supabase/supabase-js |
| 3 | Repo Cloner | Repo URL + branch | Cloned dir path on disk | git CLI, simple-git |
| 4 | File Scanner | Cloned dir path | File catalog (path, lang, size, content) | Node.js fs, fast-glob |
| 5 | Code Parser | File path + content + language | AST nodes (functions, classes, types, imports, exports) | node-tree-sitter, language grammars |
| 6 | Import Resolver | Raw import statements + file index | Resolved import targets (file or package) | tsconfig parser, Node module resolution |
| 7 | Dependency Indexer | Lockfile content | Package + PackageExport nodes | npm registry, .d.ts parser |
| 8 | Neo4j Loader | Nodes + edges from pipeline stages | Graph data in Neo4j | neo4j-driver |
| 9 | Supabase Client | Job state, file content, repo metadata | Persisted metadata + content | @supabase/supabase-js |
| 10 | MCP Server | Claude Code tool calls (stdio) | Query results from Neo4j + Supabase | @modelcontextprotocol/sdk, neo4j-driver, @supabase/supabase-js |

---

## Integration Contracts

### Contract 1: Web UI → Backend API

```
[Web UI] → [Backend API]
  What flows:     POST /api/digest { url: string, branch?: string }
                  GET /api/repositories → Repository[]
                  GET /api/jobs/:id → DigestJob
                  DELETE /api/repositories/:id
  How it flows:   HTTP REST (fetch from React)
  Auth/Config:    None (local tool, no auth required for v1)
  Error path:     API returns { error: string, status: number }. UI displays inline error.
```

### Contract 2: Backend API → Repo Cloner

```
[Backend API] → [Repo Cloner]
  What flows:     clone(url: string, branch: string) → { localPath: string }
  How it flows:   Internal function call within the backend process
  Auth/Config:    git CLI on PATH. SSH keys in ~/.ssh for SSH URLs.
  Error path:     Clone failure (bad URL, auth failure, network) → throw with error message.
                  Backend catches, updates job status to "failed" in Supabase, returns error to UI.
```

### Contract 3: Repo Cloner → File Scanner

```
[Repo Cloner] → [File Scanner]
  What flows:     localPath: string (path to cloned repo on disk)
  How it flows:   Return value passed to next pipeline stage
  Auth/Config:    Filesystem read access to temp directory
  Error path:     If path doesn't exist or is empty → fail job with "clone produced empty directory"
```

### Contract 4: File Scanner → Code Parser

```
[File Scanner] → [Code Parser]
  What flows:     Array of { path: string, content: string, language: string }
  How it flows:   Internal iteration — scanner yields files, parser processes each
  Auth/Config:    None
  Error path:     Unsupported language → skip parsing, still store as raw File node.
                  tree-sitter parse error → log warning, store file without structural nodes.
```

### Contract 5: File Scanner → Supabase (file content storage)

```
[File Scanner] → [Supabase]
  What flows:     INSERT into file_contents: { repo_id, file_path, content, content_hash, language, size_bytes }
  How it flows:   @supabase/supabase-js client, batch upsert
  Auth/Config:    SUPABASE_URL + SUPABASE_SERVICE_KEY env vars
  Error path:     Insert failure → log error, continue with remaining files. Mark job with warning.
```

### Contract 6: Code Parser → Import Resolver

```
[Code Parser] → [Import Resolver]
  What flows:     Array of { filePath: string, imports: Array<{ source: string, symbols: string[], isDefault: bool }> }
  How it flows:   Parser emits import data, resolver processes after all files are parsed
  Auth/Config:    Needs access to repo's tsconfig.json for path alias resolution
  Error path:     Unresolvable import → create IMPORTS edge to Package node (assume external). Log warning.
```

### Contract 7: Import Resolver → Neo4j Loader

```
[Import Resolver] → [Neo4j Loader]
  What flows:     Resolved edges: Array<{ from: string, to: string, type: "IMPORTS"|"CALLS", symbols: string[] }>
  How it flows:   Batch passed to loader after resolution is complete
  Auth/Config:    None (internal data handoff)
  Error path:     None — resolver outputs best-effort results
```

### Contract 8: Code Parser → Neo4j Loader (structural nodes)

```
[Code Parser] → [Neo4j Loader]
  What flows:     Nodes: Function, Class, TypeDef, Constant with properties (name, signature, docstring, lines)
                  Edges: CONTAINS (File→Symbol), EXPORTS (File→Symbol)
  How it flows:   Batch passed to loader
  Auth/Config:    None
  Error path:     None — parser outputs what it can extract
```

### Contract 9: File Scanner → Neo4j Loader (file + repo nodes)

```
[File Scanner] → [Neo4j Loader]
  What flows:     Repository node: { name, url, branch, last_digest_at }
                  File nodes: Array<{ path, language, size_bytes, content_hash }>
                  CONTAINS_FILE edges: Repository → File
  How it flows:   Batch passed to loader
  Auth/Config:    None
  Error path:     None
```

### Contract 10: Neo4j Loader → Neo4j

```
[Neo4j Loader] → [Neo4j]
  What flows:     Cypher UNWIND batch queries for nodes and edges
  How it flows:   neo4j-driver bolt connection
  Auth/Config:    NEO4J_URI (bolt://localhost:7687), NEO4J_USER, NEO4J_PASSWORD env vars
  Error path:     Connection failure → fail job. Constraint violation → log and skip duplicate.
                  Batch too large → chunk into batches of 1000.
```

### Contract 11: Backend API → Supabase (job tracking)

```
[Backend API] → [Supabase]
  What flows:     INSERT/UPDATE digest_jobs: { repo_id, status, stage, started_at, completed_at, error_log, stats }
                  INSERT/UPDATE repositories: { url, name, branch, commit_sha, last_digest_at, status }
  How it flows:   @supabase/supabase-js client
  Auth/Config:    SUPABASE_URL + SUPABASE_SERVICE_KEY
  Error path:     Supabase down → job tracking fails, but pipeline can still proceed. Log to console as fallback.
```

### Contract 12: MCP Server → Neo4j

```
[MCP Server] → [Neo4j]
  What flows:     Cypher queries for each MCP tool (get_symbol, get_dependencies, trace_imports, query_graph)
  How it flows:   neo4j-driver bolt connection (separate driver instance from backend)
  Auth/Config:    NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD env vars (set in Claude Code MCP config)
  Error path:     Query failure → return error message to Claude Code via MCP tool response.
                  Neo4j unreachable → tool returns "Neo4j connection failed" error.
```

### Contract 13: MCP Server → Supabase

```
[MCP Server] → [Supabase]
  What flows:     SELECT from file_contents for get_file and search_code tools
                  Full-text search via tsvector for search_code
  How it flows:   @supabase/supabase-js client (separate instance from backend)
  Auth/Config:    SUPABASE_URL + SUPABASE_KEY env vars (set in Claude Code MCP config)
  Error path:     Query failure → return error message via MCP tool response.
```

### Contract 14: Claude Code → MCP Server

```
[Claude Code] → [MCP Server]
  What flows:     MCP tool calls (JSON-RPC over stdio)
  How it flows:   Claude Code spawns MCP server as child process via config in .claude.json or mcp settings
  Auth/Config:    MCP server config: { command: "node", args: ["path/to/mcp-server/index.js"], env: {...} }
  Error path:     Server crash → Claude Code shows MCP connection error. Server must handle all errors gracefully and never crash.
```

### Contract 15: Dependency Indexer → Neo4j Loader (Phase 3)

```
[Dependency Indexer] → [Neo4j Loader]
  What flows:     Package nodes: { name, version, registry }
                  PackageExport nodes: { name, signature, kind }
                  DEPENDS_ON edges: Repository → Package
                  PROVIDES edges: Package → PackageExport
  How it flows:   Batch passed to loader
  Auth/Config:    npm registry (public, no auth for public packages)
  Error path:     Package not found → skip, log warning. Types unavailable → create Package node without exports.
```

---

## End-to-End Flows

### Flow 1: Digest a Repository (Happy Path)

```
1.  User pastes "https://github.com/user/repo" into Web UI text input
2.  User clicks "Digest" button
3.  Web UI sends POST /api/digest { url: "https://github.com/user/repo", branch: "main" }
4.  Backend validates URL format (regex for GitHub HTTPS/SSH or local path)
5.  Backend creates/updates row in Supabase `repositories` table { url, name, branch, status: "digesting" }
6.  Backend creates row in Supabase `digest_jobs` table { repo_id, status: "running", stage: "cloning" }
7.  Backend returns { jobId: "uuid", repoId: "uuid" } to Web UI
8.  Web UI starts polling GET /api/jobs/:jobId every 2 seconds
9.  Backend calls Cloner: git clone --depth 1 --branch main <url> /tmp/repograph/<uuid>
10. Backend updates job stage to "scanning" in Supabase
11. Scanner walks /tmp/repograph/<uuid>, catalogs all files (skip .git/, node_modules/, binaries)
12. Scanner generates File node data + raw content for each file
13. Backend updates job stage to "parsing" in Supabase
14. Parser runs tree-sitter on each supported file (TS, JS, Python, Go)
15. Parser extracts Function, Class, TypeDef, Constant nodes and CONTAINS/EXPORTS edges
16. Parser extracts raw import statements
17. Backend updates job stage to "resolving" in Supabase
18. Import Resolver maps each import to target file (relative path) or package (bare specifier)
19. Resolver reads tsconfig.json for path alias resolution (if present)
20. Resolver produces IMPORTS edges (File→File or File→Package)
21. Backend updates job stage to "loading" in Supabase
22. Neo4j Loader batch-inserts: Repository node, File nodes, CONTAINS_FILE edges
23. Neo4j Loader batch-inserts: Function/Class/TypeDef/Constant nodes, CONTAINS/EXPORTS edges
24. Neo4j Loader batch-inserts: IMPORTS edges
25. Supabase Client batch-upserts file contents into file_contents table
26. Backend updates job: { status: "complete", stage: "done", completed_at: now(), stats: { files, nodes, edges, duration } }
27. Backend updates repository: { status: "idle", last_digest_at: now(), commit_sha: "<sha>" }
28. Backend cleans up temp directory: rm -rf /tmp/repograph/<uuid>
29. Web UI poll receives completed status, shows success with stats
```

### Flow 2: Claude Code Queries a Symbol (get_symbol)

```
1.  Claude Code invokes MCP tool: get_symbol({ name: "processPayment", kind: "function" })
2.  MCP Server receives JSON-RPC call over stdio
3.  MCP Server constructs Cypher:
    MATCH (fn:Function {name: 'processPayment'})
    OPTIONAL MATCH (f:File)-[:CONTAINS]->(fn)
    OPTIONAL MATCH (fn)<-[:CALLS]-(caller:Function)<-[:CONTAINS]-(cf:File)
    RETURN fn.name, fn.signature, fn.docstring, fn.start_line, fn.end_line,
           f.path AS file_path,
           collect({caller: caller.name, file: cf.path, line: caller.start_line}) AS usages
4.  MCP Server executes query via neo4j-driver
5.  MCP Server formats result as structured text
6.  MCP Server returns result to Claude Code via MCP tool response
7.  Claude Code displays the symbol definition, location, and usages in context
```

### Flow 3: Claude Code Searches Code (search_code)

```
1.  Claude Code invokes MCP tool: search_code({ query: "authentication middleware", language: "typescript" })
2.  MCP Server receives JSON-RPC call
3.  MCP Server queries Supabase:
    SELECT file_path, ts_rank(to_tsvector('english', content), plainto_tsquery('english', 'authentication middleware')) AS rank
    FROM file_contents
    WHERE to_tsvector('english', content) @@ plainto_tsquery('english', 'authentication middleware')
    AND language = 'typescript'
    ORDER BY rank DESC
    LIMIT 10
4.  MCP Server returns ranked file paths with snippets to Claude Code
```

### Flow 4: Claude Code Traces Import Chain (trace_imports)

```
1.  Claude Code invokes: trace_imports({ start_path: "src/api/auth.ts", repo: "myrepo", max_depth: 3, direction: "upstream" })
2.  MCP Server constructs Cypher:
    MATCH path = (f:File {path: 'src/api/auth.ts'})-[:IMPORTS*1..3]->(dep)
    RETURN [n IN nodes(path) | n.path] AS chain, [r IN relationships(path) | r.symbols] AS symbols
3.  MCP Server executes and returns the import chain tree to Claude Code
```

### Flow 5: Re-Digest a Repository

```
1.  User clicks "Re-Digest" button on a repo in the Web UI
2.  Web UI sends POST /api/digest { url: "<stored-url>", branch: "<stored-branch>" }
3.  Backend clones fresh copy
4.  (Phase 4: Backend diffs against stored commit_sha, only re-parses changed files)
5.  (Phase 1-3: Full re-digest — delete existing graph data for this repo, re-insert everything)
6.  Neo4j Loader: MATCH (r:Repository {url: '<url>'})-[*]->(n) DETACH DELETE n, r — then re-insert
7.  Supabase Client: DELETE FROM file_contents WHERE repo_id = '<id>' — then re-insert
8.  Same flow as Flow 1 from step 10 onward
```

### Flow 6: Delete a Repository

```
1.  User clicks "Delete" on a repo in the Web UI
2.  Web UI sends DELETE /api/repositories/:id
3.  Backend deletes from Neo4j: MATCH (r:Repository {name: '<name>'})-[*]->(n) DETACH DELETE n, r
4.  Backend deletes from Supabase: DELETE FROM file_contents WHERE repo_id = '<id>'
5.  Backend deletes from Supabase: DELETE FROM digest_jobs WHERE repo_id = '<id>'
6.  Backend deletes from Supabase: DELETE FROM repositories WHERE id = '<id>'
7.  Backend returns 200 to UI
8.  UI removes repo from list
```

### Flow 7: Digest Failure (Error Path)

```
1.  Any stage in the pipeline throws an error
2.  Backend catches the error
3.  Backend updates Supabase digest_jobs: { status: "failed", error_log: error.message, stage: "<failed-stage>" }
4.  Backend updates Supabase repositories: { status: "error" }
5.  Backend cleans up temp directory if it exists
6.  Web UI poll receives failed status, displays error message and failed stage
7.  User can retry by clicking "Re-Digest"
```

---

## Issues Found

### Dead Ends

1. **No health check endpoint.** The Web UI has no way to verify the backend is running before making requests. Add `GET /api/health` returning `{ status: "ok", neo4j: "connected", supabase: "connected" }`.

2. **MCP server has no startup validation.** If Neo4j or Supabase credentials are wrong, the MCP server will start but every tool call will fail. Add connection validation on startup — if connections fail, log a clear error to stderr (which Claude Code surfaces to the user).

### Missing Sources

3. **Neo4j indexes not defined.** The plan creates nodes with `name`, `path`, and `content_hash` properties but never creates indexes. Without indexes, Cypher queries on large graphs will be slow. Must create: indexes on `File.path`, `Function.name`, `Class.name`, `TypeDef.name`, `Package.name`, and a uniqueness constraint on `Repository.url`.

4. **Supabase full-text search index not defined.** `search_code` relies on `tsvector` full-text search but the `file_contents` table needs a generated `tsvector` column and a GIN index. Must add this in the Supabase migration.

5. **No `.gitignore`-aware filtering in Scanner.** The scanner needs to skip `node_modules/`, `.git/`, `dist/`, `build/`, binary files, and any paths in `.gitignore`. Without this, the graph will be full of noise and the digest will be slow.

### Phantom Dependencies

6. **tree-sitter grammars need compilation.** `node-tree-sitter` requires pre-compiled grammar `.wasm` files or native bindings. The npm packages `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-go` need to be installed and their grammars loaded at runtime. This is a known friction point — test early.

7. **`simple-git` or direct git CLI.** The cloner needs git installed. This is standard on dev machines but should be validated at startup. If git is not found, surface a clear error.

### One-Way Streets

8. **Job polling has no timeout.** If a job gets stuck (process crash mid-digest), the Web UI will poll forever. Need a job timeout — if a job has been "running" for more than 10 minutes, mark it as failed automatically (either via backend check or Supabase trigger).

9. **Neo4j Loader has no progress reporting.** During the "loading" stage, the UI shows "loading" but has no indication of progress (e.g., 500/5000 nodes inserted). Consider reporting batch progress back to Supabase job stats.

### Permission Gaps

10. **Supabase RLS (Row Level Security).** Hosted Supabase has RLS enabled by default on new tables. Since this is a single-user local tool, either disable RLS on all tables or use the service role key (not the anon key) for all operations. Using the anon key with RLS enabled will result in empty query results.

11. **Neo4j auth.** Neo4j Community Edition has auth enabled by default. The backend and MCP server both need `NEO4J_USER` and `NEO4J_PASSWORD` configured. Default is `neo4j/neo4j` but it forces a password change on first login.

---

## Wiring Checklist

### Infrastructure & Environment

- [ ] Confirm Neo4j is running and accessible at `bolt://localhost:7687`
- [ ] Set Neo4j password (first-login password change) and record it
- [ ] Confirm hosted Supabase project is accessible
- [ ] Obtain Supabase URL and service role key (not anon key — avoids RLS issues)
- [ ] Create `.env` file with: `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- [ ] Verify `git` CLI is installed and on PATH

### Supabase Schema & Migrations

- [ ] Create `repositories` table: id (uuid, pk), url (text, unique), name (text), branch (text), commit_sha (text), last_digest_at (timestamptz), status (text), config (jsonb)
- [ ] Create `digest_jobs` table: id (uuid, pk), repo_id (uuid, fk→repositories), status (text), stage (text), started_at (timestamptz), completed_at (timestamptz), error_log (text), stats (jsonb)
- [ ] Create `file_contents` table: id (uuid, pk), repo_id (uuid, fk→repositories), file_path (text), content (text), content_hash (text), language (text), size_bytes (int)
- [ ] Add unique constraint on `file_contents(repo_id, file_path)`
- [ ] Add generated tsvector column on `file_contents`: `content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED`
- [ ] Create GIN index on `file_contents.content_tsv`
- [ ] Disable RLS on all three tables (single-user tool) OR use service role key consistently

### Neo4j Schema & Indexes

- [ ] Create uniqueness constraint: `CREATE CONSTRAINT repo_url IF NOT EXISTS FOR (r:Repository) REQUIRE r.url IS UNIQUE`
- [ ] Create index: `CREATE INDEX file_path IF NOT EXISTS FOR (f:File) ON (f.path)`
- [ ] Create index: `CREATE INDEX function_name IF NOT EXISTS FOR (fn:Function) ON (fn.name)`
- [ ] Create index: `CREATE INDEX class_name IF NOT EXISTS FOR (c:Class) ON (c.name)`
- [ ] Create index: `CREATE INDEX typedef_name IF NOT EXISTS FOR (t:TypeDef) ON (t.name)`
- [ ] Create index: `CREATE INDEX package_name IF NOT EXISTS FOR (p:Package) ON (p.name)`
- [ ] Create composite index: `CREATE INDEX file_repo IF NOT EXISTS FOR (f:File) ON (f.repo_url, f.path)`

### Project Scaffolding

- [ ] Initialize monorepo structure:
  ```
  repograph/
  ├── packages/
  │   ├── backend/        # Express API + ingestion pipeline
  │   ├── frontend/       # React + Vite + Tailwind
  │   └── mcp-server/     # MCP server for Claude Code
  ├── package.json        # Workspace root
  ├── tsconfig.base.json  # Shared TS config
  └── docker-compose.yml  # Neo4j (+ optional local services)
  ```
- [ ] Set up TypeScript in all three packages with shared base config
- [ ] Install shared dependencies: `neo4j-driver`, `@supabase/supabase-js`
- [ ] Install backend deps: `express`, `simple-git`, `node-tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-go`, `fast-glob`, `dotenv`
- [ ] Install frontend deps: `react`, `react-dom`, `tailwindcss`, `@vitejs/plugin-react`
- [ ] Install MCP server deps: `@modelcontextprotocol/sdk`
- [ ] Create docker-compose.yml with Neo4j service (community edition)

### Backend API (Phase 1)

- [ ] Create Express app with `/api/health`, `/api/digest`, `/api/repositories`, `/api/repositories/:id`, `/api/jobs/:id` routes
- [ ] Implement Repo Cloner: `clone(url, branch) → localPath` using simple-git, shallow clone to `/tmp/repograph/<uuid>`
- [ ] Implement File Scanner: walk file tree with fast-glob, skip `.git/`, `node_modules/`, `dist/`, binaries, respect `.gitignore`
- [ ] Implement Neo4j Loader: batch upsert Repository + File nodes + CONTAINS_FILE edges using UNWIND
- [ ] Implement Supabase Client: upsert repositories, digest_jobs, file_contents
- [ ] Wire the digest pipeline: clone → scan → load (parse comes in Phase 2)
- [ ] Implement job status updates at each stage (update Supabase digest_jobs)
- [ ] Implement temp directory cleanup after digest completes (success or failure)
- [ ] Add startup validation: check Neo4j connection, check Supabase connection, check git on PATH
- [ ] Implement DELETE /api/repositories/:id — purge from Neo4j + Supabase

### Frontend (Phase 1)

- [ ] Scaffold Vite + React + Tailwind app
- [ ] Build Digest Input Zone: text input for URL, branch input (optional, defaults to main), Digest button
- [ ] Add URL validation (GitHub HTTPS/SSH pattern or local path)
- [ ] Build Repository Status Zone: table of repos with name, branch, last_digest_at, status, Re-Digest button, Delete button
- [ ] Implement job polling: poll GET /api/jobs/:id every 2s during active digest, show stage + progress
- [ ] Add expandable row detail: file count, node count, edge count, duration, error log
- [ ] Add health check on app load — show warning banner if backend is unreachable

### MCP Server (Phase 1)

- [ ] Create MCP server entry point using `@modelcontextprotocol/sdk` with stdio transport
- [ ] Implement `search_code` tool: full-text search via Supabase tsvector query
- [ ] Implement `get_file` tool: SELECT from Supabase file_contents by repo + path
- [ ] Implement `get_repo_structure` tool: Cypher query for file tree from Neo4j (File nodes under Repository)
- [ ] Add startup connection validation (Neo4j + Supabase) — log errors to stderr
- [ ] Add MCP server config example for Claude Code `.claude.json`

### Code Parser (Phase 2)

- [ ] Set up tree-sitter with TypeScript/JavaScript grammar: load WASM, initialize parser
- [ ] Set up tree-sitter with Python grammar
- [ ] Set up tree-sitter with Go grammar
- [ ] Implement function extraction: name, signature (params + return type), docstring, start_line, end_line
- [ ] Implement class extraction: name, methods (as contained Functions), docstring, start_line, end_line
- [ ] Implement type/interface extraction: name, definition text, start_line
- [ ] Implement constant/export extraction: name, value preview, start_line
- [ ] Implement import statement extraction: source path, imported symbols, default vs named
- [ ] Implement export statement extraction: exported symbol, is_default

### Import Resolver (Phase 2)

- [ ] Implement relative path resolution: `./foo` → `src/foo.ts` (try extensions: .ts, .tsx, .js, .jsx, /index.ts, /index.js)
- [ ] Implement bare specifier detection: `express` → Package node
- [ ] Implement tsconfig path alias resolution: read target repo's tsconfig.json, parse `paths` and `baseUrl`, resolve `@/foo` → `src/foo`
- [ ] Create IMPORTS edges: File → File (internal) or File → Package (external)
- [ ] Create CALLS edges where detectable (function reference matching — best effort)

### Neo4j Loader Updates (Phase 2)

- [ ] Batch upsert Function, Class, TypeDef, Constant nodes
- [ ] Batch upsert CONTAINS edges (File → Symbol, Class → Method)
- [ ] Batch upsert EXPORTS edges (File → Symbol)
- [ ] Batch upsert IMPORTS edges (File → File, File → Package)
- [ ] Batch upsert CALLS edges (Function → Function)

### MCP Server Updates (Phase 2)

- [ ] Implement `get_symbol` tool: Cypher query for symbol by name + kind, return definition + usages
- [ ] Implement `get_dependencies` tool: Cypher query for IMPORTS in/out/both for a file
- [ ] Implement `trace_imports` tool: Cypher variable-length path query `[:IMPORTS*1..N]`

### Dependency Indexer (Phase 3)

- [ ] Parse package-lock.json / yarn.lock / pnpm-lock.yaml to extract direct dependencies + versions
- [ ] For each npm package: fetch type definitions (check bundled types first, then DefinitelyTyped)
- [ ] Parse .d.ts files with tree-sitter to extract exported functions, classes, types
- [ ] Create Package nodes: { name, version, registry: "npm" }
- [ ] Create PackageExport nodes: { name, signature, kind }
- [ ] Create DEPENDS_ON edges: Repository → Package
- [ ] Create PROVIDES edges: Package → PackageExport
- [ ] Handle packages without types: create Package node without exports, log info

### MCP Server Updates (Phase 3)

- [ ] Implement `get_upstream_dep` tool: Cypher query for Package + its PackageExport nodes
- [ ] Implement `query_graph` tool: raw Cypher execution with parameterized queries (escape hatch)

### Polish & Resilience (Phase 4)

- [ ] Incremental re-digest: diff against stored commit_sha, identify changed files, only re-parse those
- [ ] Job timeout: if digest_jobs.status is "running" and started_at > 10 min ago, mark as failed
- [ ] Error recovery: if a stage fails, allow resuming from last successful stage
- [ ] Neo4j performance: add remaining indexes based on query patterns observed
- [ ] Supabase performance: analyze slow queries, add indexes as needed
- [ ] Rate limiting on digest endpoint (prevent accidental double-submits)
- [ ] README with: setup instructions, architecture diagram, MCP tool reference, troubleshooting

---

## Build Order

The build is organized to deliver working, testable increments. Each phase depends on the previous one.

### Phase 1 — Foundation (MVP)

Build in this order (dependencies first):

1. **Infrastructure setup** — .env, Neo4j indexes, Supabase tables/indexes, docker-compose
2. **Project scaffolding** — Monorepo structure, TypeScript configs, package installs
3. **Backend API** — Express routes + digest pipeline (clone → scan → load)
4. **MCP Server** — search_code, get_file, get_repo_structure
5. **Frontend** — Digest input, repo status table, job polling
6. **Integration test** — Paste a real repo URL, digest it, query it from Claude Code

### Phase 2 — Structural Graph

1. **Code Parser** — tree-sitter setup + extraction logic for all node types
2. **Import Resolver** — Path resolution + tsconfig alias handling
3. **Neo4j Loader updates** — New node types + edge types
4. **MCP Server updates** — get_symbol, get_dependencies, trace_imports
5. **Integration test** — Query symbols, trace import chains from Claude Code

### Phase 3 — Upstream Dependencies

1. **Dependency Indexer** — Lockfile parsing + .d.ts fetching/parsing
2. **Neo4j Loader updates** — Package + PackageExport nodes
3. **MCP Server updates** — get_upstream_dep, query_graph
4. **Integration test** — Query dependency APIs from Claude Code

### Phase 4 — Polish

1. **Incremental re-digest** — Diff-based parsing
2. **Error recovery + job timeout**
3. **Performance tuning** — Indexes, query optimization
4. **Documentation**
