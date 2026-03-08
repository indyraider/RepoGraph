import { config } from "../../config.js";
import { ScipStageInput, ScipStageResult, ScipStats } from "./types.js";
import { isAdapterAvailable, getAdaptersForLanguages, runScipIndexer, ScipLanguageAdapter } from "./runner.js";
import { checkCache, cacheIndex, getScipOutputPath, cleanupScipOutput } from "./cache.js";
import { parseScipIndex, ScipIndexData } from "./parser.js";
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
 * Run the SCIP stage: detect languages, run appropriate indexers,
 * parse the SCIP index, build a symbol table, enrich nodes, extract CALLS edges.
 *
 * Supports multiple languages via the adapter registry. Each adapter
 * (scip-typescript, rust-analyzer, scip-python, etc.) is run independently
 * and results are merged.
 */
export async function runScipStage(
  input: ScipStageInput
): Promise<ScipStageResult & { symbolTable?: Map<string, SymbolTableEntry> }> {
  const startTime = Date.now();

  if (!config.scip.enabled) {
    return makeSkippedResult(input, "skipped", "SCIP disabled via config");
  }

  // Detect which languages are present and get their adapters
  const detectedLanguages = [...new Set(input.allFiles.map((f) => f.language))];
  const adapters = getAdaptersForLanguages(detectedLanguages);

  if (adapters.length === 0) {
    return makeSkippedResult(input, "skipped", "No SCIP-supported languages found");
  }

  // Check availability of each adapter and run available ones
  const mergedDocuments: ScipIndexData["documents"] = [];
  const mergedExternalSymbols: ScipIndexData["externalSymbols"] = [];
  let totalRunDurationMs = 0;
  let anySuccess = false;
  let anyFailed = false;
  const adapterResults: string[] = [];

  for (const adapter of adapters) {
    const available = await isAdapterAvailable(adapter);
    if (!available) {
      console.warn(`[scip] ${adapter.label} not found on PATH — skipping SCIP for ${adapter.language} files`);
      adapterResults.push(`${adapter.label}: not_installed`);
      continue;
    }

    // Check cache for this adapter
    const cacheKey = `${input.repoUrl}:${adapter.label}`;
    let indexPath: string | null = checkCache(cacheKey, input.commitSha);
    let fromCache = false;

    if (indexPath) {
      fromCache = true;
      console.log(`[scip] Using cached SCIP index for ${adapter.label}`);
    } else {
      const outputPath = getScipOutputPath(`${input.jobId}-${adapter.language}`);
      console.log(`[scip] Running ${adapter.label}...`);
      const runResult = await runScipIndexer(adapter, input.repoPath, outputPath);
      totalRunDurationMs += runResult.durationMs;

      if (!runResult.success) {
        const status = runResult.error?.startsWith("timeout") ? "timeout" : "failed";
        console.error(`[scip] ${adapter.label} failed: ${runResult.error}`);
        cleanupScipOutput(outputPath);
        adapterResults.push(`${adapter.label}: ${status} (${runResult.error})`);
        anyFailed = true;
        continue;
      }

      indexPath = runResult.indexPath;
      console.log(`[scip] ${adapter.label} completed in ${runResult.durationMs}ms`);
    }

    // Parse SCIP index from this adapter
    try {
      const indexData = parseScipIndex(indexPath);
      mergedDocuments.push(...indexData.documents);
      mergedExternalSymbols.push(...indexData.externalSymbols);
      anySuccess = true;
      adapterResults.push(`${adapter.label}: success`);

      if (!fromCache) {
        cacheIndex(cacheKey, input.commitSha, indexPath);
        cleanupScipOutput(indexPath);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scip] Failed to parse ${adapter.label} SCIP index: ${msg}`);
      if (!fromCache) cleanupScipOutput(indexPath);
      adapterResults.push(`${adapter.label}: parse_error (${msg})`);
      anyFailed = true;
    }
  }

  if (!anySuccess) {
    const reason = adapterResults.join("; ");
    return makeSkippedResult(
      input,
      anyFailed ? "failed" : "skipped",
      reason,
      totalRunDurationMs
    );
  }

  // Merge all SCIP data and process
  const mergedIndexData: ScipIndexData = {
    documents: mergedDocuments,
    externalSymbols: mergedExternalSymbols,
  };

  // Build symbol table
  const { table: symbolTable, unmatchedCount } = buildSymbolTable(
    mergedIndexData.documents,
    input.allSymbols,
    input.repoPath
  );

  // Enrich nodes with type info
  enrichSymbols(symbolTable);

  // Collect diagnostics
  const diagnostics = attachDiagnostics(mergedIndexData.documents, symbolTable, input.repoPath);

  // Build file content map for argument expression extraction
  const fileContentMap = new Map<string, string>();
  for (const f of input.allFiles) {
    if (f.content) fileContentMap.set(f.path, f.content);
  }

  // Extract CALLS edges
  const callsEdges = extractCallsEdges(
    mergedIndexData.documents,
    symbolTable,
    input.allSymbols,
    input.repoPath,
    fileContentMap
  );

  // Enrich CALLS edges with type mismatch info
  enrichCallsEdges(callsEdges, symbolTable);

  // Compute stats
  const totalOccurrences = mergedIndexData.documents.reduce(
    (sum, doc) => sum + doc.occurrences.length,
    0
  );
  const totalSymbols = mergedIndexData.documents.reduce(
    (sum, doc) => sum + doc.symbols.length,
    0
  );

  const durationMs = Date.now() - startTime;
  const status: ScipStats["scipStatus"] = anyFailed ? "partial" : "success";
  console.log(
    `[scip] Done (${status}): ${symbolTable.size} matched symbols, ${unmatchedCount} unmatched, ` +
    `${callsEdges.length} CALLS edges, ${diagnostics.length} diagnostics (${durationMs}ms) ` +
    `[${adapterResults.join(", ")}]`
  );

  return {
    enrichedSymbols: input.allSymbols,
    callsEdges,
    enrichedDirectImports: input.directImports,
    diagnostics,
    stats: {
      scipStatus: status,
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
