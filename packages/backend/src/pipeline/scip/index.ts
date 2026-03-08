import { config } from "../../config.js";
import { ScipStageInput, ScipStageResult, ScipStats } from "./types.js";
import { isScipAvailable, runScipTypescript } from "./runner.js";
import { checkCache, cacheIndex, getScipOutputPath, cleanupScipOutput } from "./cache.js";
import { parseScipIndex } from "./parser.js";
import { buildSymbolTable, SymbolTableEntry } from "./symbol-table.js";
import { enrichSymbols, attachDiagnostics } from "./node-enricher.js";
import { extractCallsEdges } from "./calls-extractor.js";
import { enrichCallsEdges } from "./edge-enricher.js";

function makeSkippedResult(
  input: ScipStageInput,
  status: ScipStats["scipStatus"],
  reason: string,
  durationMs: number = 0
): ScipStageResult {
  return {
    enrichedSymbols: input.allSymbols,
    callsEdges: [],
    enrichedDirectImports: input.directImports,
    diagnostics: [],
    stats: {
      scipStatus: status,
      scipDurationMs: durationMs,
      scipSymbolCount: 0,
      scipOccurrenceCount: 0,
      scipDiagnosticCount: 0,
      unmatchedScipSymbols: 0,
      callsEdgeCount: 0,
      reason,
    },
    skipped: true,
  };
}

/**
 * Run the SCIP stage: index TypeScript code, parse the SCIP index,
 * build a symbol table, enrich nodes, extract CALLS edges.
 *
 * Returns the symbol table so digest.ts can call enrichDirectImports
 * after the Resolve stage completes.
 */
export async function runScipStage(
  input: ScipStageInput
): Promise<ScipStageResult & { symbolTable?: Map<string, SymbolTableEntry> }> {
  const startTime = Date.now();

  // Check if SCIP is enabled
  if (!config.scip.enabled) {
    return makeSkippedResult(input, "skipped", "SCIP disabled via config");
  }

  // Check if there are any TypeScript files
  const hasTs = input.allFiles.some(
    (f) => f.language === "typescript" || f.language === "tsx" || f.language === "javascript"
  );
  if (!hasTs) {
    return makeSkippedResult(input, "skipped_no_ts", "No TypeScript/JavaScript files found");
  }

  // Check if scip-typescript is installed
  const available = await isScipAvailable();
  if (!available) {
    console.warn("[scip] scip-typescript not found on PATH — skipping SCIP stage");
    return makeSkippedResult(input, "skipped", "scip-typescript not installed");
  }

  // Check cache
  let indexPath: string | null = checkCache(input.repoUrl, input.commitSha);
  let fromCache = false;
  let runDurationMs = 0;

  if (indexPath) {
    fromCache = true;
    console.log("[scip] Using cached SCIP index");
  } else {
    // Run scip-typescript
    const outputPath = getScipOutputPath(input.jobId);
    console.log("[scip] Running scip-typescript...");
    const runResult = await runScipTypescript(input.repoPath, outputPath);
    runDurationMs = runResult.durationMs;

    if (!runResult.success) {
      const status = runResult.error?.startsWith("timeout") ? "timeout" : "failed";
      console.error(`[scip] scip-typescript failed: ${runResult.error}`);
      cleanupScipOutput(outputPath);
      return makeSkippedResult(input, status, runResult.error || "unknown error", runDurationMs);
    }

    indexPath = runResult.indexPath;
    console.log(`[scip] scip-typescript completed in ${runDurationMs}ms`);
  }

  // Parse SCIP index
  let indexData;
  try {
    indexData = parseScipIndex(indexPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scip] Failed to parse SCIP index: ${msg}`);
    if (!fromCache) cleanupScipOutput(indexPath);
    return makeSkippedResult(input, "failed", `parse error: ${msg}`, runDurationMs);
  }

  // Build symbol table
  const { table: symbolTable, unmatchedCount } = buildSymbolTable(
    indexData.documents,
    input.allSymbols,
    input.repoPath
  );

  // Enrich nodes with type info
  enrichSymbols(symbolTable);

  // Collect diagnostics
  const diagnostics = attachDiagnostics(indexData.documents, symbolTable, input.repoPath);

  // Build file content map for argument expression extraction
  const fileContentMap = new Map<string, string>();
  for (const f of input.allFiles) {
    if (f.content) fileContentMap.set(f.path, f.content);
  }

  // Extract CALLS edges (with argument expressions when file content is available)
  const callsEdges = extractCallsEdges(
    indexData.documents,
    symbolTable,
    input.allSymbols,
    input.repoPath,
    fileContentMap
  );

  // Enrich CALLS edges with type mismatch info
  enrichCallsEdges(callsEdges, symbolTable);

  // Cache the index for future runs
  if (!fromCache) {
    cacheIndex(input.repoUrl, input.commitSha, indexPath);
    cleanupScipOutput(indexPath);
  }

  // Compute stats
  const totalOccurrences = indexData.documents.reduce(
    (sum, doc) => sum + doc.occurrences.length,
    0
  );
  const totalSymbols = indexData.documents.reduce(
    (sum, doc) => sum + doc.symbols.length,
    0
  );

  const durationMs = Date.now() - startTime;
  console.log(
    `[scip] Done: ${symbolTable.size} matched symbols, ${unmatchedCount} unmatched, ` +
    `${callsEdges.length} CALLS edges, ${diagnostics.length} diagnostics (${durationMs}ms)`
  );

  return {
    enrichedSymbols: input.allSymbols, // already mutated in place
    callsEdges,
    enrichedDirectImports: input.directImports, // will be enriched post-Resolve
    diagnostics,
    stats: {
      scipStatus: fromCache ? "cache_hit" : "success",
      scipDurationMs: durationMs,
      scipSymbolCount: totalSymbols,
      scipOccurrenceCount: totalOccurrences,
      scipDiagnosticCount: diagnostics.length,
      unmatchedScipSymbols: unmatchedCount,
      callsEdgeCount: callsEdges.length,
    },
    skipped: false,
    symbolTable,
  };
}
