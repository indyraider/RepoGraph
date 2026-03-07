import { getSession } from "../db/neo4j.js";
import { getSupabase } from "../db/supabase.js";

// ─── Types ──────────────────────────────────────────────────────

export interface ComplexityMetric {
  filePath: string;
  metricName: string;
  metricValue: number;
}

export interface ComplexityResult {
  metricsComputed: number;
  filesAnalyzed: number;
}

const BATCH_SIZE = 500;

// ─── Main entry point ───────────────────────────────────────────

/**
 * Compute per-file structural complexity metrics from the Neo4j graph
 * and store them in Supabase's `complexity_metrics` table.
 *
 * Metrics computed:
 * - import_count: number of files this file imports from
 * - reverse_import_count: number of files that import this file
 * - symbol_count: number of symbols (functions, classes, types, constants) in this file
 * - coupling_score: import_count + reverse_import_count (fan-in + fan-out)
 */
export async function computeComplexityMetrics(
  repoUrl: string,
  repoId: string,
  commitSha: string,
  commitTs: string
): Promise<ComplexityResult> {
  const session = getSession();
  const metrics: ComplexityMetric[] = [];
  const allFilePaths = new Set<string>();

  try {
    // Query per-file import count (outgoing IMPORTS edges)
    const importCountResult = await session.run(
      `MATCH (f:File {repo_url: $repoUrl})-[r:IMPORTS]->(target:File)
       WHERE r.valid_to IS NULL OR NOT EXISTS(r.valid_to)
       RETURN f.path AS filePath, count(r) AS importCount`,
      { repoUrl }
    );

    const importCounts = new Map<string, number>();
    for (const record of importCountResult.records) {
      const filePath = record.get("filePath");
      const count = typeof record.get("importCount") === "object"
        ? record.get("importCount").toNumber()
        : record.get("importCount");
      importCounts.set(filePath, count);
      metrics.push({ filePath, metricName: "import_count", metricValue: count });
    }

    // Query per-file reverse import count (incoming IMPORTS edges)
    const reverseImportResult = await session.run(
      `MATCH (source:File)-[r:IMPORTS]->(f:File {repo_url: $repoUrl})
       WHERE r.valid_to IS NULL OR NOT EXISTS(r.valid_to)
       RETURN f.path AS filePath, count(r) AS reverseImportCount`,
      { repoUrl }
    );

    const reverseImportCounts = new Map<string, number>();
    for (const record of reverseImportResult.records) {
      const filePath = record.get("filePath");
      const count = typeof record.get("reverseImportCount") === "object"
        ? record.get("reverseImportCount").toNumber()
        : record.get("reverseImportCount");
      reverseImportCounts.set(filePath, count);
      metrics.push({ filePath, metricName: "reverse_import_count", metricValue: count });
    }

    // Query per-file symbol count
    const symbolCountResult = await session.run(
      `MATCH (f:File {repo_url: $repoUrl})-[:CONTAINS]->(sym)
       WHERE (sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant)
         AND (sym.valid_to IS NULL OR NOT EXISTS(sym.valid_to))
       RETURN f.path AS filePath, count(sym) AS symbolCount`,
      { repoUrl }
    );

    for (const record of symbolCountResult.records) {
      const filePath = record.get("filePath");
      const count = typeof record.get("symbolCount") === "object"
        ? record.get("symbolCount").toNumber()
        : record.get("symbolCount");
      allFilePaths.add(filePath);
      metrics.push({ filePath, metricName: "symbol_count", metricValue: count });
    }

    // Compute coupling_score = import_count + reverse_import_count
    // Collect all file paths from all metrics
    for (const fp of importCounts.keys()) allFilePaths.add(fp);
    for (const fp of reverseImportCounts.keys()) allFilePaths.add(fp);

    for (const filePath of allFilePaths) {
      const fanOut = importCounts.get(filePath) || 0;
      const fanIn = reverseImportCounts.get(filePath) || 0;
      metrics.push({
        filePath,
        metricName: "coupling_score",
        metricValue: fanIn + fanOut,
      });
    }
  } finally {
    await session.close();
  }

  if (metrics.length === 0) {
    return { metricsComputed: 0, filesAnalyzed: 0 };
  }

  // Write metrics to Supabase
  const sb = getSupabase();
  let written = 0;

  for (let i = 0; i < metrics.length; i += BATCH_SIZE) {
    const batch = metrics.slice(i, i + BATCH_SIZE).map((m) => ({
      repo_id: repoId,
      commit_sha: commitSha,
      file_path: m.filePath,
      metric_name: m.metricName,
      metric_value: m.metricValue,
      timestamp: commitTs,
    }));

    const { error } = await sb.from("complexity_metrics").insert(batch);
    if (error) {
      console.error("[complexity] Supabase insert failed:", error.message);
    } else {
      written += batch.length;
    }
  }

  const filesAnalyzed = allFilePaths.size;
  console.log(
    `[complexity] Computed ${metrics.length} metrics for ${filesAnalyzed} files ` +
    `(${written} written to Supabase)`
  );

  return { metricsComputed: written, filesAnalyzed };
}
