import { Session } from "neo4j-driver";
import { MatchedFinding } from "./types.js";

const BATCH_SIZE = 200;

/**
 * Purge all existing FLOWS_TO edges and DataFlowFinding nodes for a repo.
 */
async function purgeCodeQLData(
  session: Session,
  repoUrl: string
): Promise<void> {
  // Delete DataFlowFinding nodes and their relationships
  await session.run(
    `MATCH (f:DataFlowFinding {repo_url: $repoUrl})
     DETACH DELETE f`,
    { repoUrl }
  );

  // Delete FLOWS_TO edges (between Function nodes)
  await session.run(
    `MATCH (:Function {repo_url: $repoUrl})-[r:FLOWS_TO]->(:Function {repo_url: $repoUrl})
     DELETE r`,
    { repoUrl }
  );
}

/**
 * Write DataFlowFinding nodes to Neo4j.
 */
async function writeFindingNodes(
  session: Session,
  repoUrl: string,
  jobId: string,
  findings: MatchedFinding[]
): Promise<number> {
  let count = 0;

  for (let i = 0; i < findings.length; i += BATCH_SIZE) {
    const batch = findings.slice(i, i + BATCH_SIZE).map((f) => ({
      query_id: f.queryId,
      severity: f.severity,
      message: f.message,
      source_path: `${f.source.file}:${f.source.line}`,
      sink_path: `${f.sink.file}:${f.sink.line}`,
      path_complete: f.pathComplete,
    }));

    const result = await session.run(
      `UNWIND $findings AS f
       CREATE (n:DataFlowFinding {
         repo_url: $repoUrl,
         job_id: $jobId,
         query_id: f.query_id,
         severity: f.severity,
         message: f.message,
         source_path: f.source_path,
         sink_path: f.sink_path,
         path_complete: f.path_complete
       })
       RETURN count(n) AS cnt`,
      { findings: batch, repoUrl, jobId }
    );

    count += result.records[0]?.get("cnt")?.toNumber?.() ?? 0;
  }

  return count;
}

/**
 * Derive a sink_kind from a CodeQL query ID.
 * e.g., "js/sql-injection" → "sql", "js/xss" → "xss"
 */
function deriveSinkKind(queryId: string): string {
  // Extract the last segment after the slash
  const parts = queryId.split("/");
  const ruleName = parts[parts.length - 1] ?? queryId;

  // Map common CodeQL rule names to sink kinds
  if (ruleName.includes("sql-injection")) return "sql";
  if (ruleName.includes("xss")) return "xss";
  if (ruleName.includes("path-injection") || ruleName.includes("path-traversal")) return "path";
  if (ruleName.includes("code-injection")) return "code";
  if (ruleName.includes("command-injection")) return "command";
  if (ruleName.includes("prototype-pollution")) return "prototype";
  if (ruleName.includes("rate-limiting")) return "rate-limit";

  return ruleName;
}

/**
 * Write FLOWS_TO edges between matched Function nodes.
 * Only creates edges where both source and sink were matched.
 */
async function writeFlowEdges(
  session: Session,
  repoUrl: string,
  findings: MatchedFinding[]
): Promise<number> {
  // Filter to findings with both source and sink matched
  const complete = findings.filter(
    (f) => f.sourceNodeId !== null && f.sinkNodeId !== null
  );

  if (complete.length === 0) return 0;

  let count = 0;

  for (let i = 0; i < complete.length; i += BATCH_SIZE) {
    const batch = complete.slice(i, i + BATCH_SIZE).map((f) => ({
      source_id: f.sourceNodeId,
      sink_id: f.sinkNodeId,
      query_id: f.queryId,
      sink_kind: deriveSinkKind(f.queryId),
      severity: f.severity,
      message: f.message,
      path_steps: JSON.stringify(f.pathSteps),
      path_complete: f.pathComplete,
    }));

    const result = await session.run(
      `UNWIND $edges AS e
       MATCH (source) WHERE elementId(source) = e.source_id
       MATCH (sink) WHERE elementId(sink) = e.sink_id
       MERGE (source)-[r:FLOWS_TO {query_id: e.query_id}]->(sink)
       SET r.sink_kind = e.sink_kind,
           r.severity = e.severity,
           r.message = e.message,
           r.path_steps = e.path_steps,
           r.path_complete = e.path_complete
       RETURN count(r) AS cnt`,
      { edges: batch }
    );

    count += result.records[0]?.get("cnt")?.toNumber?.() ?? 0;
  }

  return count;
}

/**
 * Load CodeQL findings into Neo4j.
 *
 * Performs a full replacement: purges all existing CodeQL data for the repo,
 * then writes new findings. Purge and write happen sequentially — purge only
 * runs when we have replacement data ready (per Issue 2 in the plan).
 *
 * @returns Count of DataFlowFinding nodes and FLOWS_TO edges created
 */
export async function loadCodeQLFindings(
  repoUrl: string,
  findings: MatchedFinding[],
  jobId: string,
  session: Session
): Promise<{ findingCount: number; flowEdgeCount: number }> {
  if (findings.length === 0) {
    // Still purge old data even if no new findings (repo may have been fixed)
    await purgeCodeQLData(session, repoUrl);
    return { findingCount: 0, flowEdgeCount: 0 };
  }

  // Purge old data first (we have replacement data ready)
  await purgeCodeQLData(session, repoUrl);

  // Write new DataFlowFinding nodes
  const findingCount = await writeFindingNodes(session, repoUrl, jobId, findings);

  // Write FLOWS_TO edges
  const flowEdgeCount = await writeFlowEdges(session, repoUrl, findings);

  console.log(
    `[codeql] Loaded ${findingCount} DataFlowFinding nodes, ${flowEdgeCount} FLOWS_TO edges`
  );

  return { findingCount, flowEdgeCount };
}
