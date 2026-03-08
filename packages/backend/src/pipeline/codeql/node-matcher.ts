import { Session } from "neo4j-driver";
import { CodeQLFinding, CodeQLLocation, MatchedFinding } from "./types.js";

/**
 * Match a CodeQL file:line location to the innermost Function node in Neo4j.
 *
 * Strategy:
 * 1. Find all Function nodes in the same file whose range contains the line
 * 2. Pick the innermost one (smallest range = end_line - start_line)
 * 3. If no match, log and return null
 */
async function matchLocationToNode(
  session: Session,
  repoUrl: string,
  location: CodeQLLocation
): Promise<string | null> {
  const result = await session.run(
    `MATCH (f:Function {repo_url: $repoUrl, file_path: $file})
     WHERE f.start_line <= $line AND f.end_line >= $line
     RETURN elementId(f) AS nodeId, f.name AS name,
            f.start_line AS startLine, f.end_line AS endLine
     ORDER BY (f.end_line - f.start_line) ASC
     LIMIT 1`,
    { repoUrl, file: location.file, line: location.line }
  );

  if (result.records.length === 0) {
    return null;
  }

  return result.records[0].get("nodeId") as string;
}

/**
 * Batch-match all unique locations to avoid redundant Neo4j queries.
 * Returns a map of "file:line" → nodeId (or null if unmatched).
 */
async function buildLocationMap(
  session: Session,
  repoUrl: string,
  locations: CodeQLLocation[]
): Promise<Map<string, string | null>> {
  const locationMap = new Map<string, string | null>();
  // Deduplicate by file+line, keeping the original location objects
  const uniqueLocations = new Map<string, CodeQLLocation>();

  for (const loc of locations) {
    const key = `${loc.file}:${loc.line}`;
    if (!uniqueLocations.has(key)) {
      uniqueLocations.set(key, loc);
    }
  }

  // Match each unique location
  for (const [key, loc] of uniqueLocations) {
    try {
      const nodeId = await matchLocationToNode(session, repoUrl, loc);
      locationMap.set(key, nodeId);
    } catch (err) {
      console.warn(
        `[codeql] Neo4j query failed for location ${key}:`,
        err instanceof Error ? err.message : err
      );
      locationMap.set(key, null);
    }
  }

  return locationMap;
}

/**
 * Match CodeQL findings to Neo4j Function nodes.
 *
 * For each finding, attempts to match both source and sink locations
 * to existing Function nodes in the graph. Findings where neither
 * source nor sink can be matched are dropped entirely.
 *
 * @returns Matched findings and count of unmatched locations
 */
export async function matchFindings(
  findings: CodeQLFinding[],
  repoUrl: string,
  session: Session
): Promise<{ matched: MatchedFinding[]; unmatchedCount: number }> {
  if (findings.length === 0) {
    return { matched: [], unmatchedCount: 0 };
  }

  // Collect all locations that need matching (sources + sinks)
  const allLocations: CodeQLLocation[] = [];
  for (const finding of findings) {
    allLocations.push(finding.source, finding.sink);
  }

  // Batch-match all unique locations
  const locationMap = await buildLocationMap(session, repoUrl, allLocations);

  let unmatchedCount = 0;
  const matched: MatchedFinding[] = [];

  for (const finding of findings) {
    const sourceKey = `${finding.source.file}:${finding.source.line}`;
    const sinkKey = `${finding.sink.file}:${finding.sink.line}`;

    const sourceNodeId = locationMap.get(sourceKey) ?? null;
    const sinkNodeId = locationMap.get(sinkKey) ?? null;

    if (!sourceNodeId) unmatchedCount++;
    if (!sinkNodeId) unmatchedCount++;

    // Drop findings where neither source nor sink could be matched
    if (!sourceNodeId && !sinkNodeId) {
      console.warn(
        `[codeql] Dropping finding ${finding.queryId}: neither source (${sourceKey}) nor sink (${sinkKey}) matched a graph node`
      );
      continue;
    }

    if (!sourceNodeId || !sinkNodeId) {
      console.log(
        `[codeql] Partial match for ${finding.queryId}: source=${sourceNodeId ? "matched" : "unmatched"}, sink=${sinkNodeId ? "matched" : "unmatched"}`
      );
    }

    matched.push({
      ...finding,
      sourceNodeId,
      sinkNodeId,
      pathComplete: sourceNodeId !== null && sinkNodeId !== null,
    });
  }

  console.log(
    `[codeql] Matched ${matched.length}/${findings.length} findings (${unmatchedCount} unmatched locations)`
  );

  return { matched, unmatchedCount };
}
