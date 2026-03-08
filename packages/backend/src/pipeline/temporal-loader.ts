import { getSession } from "../db/neo4j.js";
import {
  GraphChangeset,
  NodeChange,
  EdgeChange,
  GraphNodeSnapshot,
  GraphEdgeSnapshot,
} from "./differ.js";
import { CommitMeta } from "./commit-ingester.js";

// ─── Types ──────────────────────────────────────────────────────

export interface TemporalLoadResult {
  nodesCreated: number;
  nodesModified: number;
  nodesDeleted: number;
  edgesCreated: number;
  edgesModified: number;
  edgesDeleted: number;
  introducedInEdges: number;
  preTemporalStamped: number;
}

interface TemporalContext {
  repoUrl: string;
  commitSha: string;
  commitTs: string; // ISO 8601 timestamp
  author: string;
  message: string;
}

const BATCH_SIZE = 500;

// ─── Label mapping ──────────────────────────────────────────────

const KIND_TO_LABEL: Record<GraphNodeSnapshot["kind"], string> = {
  function: "Function",
  class: "Class",
  type: "TypeDef",
  constant: "Constant",
};

// ─── Main entry point ───────────────────────────────────────────

/**
 * Apply a GraphChangeset to Neo4j using temporal versioning.
 *
 * - Created nodes: INSERT with valid_from, valid_to=null
 * - Modified nodes: close out old version (SET valid_to), INSERT new version
 * - Deleted nodes: close out (SET valid_to, change_type="deleted")
 * - Same pattern for edges (IMPORTS, CALLS)
 * - INTRODUCED_IN edges link every changed node to the Commit node
 */
export async function temporalLoad(
  repoUrl: string,
  changeset: GraphChangeset,
  commit: CommitMeta
): Promise<TemporalLoadResult> {
  const ctx: TemporalContext = {
    repoUrl,
    commitSha: commit.sha,
    commitTs: commit.timestamp.toISOString(),
    author: commit.author,
    message: commit.message,
  };

  const result: TemporalLoadResult = {
    nodesCreated: 0,
    nodesModified: 0,
    nodesDeleted: 0,
    edgesCreated: 0,
    edgesModified: 0,
    edgesDeleted: 0,
    introducedInEdges: 0,
    preTemporalStamped: 0,
  };

  const session = getSession();

  try {
    // ── Process nodes by change type ──
    const createdNodes = changeset.nodes.filter((n) => n.changeType === "created");
    const modifiedNodes = changeset.nodes.filter((n) => n.changeType === "modified");
    const deletedNodes = changeset.nodes.filter((n) => n.changeType === "deleted");

    result.nodesCreated = await createNodes(session, ctx, createdNodes);
    result.nodesModified = await modifyNodes(session, ctx, modifiedNodes);
    result.nodesDeleted = await closeOutNodes(session, ctx, deletedNodes);

    // ── Process edges by change type ──
    const createdEdges = changeset.edges.filter((e) => e.changeType === "created");
    const modifiedEdges = changeset.edges.filter((e) => e.changeType === "modified");
    const deletedEdges = changeset.edges.filter((e) => e.changeType === "deleted");

    result.edgesCreated = await createEdges(session, ctx, createdEdges);
    result.edgesModified = await modifyEdges(session, ctx, modifiedEdges);
    result.edgesDeleted = await closeOutEdges(session, ctx, deletedEdges);

    // ── Create INTRODUCED_IN edges for all changes ──
    result.introducedInEdges = await createIntroducedInEdges(
      session, ctx, changeset
    );

    // ── Stamp pre-temporal nodes/edges with temporal fields ──
    result.preTemporalStamped = await stampPreTemporalEntities(session, ctx);
  } finally {
    await session.close();
  }

  console.log(
    `[temporal-loader] Loaded: ${result.nodesCreated} created, ${result.nodesModified} modified, ` +
    `${result.nodesDeleted} deleted nodes | ${result.edgesCreated} created, ${result.edgesModified} modified, ` +
    `${result.edgesDeleted} deleted edges | ${result.introducedInEdges} INTRODUCED_IN edges` +
    (result.preTemporalStamped > 0 ? ` | ${result.preTemporalStamped} pre-temporal entities stamped` : "")
  );

  return result;
}

// ─── Node operations ────────────────────────────────────────────

/** INSERT new nodes with temporal fields. */
async function createNodes(
  session: ReturnType<typeof getSession>,
  ctx: TemporalContext,
  nodes: NodeChange<GraphNodeSnapshot>[]
): Promise<number> {
  if (nodes.length === 0) return 0;
  let count = 0;

  // Group by kind so we can use the correct label
  const byKind = groupByKind(nodes.map((n) => n.new!));

  for (const [kind, snapshots] of byKind) {
    const label = KIND_TO_LABEL[kind];
    for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
      const batch = snapshots.slice(i, i + BATCH_SIZE).map((s) => ({
        name: s.name,
        file_path: s.filePath,
        repo_url: ctx.repoUrl,
        signature: s.signature,
        docstring: s.docstring,
        start_line: s.startLine,
        end_line: s.endLine,
        resolved_signature: s.resolvedSignature || null,
        valid_from: ctx.commitSha,
        valid_from_ts: ctx.commitTs,
        change_type: "created",
        changed_by: ctx.author,
        commit_message: ctx.message,
      }));

      await session.run(
        `UNWIND $batch AS s
         MATCH (f:File {path: s.file_path, repo_url: s.repo_url})
         CREATE (n:${label} {
           name: s.name, file_path: s.file_path, repo_url: s.repo_url,
           signature: s.signature, docstring: s.docstring,
           start_line: s.start_line, end_line: s.end_line,
           resolved_signature: s.resolved_signature,
           valid_from: s.valid_from, valid_from_ts: datetime(s.valid_from_ts),
           change_type: s.change_type, changed_by: s.changed_by,
           commit_message: s.commit_message
         })
         MERGE (f)-[:CONTAINS]->(n)`,
        { batch }
      );
      count += batch.length;
    }
  }

  return count;
}

/** Close out old version, insert new version for modified nodes. */
async function modifyNodes(
  session: ReturnType<typeof getSession>,
  ctx: TemporalContext,
  nodes: NodeChange<GraphNodeSnapshot>[]
): Promise<number> {
  if (nodes.length === 0) return 0;
  let count = 0;

  for (const node of nodes) {
    const oldSnap = node.old!;
    const newSnap = node.new!;
    const label = KIND_TO_LABEL[oldSnap.kind];

    // Close out the old version
    await session.run(
      `MATCH (n:${label} {name: $name, file_path: $filePath, repo_url: $repoUrl})
       WHERE n.valid_to IS NULL
       SET n.valid_to = $sha, n.valid_to_ts = datetime($ts)`,
      {
        name: oldSnap.name,
        filePath: oldSnap.filePath,
        repoUrl: ctx.repoUrl,
        sha: ctx.commitSha,
        ts: ctx.commitTs,
      }
    );

    // Create the new version
    await session.run(
      `MATCH (f:File {path: $filePath, repo_url: $repoUrl})
       CREATE (n:${label} {
         name: $name, file_path: $filePath, repo_url: $repoUrl,
         signature: $signature, docstring: $docstring,
         start_line: $startLine, end_line: $endLine,
         resolved_signature: $resolvedSignature,
         valid_from: $sha, valid_from_ts: datetime($ts),
         change_type: 'modified', changed_by: $author,
         commit_message: $message
       })
       MERGE (f)-[:CONTAINS]->(n)`,
      {
        name: newSnap.name,
        filePath: newSnap.filePath,
        repoUrl: ctx.repoUrl,
        signature: newSnap.signature,
        docstring: newSnap.docstring,
        startLine: newSnap.startLine,
        endLine: newSnap.endLine,
        resolvedSignature: newSnap.resolvedSignature || null,
        sha: ctx.commitSha,
        ts: ctx.commitTs,
        author: ctx.author,
        message: ctx.message,
      }
    );

    count++;
  }

  return count;
}

/** Close out deleted nodes (set valid_to, mark as deleted). */
async function closeOutNodes(
  session: ReturnType<typeof getSession>,
  ctx: TemporalContext,
  nodes: NodeChange<GraphNodeSnapshot>[]
): Promise<number> {
  if (nodes.length === 0) return 0;
  let count = 0;

  // Batch by kind for efficient label-specific queries
  const byKind = groupByKind(nodes.map((n) => n.old!));

  for (const [kind, snapshots] of byKind) {
    const label = KIND_TO_LABEL[kind];
    for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
      const batch = snapshots.slice(i, i + BATCH_SIZE).map((s) => ({
        name: s.name,
        file_path: s.filePath,
      }));

      await session.run(
        `UNWIND $batch AS s
         MATCH (n:${label} {name: s.name, file_path: s.file_path, repo_url: $repoUrl})
         WHERE n.valid_to IS NULL
         SET n.valid_to = $sha, n.valid_to_ts = datetime($ts),
             n.change_type = 'deleted'`,
        { batch, repoUrl: ctx.repoUrl, sha: ctx.commitSha, ts: ctx.commitTs }
      );
      count += batch.length;
    }
  }

  return count;
}

// ─── Edge operations ────────────────────────────────────────────

/** Create new edges with temporal fields. */
async function createEdges(
  session: ReturnType<typeof getSession>,
  ctx: TemporalContext,
  edges: EdgeChange[]
): Promise<number> {
  if (edges.length === 0) return 0;
  let count = 0;

  const importsEdges = edges.filter((e) => e.edgeType === "IMPORTS");
  const callsEdges = edges.filter((e) => e.edgeType === "CALLS");

  // IMPORTS edges (File → File)
  for (let i = 0; i < importsEdges.length; i += BATCH_SIZE) {
    const batch = importsEdges.slice(i, i + BATCH_SIZE).map((e) => {
      const snap = e.new!;
      return {
        from_path: snap.sourceKey,
        to_path: snap.targetKey,
        symbols: snap.properties.symbols || [],
        resolution_status: snap.properties.resolutionStatus || "resolved",
      };
    });

    await session.run(
      `UNWIND $batch AS e
       MATCH (from:File {path: e.from_path, repo_url: $repoUrl})
       MATCH (to:File {path: e.to_path, repo_url: $repoUrl})
       CREATE (from)-[r:IMPORTS {
         symbols: e.symbols, resolution_status: e.resolution_status,
         valid_from: $sha, valid_from_ts: datetime($ts),
         change_type: 'created'
       }]->(to)`,
      { batch, repoUrl: ctx.repoUrl, sha: ctx.commitSha, ts: ctx.commitTs }
    );
    count += batch.length;
  }

  // CALLS edges (Symbol → Symbol)
  for (let i = 0; i < callsEdges.length; i += BATCH_SIZE) {
    const batch = callsEdges.slice(i, i + BATCH_SIZE).map((e) => {
      const snap = e.new!;
      const [callerFile, callerName] = snap.sourceKey.split("::");
      const [calleeFile, calleeName] = snap.targetKey.split("::");
      return {
        caller_file: callerFile,
        caller_name: callerName,
        callee_file: calleeFile,
        callee_name: calleeName,
        call_site_line: snap.properties.callSiteLine || null,
        arg_types: snap.properties.argTypes || null,
        arg_expressions: snap.properties.argExpressions || null,
        has_type_mismatch: snap.properties.hasTypeMismatch || null,
        type_mismatch_detail: snap.properties.typeMismatchDetail || null,
      };
    });

    await session.run(
      `UNWIND $batch AS c
       MATCH (caller {name: c.caller_name, file_path: c.caller_file, repo_url: $repoUrl})
       WHERE (caller:Function OR caller:Class)
         AND (caller.valid_to IS NULL)
       MATCH (callee {name: c.callee_name, file_path: c.callee_file, repo_url: $repoUrl})
       WHERE (callee:Function OR callee:Class)
         AND (callee.valid_to IS NULL)
       CREATE (caller)-[r:CALLS {
         call_site_line: c.call_site_line,
         arg_types: c.arg_types,
         arg_expressions: c.arg_expressions,
         has_type_mismatch: c.has_type_mismatch,
         type_mismatch_detail: c.type_mismatch_detail,
         valid_from: $sha, valid_from_ts: datetime($ts),
         change_type: 'created'
       }]->(callee)`,
      { batch, repoUrl: ctx.repoUrl, sha: ctx.commitSha, ts: ctx.commitTs }
    );
    count += batch.length;
  }

  return count;
}

/** Close out old edges and create new versions for modified edges. */
async function modifyEdges(
  session: ReturnType<typeof getSession>,
  ctx: TemporalContext,
  edges: EdgeChange[]
): Promise<number> {
  if (edges.length === 0) return 0;
  let count = 0;

  for (const edge of edges) {
    const oldSnap = edge.old!;
    const newSnap = edge.new!;

    if (edge.edgeType === "IMPORTS") {
      // Close out old IMPORTS edge
      await session.run(
        `MATCH (from:File {path: $fromPath, repo_url: $repoUrl})-[r:IMPORTS]->(to:File {path: $toPath, repo_url: $repoUrl})
         WHERE r.valid_to IS NULL
         SET r.valid_to = $sha, r.valid_to_ts = datetime($ts)`,
        {
          fromPath: oldSnap.sourceKey,
          toPath: oldSnap.targetKey,
          repoUrl: ctx.repoUrl,
          sha: ctx.commitSha,
          ts: ctx.commitTs,
        }
      );

      // Create new version
      await session.run(
        `MATCH (from:File {path: $fromPath, repo_url: $repoUrl})
         MATCH (to:File {path: $toPath, repo_url: $repoUrl})
         CREATE (from)-[r:IMPORTS {
           symbols: $symbols, resolution_status: $resolutionStatus,
           valid_from: $sha, valid_from_ts: datetime($ts),
           change_type: 'modified'
         }]->(to)`,
        {
          fromPath: newSnap.sourceKey,
          toPath: newSnap.targetKey,
          repoUrl: ctx.repoUrl,
          symbols: newSnap.properties.symbols || [],
          resolutionStatus: newSnap.properties.resolutionStatus || "resolved",
          sha: ctx.commitSha,
          ts: ctx.commitTs,
        }
      );
      count++;
    }
    // CALLS edges don't track modifications (identity-only diff in differ.ts)
  }

  return count;
}

/** Close out deleted edges. */
async function closeOutEdges(
  session: ReturnType<typeof getSession>,
  ctx: TemporalContext,
  edges: EdgeChange[]
): Promise<number> {
  if (edges.length === 0) return 0;
  let count = 0;

  for (const edge of edges) {
    if (edge.edgeType === "IMPORTS") {
      const snap = edge.old!;
      await session.run(
        `MATCH (from:File {path: $fromPath, repo_url: $repoUrl})-[r:IMPORTS]->(to:File {path: $toPath, repo_url: $repoUrl})
         WHERE r.valid_to IS NULL
         SET r.valid_to = $sha, r.valid_to_ts = datetime($ts), r.change_type = 'deleted'`,
        {
          fromPath: snap.sourceKey,
          toPath: snap.targetKey,
          repoUrl: ctx.repoUrl,
          sha: ctx.commitSha,
          ts: ctx.commitTs,
        }
      );
      count++;
    } else if (edge.edgeType === "CALLS") {
      const snap = edge.old!;
      const [callerFile, callerName] = snap.sourceKey.split("::");
      const [calleeFile, calleeName] = snap.targetKey.split("::");
      await session.run(
        `MATCH (caller {name: $callerName, file_path: $callerFile, repo_url: $repoUrl})-[r:CALLS]->(callee {name: $calleeName, file_path: $calleeFile, repo_url: $repoUrl})
         WHERE (caller:Function OR caller:Class) AND (callee:Function OR callee:Class)
           AND (caller.valid_to IS NULL) AND (callee.valid_to IS NULL)
           AND (r.valid_to IS NULL)
         SET r.valid_to = $sha, r.valid_to_ts = datetime($ts), r.change_type = 'deleted'`,
        {
          callerName, callerFile, calleeName, calleeFile,
          repoUrl: ctx.repoUrl,
          sha: ctx.commitSha,
          ts: ctx.commitTs,
        }
      );
      count++;
    }
  }

  return count;
}

// ─── INTRODUCED_IN edges ────────────────────────────────────────

/**
 * Create INTRODUCED_IN edges linking changed nodes to the Commit node.
 * Only created/modified nodes get INTRODUCED_IN edges (not deleted —
 * deleted nodes are the old versions being closed out, not new introductions).
 */
async function createIntroducedInEdges(
  session: ReturnType<typeof getSession>,
  ctx: TemporalContext,
  changeset: GraphChangeset
): Promise<number> {
  let count = 0;

  // Collect all nodes that have a new version (created or modified)
  const nodesWithNewVersion = changeset.nodes.filter(
    (n) => n.changeType === "created" || n.changeType === "modified"
  );

  for (let i = 0; i < nodesWithNewVersion.length; i += BATCH_SIZE) {
    const batch = nodesWithNewVersion.slice(i, i + BATCH_SIZE).map((n) => {
      const snap = n.new!;
      return {
        name: snap.name,
        file_path: snap.filePath,
        change_type: n.changeType,
        label: KIND_TO_LABEL[snap.kind],
      };
    });

    // Use individual queries per label since Cypher doesn't support dynamic labels
    const byLabel = new Map<string, typeof batch>();
    for (const item of batch) {
      const existing = byLabel.get(item.label) || [];
      existing.push(item);
      byLabel.set(item.label, existing);
    }

    for (const [label, items] of byLabel) {
      const labelBatch = items.map((item) => ({
        name: item.name,
        file_path: item.file_path,
        change_type: item.change_type,
      }));

      await session.run(
        `UNWIND $batch AS s
         MATCH (n:${label} {name: s.name, file_path: s.file_path, repo_url: $repoUrl})
         WHERE n.valid_from = $sha
         MATCH (c:Commit {sha: $sha, repo_url: $repoUrl})
         CREATE (n)-[:INTRODUCED_IN {change_type: s.change_type}]->(c)`,
        { batch: labelBatch, repoUrl: ctx.repoUrl, sha: ctx.commitSha }
      );
      count += labelBatch.length;
    }
  }

  // Also create INTRODUCED_IN for deleted nodes (linking old closed-out version to commit)
  const deletedNodes = changeset.nodes.filter((n) => n.changeType === "deleted");
  if (deletedNodes.length > 0) {
    const byLabel = new Map<string, { name: string; file_path: string }[]>();
    for (const node of deletedNodes) {
      const snap = node.old!;
      const label = KIND_TO_LABEL[snap.kind];
      const existing = byLabel.get(label) || [];
      existing.push({ name: snap.name, file_path: snap.filePath });
      byLabel.set(label, existing);
    }

    for (const [label, items] of byLabel) {
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        await session.run(
          `UNWIND $batch AS s
           MATCH (n:${label} {name: s.name, file_path: s.file_path, repo_url: $repoUrl})
           WHERE n.valid_to = $sha
           MATCH (c:Commit {sha: $sha, repo_url: $repoUrl})
           CREATE (n)-[:INTRODUCED_IN {change_type: 'deleted'}]->(c)`,
          { batch, repoUrl: ctx.repoUrl, sha: ctx.commitSha }
        );
        count += batch.length;
      }
    }
  }

  return count;
}

// ─── Pre-temporal migration stamp ────────────────────────────────

/**
 * Stamp any nodes and edges that were created by the non-temporal loader
 * (i.e., they have no `valid_from` property) with temporal fields.
 * This runs on every temporalLoad() but is a no-op once all entities
 * have been stamped (idempotent via r.valid_from IS NULL condition).
 */
async function stampPreTemporalEntities(
  session: ReturnType<typeof getSession>,
  ctx: TemporalContext
): Promise<number> {
  let count = 0;

  // Stamp pre-temporal symbol nodes (Function, Class, TypeDef, Constant)
  for (const label of ["Function", "Class", "TypeDef", "Constant"]) {
    const nodeResult = await session.run(
      `MATCH (n:${label} {repo_url: $repoUrl})
       WHERE n.valid_from IS NULL
       SET n.valid_from = $sha, n.valid_from_ts = datetime($ts),
           n.change_type = 'migrated', n.changed_by = $author
       RETURN count(n) AS cnt`,
      { repoUrl: ctx.repoUrl, sha: ctx.commitSha, ts: ctx.commitTs, author: ctx.author }
    );
    count += nodeResult.records[0]?.get("cnt")?.toNumber?.() ?? 0;
  }

  // Stamp pre-temporal CALLS edges
  const callsResult = await session.run(
    `MATCH (caller {repo_url: $repoUrl})-[r:CALLS]->(callee {repo_url: $repoUrl})
     WHERE (caller:Function OR caller:Class) AND (callee:Function OR callee:Class)
       AND r.valid_from IS NULL
     SET r.valid_from = $sha, r.valid_from_ts = datetime($ts), r.change_type = 'migrated'
     RETURN count(r) AS cnt`,
    { repoUrl: ctx.repoUrl, sha: ctx.commitSha, ts: ctx.commitTs }
  );
  count += callsResult.records[0]?.get("cnt")?.toNumber?.() ?? 0;

  // Stamp pre-temporal IMPORTS edges
  const importsResult = await session.run(
    `MATCH (from:File {repo_url: $repoUrl})-[r:IMPORTS]->(to:File {repo_url: $repoUrl})
     WHERE r.valid_from IS NULL
     SET r.valid_from = $sha, r.valid_from_ts = datetime($ts), r.change_type = 'migrated'
     RETURN count(r) AS cnt`,
    { repoUrl: ctx.repoUrl, sha: ctx.commitSha, ts: ctx.commitTs }
  );
  count += importsResult.records[0]?.get("cnt")?.toNumber?.() ?? 0;

  if (count > 0) {
    console.log(`[temporal-loader] Stamped ${count} pre-temporal entities with temporal fields`);
  }

  return count;
}

// ─── Helpers ────────────────────────────────────────────────────

function groupByKind(
  snapshots: GraphNodeSnapshot[]
): Map<GraphNodeSnapshot["kind"], GraphNodeSnapshot[]> {
  const result = new Map<GraphNodeSnapshot["kind"], GraphNodeSnapshot[]>();
  for (const snap of snapshots) {
    const existing = result.get(snap.kind) || [];
    existing.push(snap);
    result.set(snap.kind, existing);
  }
  return result;
}
