import { getSession } from "../db/neo4j.js";
import { ParsedSymbol } from "./parser.js";
import { EnrichedResolvedImport } from "./resolver.js";
import { CallsEdge } from "./scip/types.js";

// ─── Types ──────────────────────────────────────────────────────

export interface GraphNodeSnapshot {
  kind: "function" | "class" | "type" | "constant";
  name: string;
  filePath: string;
  signature: string;
  docstring: string;
  startLine: number;
  endLine: number;
  resolvedSignature?: string;
}

export interface GraphEdgeSnapshot {
  edgeType: "IMPORTS" | "CALLS";
  sourceKey: string;   // identity key for the source node
  targetKey: string;   // identity key for the target node
  properties: Record<string, unknown>;
}

export interface NodeChange<T> {
  identityKey: string;
  old?: T;
  new?: T;
  changeType: "created" | "modified" | "deleted";
}

export interface EdgeChange {
  identityKey: string;
  edgeType: string;
  old?: GraphEdgeSnapshot;
  new?: GraphEdgeSnapshot;
  changeType: "created" | "modified" | "deleted";
}

export interface GraphChangeset {
  nodes: NodeChange<GraphNodeSnapshot>[];
  edges: EdgeChange[];
  stats: {
    nodesCreated: number;
    nodesModified: number;
    nodesDeleted: number;
    edgesCreated: number;
    edgesModified: number;
    edgesDeleted: number;
  };
}

// ─── Identity key helpers ───────────────────────────────────────

function symbolIdentityKey(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}

function importsEdgeKey(fromPath: string, toPath: string): string {
  return `IMPORTS::${fromPath}→${toPath}`;
}

function callsEdgeKey(callerFile: string, callerName: string, calleeFile: string, calleeName: string): string {
  return `CALLS::${callerFile}::${callerName}→${calleeFile}::${calleeName}`;
}

// ─── Fetch previous graph state from Neo4j ──────────────────────

interface PreviousGraphState {
  nodes: Map<string, GraphNodeSnapshot>;
  importsEdges: Map<string, GraphEdgeSnapshot>;
  callsEdges: Map<string, GraphEdgeSnapshot>;
}

/**
 * Query Neo4j for all current (non-superseded) nodes and edges for a repo.
 * For repos without temporal fields, returns all nodes (backward compatible).
 */
export async function fetchPreviousGraphState(repoUrl: string): Promise<PreviousGraphState> {
  const session = getSession();
  const state: PreviousGraphState = {
    nodes: new Map(),
    importsEdges: new Map(),
    callsEdges: new Map(),
  };

  try {
    // Fetch symbol nodes (Function, Class, TypeDef, Constant)
    const nodeResult = await session.run(
      `MATCH (f:File {repo_url: $repoUrl})-[:CONTAINS]->(sym)
       WHERE (sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant)
         AND (sym.valid_to IS NULL)
       RETURN
         CASE WHEN sym:Function THEN 'function'
              WHEN sym:Class THEN 'class'
              WHEN sym:TypeDef THEN 'type'
              WHEN sym:Constant THEN 'constant'
         END AS kind,
         sym.name AS name,
         sym.file_path AS filePath,
         coalesce(sym.signature, sym.definition, sym.value_preview, '') AS signature,
         coalesce(sym.docstring, '') AS docstring,
         coalesce(sym.start_line, 0) AS startLine,
         coalesce(sym.end_line, 0) AS endLine,
         sym.resolved_signature AS resolvedSignature`,
      { repoUrl }
    );

    for (const record of nodeResult.records) {
      const node: GraphNodeSnapshot = {
        kind: record.get("kind"),
        name: record.get("name"),
        filePath: record.get("filePath"),
        signature: record.get("signature"),
        docstring: record.get("docstring"),
        startLine: typeof record.get("startLine") === "object" ? record.get("startLine").toNumber() : record.get("startLine"),
        endLine: typeof record.get("endLine") === "object" ? record.get("endLine").toNumber() : record.get("endLine"),
        resolvedSignature: record.get("resolvedSignature") || undefined,
      };
      const key = symbolIdentityKey(node.filePath, node.name);
      state.nodes.set(key, node);
    }

    // Fetch IMPORTS edges (File → File)
    const importsResult = await session.run(
      `MATCH (from:File {repo_url: $repoUrl})-[r:IMPORTS]->(to:File {repo_url: $repoUrl})
       WHERE r.valid_to IS NULL
       RETURN from.path AS fromPath, to.path AS toPath,
              r.symbols AS symbols, r.resolution_status AS resolutionStatus`,
      { repoUrl }
    );

    for (const record of importsResult.records) {
      const fromPath = record.get("fromPath");
      const toPath = record.get("toPath");
      const key = importsEdgeKey(fromPath, toPath);
      state.importsEdges.set(key, {
        edgeType: "IMPORTS",
        sourceKey: fromPath,
        targetKey: toPath,
        properties: {
          symbols: record.get("symbols"),
          resolutionStatus: record.get("resolutionStatus"),
        },
      });
    }

    // Fetch CALLS edges (including SCIP-enriched properties)
    const callsResult = await session.run(
      `MATCH (caller {repo_url: $repoUrl})-[r:CALLS]->(callee {repo_url: $repoUrl})
       WHERE (caller:Function OR caller:Class) AND (callee:Function OR callee:Class)
         AND (r.valid_to IS NULL)
       RETURN caller.file_path AS callerFile, caller.name AS callerName,
              callee.file_path AS calleeFile, callee.name AS calleeName,
              r.call_site_line AS callSiteLine,
              r.arg_types AS argTypes, r.arg_expressions AS argExpressions,
              r.has_type_mismatch AS hasTypeMismatch, r.type_mismatch_detail AS typeMismatchDetail`,
      { repoUrl }
    );

    for (const record of callsResult.records) {
      const callerFile = record.get("callerFile");
      const callerName = record.get("callerName");
      const calleeFile = record.get("calleeFile");
      const calleeName = record.get("calleeName");
      const key = callsEdgeKey(callerFile, callerName, calleeFile, calleeName);
      state.callsEdges.set(key, {
        edgeType: "CALLS",
        sourceKey: `${callerFile}::${callerName}`,
        targetKey: `${calleeFile}::${calleeName}`,
        properties: {
          callSiteLine: record.get("callSiteLine"),
          argTypes: record.get("argTypes") || null,
          argExpressions: record.get("argExpressions") || null,
          hasTypeMismatch: record.get("hasTypeMismatch") || null,
          typeMismatchDetail: record.get("typeMismatchDetail") || null,
        },
      });
    }
  } finally {
    await session.close();
  }

  return state;
}

// ─── Diff logic ─────────────────────────────────────────────────

/** Compare tracked properties of a symbol to detect modifications. */
function symbolChanged(prev: GraphNodeSnapshot, curr: GraphNodeSnapshot): boolean {
  return (
    prev.signature !== curr.signature ||
    prev.docstring !== curr.docstring ||
    prev.startLine !== curr.startLine ||
    prev.endLine !== curr.endLine ||
    prev.resolvedSignature !== curr.resolvedSignature
  );
}

/**
 * Produce a GraphChangeset by comparing the current pipeline output
 * against the previous graph state from Neo4j.
 *
 * On first temporal digest (empty previous state), all nodes are "created".
 */
export async function diffGraph(
  repoUrl: string,
  currentSymbols: ParsedSymbol[],
  currentImports: EnrichedResolvedImport[],
  currentCalls: CallsEdge[]
): Promise<GraphChangeset> {
  const previous = await fetchPreviousGraphState(repoUrl);

  const nodeChanges: NodeChange<GraphNodeSnapshot>[] = [];
  const edgeChanges: EdgeChange[] = [];

  // ── Diff symbol nodes ──

  const currentNodeKeys = new Set<string>();

  for (const sym of currentSymbols) {
    const key = symbolIdentityKey(sym.filePath, sym.name);
    currentNodeKeys.add(key);

    const curr: GraphNodeSnapshot = {
      kind: sym.kind,
      name: sym.name,
      filePath: sym.filePath,
      signature: sym.signature,
      docstring: sym.docstring,
      startLine: sym.startLine,
      endLine: sym.endLine,
      resolvedSignature: sym.resolvedSignature,
    };

    const prev = previous.nodes.get(key);
    if (!prev) {
      nodeChanges.push({ identityKey: key, new: curr, changeType: "created" });
    } else if (symbolChanged(prev, curr)) {
      nodeChanges.push({ identityKey: key, old: prev, new: curr, changeType: "modified" });
    }
    // else: unchanged — no entry needed
  }

  // Deleted nodes: in previous but not in current
  for (const [key, prev] of previous.nodes) {
    if (!currentNodeKeys.has(key)) {
      nodeChanges.push({ identityKey: key, old: prev, changeType: "deleted" });
    }
  }

  // ── Diff IMPORTS edges (File → File, internal only) ──

  const currentImportsKeys = new Set<string>();

  for (const imp of currentImports) {
    if (!imp.toFile) continue; // skip external package imports
    const key = importsEdgeKey(imp.fromFile, imp.toFile);
    currentImportsKeys.add(key);

    const curr: GraphEdgeSnapshot = {
      edgeType: "IMPORTS",
      sourceKey: imp.fromFile,
      targetKey: imp.toFile,
      properties: {
        symbols: imp.symbols,
        resolutionStatus: imp.resolutionStatus,
      },
    };

    const prev = previous.importsEdges.get(key);
    if (!prev) {
      edgeChanges.push({ identityKey: key, edgeType: "IMPORTS", new: curr, changeType: "created" });
    } else {
      // Check if symbols or status changed
      const prevSymbols = JSON.stringify((prev.properties.symbols as string[]) || []);
      const currSymbols = JSON.stringify(imp.symbols || []);
      if (prevSymbols !== currSymbols || prev.properties.resolutionStatus !== imp.resolutionStatus) {
        edgeChanges.push({ identityKey: key, edgeType: "IMPORTS", old: prev, new: curr, changeType: "modified" });
      }
    }
  }

  for (const [key, prev] of previous.importsEdges) {
    if (!currentImportsKeys.has(key)) {
      edgeChanges.push({ identityKey: key, edgeType: "IMPORTS", old: prev, changeType: "deleted" });
    }
  }

  // ── Diff CALLS edges ──

  const currentCallsKeys = new Set<string>();

  for (const call of currentCalls) {
    const key = callsEdgeKey(call.callerFilePath, call.callerName, call.calleeFilePath, call.calleeName);
    currentCallsKeys.add(key);

    const curr: GraphEdgeSnapshot = {
      edgeType: "CALLS",
      sourceKey: `${call.callerFilePath}::${call.callerName}`,
      targetKey: `${call.calleeFilePath}::${call.calleeName}`,
      properties: {
        callSiteLine: call.callSiteLine,
        argTypes: call.argTypes || null,
        argExpressions: call.argExpressions || null,
        hasTypeMismatch: call.hasTypeMismatch || null,
        typeMismatchDetail: call.typeMismatchDetail || null,
      },
    };

    const prev = previous.callsEdges.get(key);
    if (!prev) {
      edgeChanges.push({ identityKey: key, edgeType: "CALLS", new: curr, changeType: "created" });
    }
    // CALLS edges: don't track call_site_line changes as "modified" —
    // the edge identity is what matters, not the line number
  }

  for (const [key, prev] of previous.callsEdges) {
    if (!currentCallsKeys.has(key)) {
      edgeChanges.push({ identityKey: key, edgeType: "CALLS", old: prev, changeType: "deleted" });
    }
  }

  // ── Build stats ──

  const stats = {
    nodesCreated: nodeChanges.filter((c) => c.changeType === "created").length,
    nodesModified: nodeChanges.filter((c) => c.changeType === "modified").length,
    nodesDeleted: nodeChanges.filter((c) => c.changeType === "deleted").length,
    edgesCreated: edgeChanges.filter((c) => c.changeType === "created").length,
    edgesModified: edgeChanges.filter((c) => c.changeType === "modified").length,
    edgesDeleted: edgeChanges.filter((c) => c.changeType === "deleted").length,
  };

  console.log(
    `[differ] Changeset: ${stats.nodesCreated} nodes created, ${stats.nodesModified} modified, ${stats.nodesDeleted} deleted | ` +
    `${stats.edgesCreated} edges created, ${stats.edgesModified} modified, ${stats.edgesDeleted} deleted`
  );

  return { nodes: nodeChanges, edges: edgeChanges, stats };
}
