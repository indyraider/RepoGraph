# Brainstorm: RepoGraph

**Created:** 2026-03-05
**Status:** Draft

## Vision

RepoGraph is a local-first developer tool that ingests GitHub repositories into a Neo4j knowledge graph and exposes that graph to Claude Code via MCP (Model Context Protocol). The goal is to give Claude Code full structural awareness of any codebase — file trees, symbol definitions, import chains, and upstream dependency APIs — so it can debug, refactor, and build features with deep contextual understanding, without the developer manually pasting files into context.

## Existing Context

- **Infrastructure ready:** Neo4j instance (Docker) and hosted Supabase project are both provisioned.
- **No existing codebase** — this is a greenfield build.
- **PRD exists:** Detailed product requirements document at `RepoGraph_PRD.md` covering all four phases.
- **Target stack:** TypeScript throughout — React/Vite frontend, Node.js/Express backend, MCP server via `@modelcontextprotocol/sdk`, Neo4j for graph storage, hosted Supabase for metadata/file storage.

## Components Identified

### 1. Web UI (React + Vite + Tailwind)

- **Responsibility**: Single-page interface for pasting repo URLs, triggering digests, viewing repo status, and monitoring progress.
- **Upstream (receives from)**: User input (repo URL, branch); Backend API (repo list, job status, digest stats).
- **Downstream (sends to)**: Backend API (digest requests, delete requests).
- **External dependencies**: None beyond standard npm packages (React, Vite, Tailwind).
- **Hands test**: PASS — It only needs to make HTTP calls to the backend, which it can do.

### 2. Backend API Server (Node.js + Express + TypeScript)

- **Responsibility**: Orchestrate the entire ingestion pipeline. Handle HTTP requests from the UI. Manage job state. Coordinate between clone, scan, parse, resolve, and load stages.
- **Upstream (receives from)**: Web UI (HTTP requests); Cloned repo files (filesystem); tree-sitter (parsed ASTs).
- **Downstream (sends to)**: Neo4j (graph nodes/edges); Supabase (job metadata, file contents, repo registry); Filesystem (cloned repos in temp dirs).
- **External dependencies**: `neo4j-driver`, `@supabase/supabase-js`, `node-tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-go`, `simple-git` (or child_process for git clone).
- **Hands test**: PASS — Has access to git CLI, filesystem, Neo4j driver, and Supabase client. Can execute the full pipeline.

### 3. Repo Cloner

- **Responsibility**: Shallow-clone a GitHub repo (HTTPS, SSH, or local path) to a temporary directory.
- **Upstream (receives from)**: Backend API (repo URL, branch).
- **Downstream (sends to)**: Backend API / Scanner (path to cloned directory on disk).
- **External dependencies**: `git` CLI must be installed on the host machine.
- **Hands test**: PASS — Uses git CLI via child_process or `simple-git`. Needs git installed (standard on dev machines).

### 4. File Scanner

- **Responsibility**: Walk the cloned repo's file tree. Catalog every file by path, language (from extension), and size. Feed file list to parser and content to storage.
- **Upstream (receives from)**: Repo Cloner (path to cloned directory).
- **Downstream (sends to)**: Code Parser (file paths + content for AST parsing); Supabase (raw file content for storage); Neo4j (File nodes).
- **External dependencies**: Node.js `fs` module, glob/walk utilities.
- **Hands test**: PASS — Standard filesystem operations.

### 5. Code Parser (tree-sitter)

- **Responsibility**: Run tree-sitter on each supported file. Extract functions, classes, type definitions, constants, imports, and exports as structured data.
- **Upstream (receives from)**: File Scanner (file path, content, language).
- **Downstream (sends to)**: Import Resolver (raw import statements); Neo4j Loader (Function, Class, TypeDef, Constant nodes + CONTAINS, EXPORTS edges).
- **External dependencies**: `node-tree-sitter`, language grammars (`tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-go`). Grammars must be compiled as `.wasm` or native bindings.
- **Hands test**: PASS — tree-sitter Node bindings are mature. Language grammars are available as npm packages.

### 6. Import Resolver

- **Responsibility**: Map import statements to their targets — either an internal file (relative/absolute path) or an external package. Create IMPORTS edges. In later phases, resolve CALLS edges by matching function references to definitions.
- **Upstream (receives from)**: Code Parser (import statements with source paths and imported symbols); File Scanner (file index for path resolution).
- **Downstream (sends to)**: Neo4j Loader (IMPORTS, CALLS edges).
- **External dependencies**: Module resolution logic (Node.js resolution algorithm for TS/JS — handle index files, extensions, path aliases from tsconfig).
- **Hands test**: FAIL — **tsconfig path aliases** (e.g., `@/components/Button`) require reading and parsing the target repo's `tsconfig.json` to resolve correctly. If the resolver only handles relative paths, aliased imports will become dead ends. Must explicitly handle: relative paths, bare specifiers (npm packages), and tsconfig `paths`/`baseUrl` aliases.

### 7. Dependency Indexer

- **Responsibility**: Parse lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, poetry.lock, go.sum) to identify direct dependencies. Fetch or extract public API signatures from dependency sources.
- **Upstream (receives from)**: File Scanner (lockfile content); Cloned repo or npm registry (dependency source code).
- **Downstream (sends to)**: Neo4j Loader (Package, PackageExport nodes; DEPENDS_ON, PROVIDES edges).
- **External dependencies**: npm registry API (to fetch package metadata/types); possibly unpkg or the local `node_modules` directory (if present in the clone) for extracting type definitions.
- **Hands test**: FAIL — **How exactly do we get the public API of a dependency?** Options: (a) parse `.d.ts` files from DefinitelyTyped / bundled types, (b) fetch from npm registry and parse the package source, (c) read from `node_modules` if the clone includes them (usually won't for shallow clones). This needs a concrete strategy. For Python packages, same question — parse stubs or source? This is the most underspecified component.

### 8. Neo4j Loader

- **Responsibility**: Batch-insert all nodes and edges into Neo4j. Handle upserts for re-digests. Manage indexes.
- **Upstream (receives from)**: All pipeline stages (nodes and edges to insert).
- **Downstream (sends to)**: Neo4j database.
- **External dependencies**: `neo4j-driver`, Neo4j instance (bolt://localhost:7687 or remote).
- **Hands test**: PASS — neo4j-driver handles batch operations via `UNWIND` + parameterized queries.

### 9. Supabase Client Layer

- **Responsibility**: Store and retrieve job metadata (digest_jobs), repository registry (repositories), and raw file contents (file_contents). Provide job status for UI polling.
- **Upstream (receives from)**: Backend API (job updates, repo metadata); File Scanner (raw file content).
- **Downstream (sends to)**: Web UI (via Backend API — job status, repo list); MCP Server (file content for get_file tool).
- **External dependencies**: `@supabase/supabase-js`, hosted Supabase instance (URL + anon key).
- **Hands test**: PASS — Standard Supabase client operations. Tables need to be created via migrations.

### 10. MCP Server (@modelcontextprotocol/sdk)

- **Responsibility**: Expose the knowledge graph to Claude Code via MCP tools. Run Cypher queries against Neo4j and Supabase queries for file content. Serve 8 tools: search_code, get_file, get_symbol, get_dependencies, get_upstream_dep, get_repo_structure, trace_imports, query_graph.
- **Upstream (receives from)**: Claude Code (MCP tool calls via stdio/SSE).
- **Downstream (sends to)**: Neo4j (Cypher queries); Supabase (file content retrieval, full-text search).
- **External dependencies**: `@modelcontextprotocol/sdk`, `neo4j-driver`, `@supabase/supabase-js`. Environment variables: `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `SUPABASE_URL`, `SUPABASE_KEY`.
- **Hands test**: PASS — MCP SDK handles protocol. Neo4j driver handles queries. But **search_code** needs a full-text search index — either Neo4j full-text index or Supabase `tsvector` index on file_contents. Must be explicitly set up.

## Rough Dependency Map

```
User
  |
  v
[Web UI] --HTTP--> [Backend API Server]
                        |
              +---------+---------+----------+
              |         |         |          |
              v         v         v          v
         [Cloner]  [Scanner]  [Parser]  [Dep Indexer]
              |         |         |          |
              v         v         v          v
         (filesystem)   +----+----+----------+
                             |
                             v
                      [Import Resolver]
                             |
                             v
                      [Neo4j Loader] --> [Neo4j DB]
                             |
                      [Supabase Client] --> [Supabase DB]

[MCP Server] --Cypher--> [Neo4j DB]
[MCP Server] --SQL/API--> [Supabase DB]
[Claude Code] --stdio--> [MCP Server]
```

## Open Questions

1. **Dependency API extraction strategy**: How do we get the public API of npm/pip/go packages? Parsing `.d.ts` files is the most reliable for TS/JS. For Python, parsing stub files or `__init__.py` exports. For Go, parsing exported symbols. This needs a concrete decision per language.

2. **MCP server deployment model**: Does the MCP server run as a separate process from the backend API, or embedded within it? The PRD implies a separate process (Claude Code launches it via `command: "node"`). This means the MCP server needs its own entry point and direct database connections — it does NOT go through the backend API.

3. **Full-text search for search_code**: Where does this live? Options: (a) Neo4j full-text index on File node content property, (b) Supabase `tsvector` full-text search on `file_contents` table, (c) both. Supabase Postgres full-text search is simpler to set up and more powerful (stemming, ranking).

4. **File content storage**: The PRD says both Supabase Storage and text columns are options. For the MCP server's `get_file` tool, storing content as text in the `file_contents` table is simpler and allows SQL-based full-text search. Large binary files can be excluded.

5. **Temp directory cleanup**: Cloned repos need to be cleaned up after digestion. Need an explicit cleanup step or use OS temp dirs with TTL.

6. **Monorepo support**: Does a monorepo count as one Repository node, or should each package/workspace be a separate Module? Affects the graph structure significantly.

## Risks and Concerns

1. **Import resolver complexity**: TypeScript module resolution is notoriously complex — path aliases, barrel files (index.ts re-exports), conditional exports, `package.json` exports field. Getting this wrong means broken import chains, which undermines the core value proposition.

2. **Dependency API extraction is the hardest component**: No clean, universal way to get a package's public API. This is correctly scoped to Phase 3, but needs a solid strategy before building.

3. **Neo4j connection management**: Both the backend API and the MCP server need connections to Neo4j. Since they're separate processes, both need their own driver instances and connection pooling.

4. **Large repo performance**: Parsing a 50K-file repo with tree-sitter will take time. Need streaming/batching during the load stage, not building everything in memory first.

5. **Supabase row limits**: Hosted Supabase free tier has limits. Storing raw content for all files in a large repo could hit storage limits. Need to filter out binaries, vendor dirs, and set a max file size.

6. **MCP server needs to start fast**: Claude Code launches the MCP server as a subprocess. If it takes too long to initialize (connecting to Neo4j, Supabase), Claude Code may time out. Need to handle connection setup efficiently, potentially with lazy connections.
