# RepoGraph - Claude Code Instructions

## MCP-First Workflow

This project has a RepoGraph MCP server connected. **Always use the `mcp__repograph__*` tools first** before falling back to local file reads or grep searches.

- Use `get_repo_structure` to understand project layout
- Use `search_code` to find functions, classes, or patterns
- Use `get_symbol` to look up specific symbols and their relationships
- Use `trace_imports` to understand dependency chains between files
- Use `get_dependencies` to see package-level dependencies
- Use `get_file` to read file contents from the graph
- Use `query_graph` for custom Cypher queries against the code graph
- Use `get_deploy_errors`, `get_recent_logs`, `search_logs`, and `trace_error` for runtime debugging
Only fall back to local file tools (Read, Grep, Glob) when the MCP doesn't have the data you need or when editing files.

## MCP Usage Transparency

When using RepoGraph MCP tools, always:
1. **State the tool name** before calling it (e.g., "Querying RepoGraph `get_symbol`...")
2. **Never silently fall back** to local Read/Grep/Glob — if you fall back, explain why (e.g., "MCP didn't have line-level detail, reading locally")
3. **Subagents must also prefer MCP tools** — when delegating to Explore/Plan agents, explicitly instruct them to use `mcp__repograph__*` tools first
4. **Tag MCP results** — when presenting findings from the graph, prefix with "via RepoGraph:" so the user knows the data source
