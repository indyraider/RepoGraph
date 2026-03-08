# Phase 5 Forward Plan Review
**Phase completed:** 5 — MCP Tools
**Date:** 2026-03-07
**Plan updates needed:** NO

## Actual Interfaces Built

### Exports from `codeql-tools.ts`

```typescript
export function registerCodeQLTools(
  server: McpServer,
  getSession: GetSessionFn,
  getSupabase: GetSupabaseFn,
  scopedRepo: string | null = null
): void
```

### MCP Tools Registered

**trace_data_flow** — params: `file`, `line?`, `direction?`, `repo?`, `query_id?`, `sink_kind?`, `max_results?`
**get_data_flow_findings** — params: `repo?`, `severity?`, `query_id?`, `file?`, `max_results?`

## Mismatches with Plan

None — implementation matches Contract 8 and Contract 9 (with the `getUserSupabase` correction identified in Phase 4 forward plan).

## Hook Points for Phase 6

### Existing Tool Enrichment

**1. `get_symbol` enrichment** — `index.ts:~520-548` (the fuzzy/exact query section)
- Add an OPTIONAL MATCH for FLOWS_TO edges on the matched symbol
- Append `data_flow_findings_count` to the output formatting at `index.ts:~560-598`

**2. `trace_error` enrichment** — in `runtime-tools.ts`
- When a traced error resolves to a function, add an optional FLOWS_TO check to provide data flow context
- This is additive — won't break existing behavior

## Recommended Plan Updates

None needed. Phase 6 can proceed as planned.
