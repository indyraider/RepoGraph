# RepoGraph

A local-first developer tool that ingests GitHub repositories into a Neo4j knowledge graph and exposes the graph to Claude Code via an MCP (Model Context Protocol) server.

RepoGraph gives Claude Code structural awareness of any codebase — file trees, symbol definitions, import/export chains, and upstream dependency APIs — without manual context loading.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Web Frontend  │────▶│  Backend API      │────▶│  Neo4j (Aura)   │
│  React + Vite   │     │  Express + Pipeline│    │  Knowledge Graph│
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │                         ▲
                              ▼                         │
                        ┌──────────────────┐     ┌─────────────────┐
                        │  Supabase        │     │  MCP Server     │
                        │  File Content +  │────▶│  Claude Code    │
                        │  Job State       │     │  Tools (stdio)  │
                        └──────────────────┘     └─────────────────┘
```

### Packages

| Package | Description |
|---------|-------------|
| `packages/backend` | Express API + 6-stage digest pipeline (clone, scan, parse, resolve, deps, load) |
| `packages/mcp-server` | MCP server exposing 8 tools to Claude Code via stdio transport |
| `packages/frontend` | React + Vite + Tailwind dashboard for triggering digests and viewing status |

### Graph Schema (Neo4j)

**Nodes:** Repository, File, Function, Class, TypeDef, Constant, Package, PackageExport

**Edges:** CONTAINS_FILE, CONTAINS, IMPORTS, EXPORTS, DEPENDS_ON, PROVIDES

## Prerequisites

- **Node.js** v20+ (tested on v22)
- **Git** CLI on PATH
- **Neo4j Aura** account (free tier works) — or any Neo4j 5.x instance
- **Supabase** project (free tier works)

## Setup

### 1. Clone and install

```bash
git clone <this-repo>
cd RepoGraph
npm install
```

### 2. Configure environment

Copy and edit the `.env` file in the project root:

```env
NEO4J_URI=neo4j+s://your-instance.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
NEO4J_DATABASE=neo4j

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
```

> Use the Supabase **service role key** (not the anon key) to avoid RLS issues.

### 3. Run Supabase migration

Open your Supabase dashboard > SQL Editor and run the contents of `supabase-migration.sql`. This creates:

- `repositories` table
- `digest_jobs` table
- `file_contents` table with full-text search (tsvector + GIN index)
- `search_files` RPC function

### 4. Start the backend

```bash
npm run dev:backend
```

The backend will:
- Connect to Neo4j and create indexes automatically
- Connect to Supabase and verify access
- Start the Express API on `http://localhost:3001`
- Run a job timeout checker every 60s (marks stuck jobs as failed after 10 min)

### 5. Start the frontend

```bash
npm run dev:frontend
```

Opens the dashboard at `http://localhost:5173`. Enter a GitHub repo URL and click Digest.

### 6. Configure MCP server for Claude Code

Add to your Claude Code MCP config (`.claude.json` or Claude Code settings):

```json
{
  "mcpServers": {
    "repograph": {
      "command": "node",
      "args": ["<path-to-repo>/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Build the MCP server first:

```bash
npm run build
```

## MCP Tools Reference

| Tool | Description |
|------|-------------|
| `search_code` | Full-text search across all indexed file contents |
| `get_file` | Retrieve full content of a file by path |
| `get_repo_structure` | File tree of a repository, filterable by directory and depth |
| `get_symbol` | Look up a function, class, or type by name — returns definition, location, and usages |
| `get_dependencies` | For a file, show what it imports and what imports it |
| `trace_imports` | Multi-hop import chain traversal up to N hops |
| `get_upstream_dep` | Look up the public API of an npm/pip/go dependency |
| `query_graph` | Raw Cypher query escape hatch (read-only) |

## Digest Pipeline

The 6-stage pipeline runs when you submit a repo URL:

1. **Clone** — Shallow clone via `simple-git` to temp directory
2. **Scan** — Walk file tree with `fast-glob`, skip `node_modules`/`.git`/`dist`, read content + compute SHA-256 hashes
3. **Parse** — Extract symbols (functions, classes, types, constants), imports, and exports using `tree-sitter` (supports TypeScript/JavaScript, Python, Go)
4. **Resolve** — Resolve import paths: relative paths (try `.ts`/`.tsx`/`.js`/`.jsx`, index files), tsconfig path aliases, bare specifiers to packages
5. **Deps** — Parse lockfiles (`package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`), fetch `.d.ts` type definitions for npm packages
6. **Load** — Batch upsert nodes/edges to Neo4j, file contents to Supabase

### Incremental Re-digest

When re-digesting a previously indexed repo:
- If the commit SHA hasn't changed, the digest completes instantly (no work needed)
- If the commit changed, files are compared by content hash — only changed files are re-uploaded to Supabase
- Deleted files are purged from both Neo4j and Supabase

## Supported Languages

| Language | Parsing | Import Resolution |
|----------|---------|-------------------|
| TypeScript/JavaScript | Full AST (tree-sitter) | Relative, tsconfig aliases, bare specifiers |
| Python | Full AST (tree-sitter) | Best-effort |
| Go | Full AST (tree-sitter) | Best-effort |
| Others (JSON, YAML, CSS, etc.) | File-level only | N/A |

## Troubleshooting

**Neo4j connection fails**
- Verify `NEO4J_URI` uses `neo4j+s://` for Aura (not `bolt://`)
- Check credentials in `.env`

**Supabase queries return empty results**
- Make sure you're using the **service role key**, not the anon key
- Verify RLS is disabled on all tables (the migration does this)

**`search_code` returns no results**
- Ensure you ran the `search_files` function from the migration SQL
- The tsvector index only works after files are loaded

**tree-sitter errors on startup**
- Run `npm rebuild` to recompile native bindings for your platform

**Job stuck as "running"**
- The backend auto-marks jobs as failed after 10 minutes
- You can also delete the repository and re-digest
