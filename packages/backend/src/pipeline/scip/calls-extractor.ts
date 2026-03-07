import { ParsedSymbol } from "../parser.js";
import { ScipDocument, SymbolRole } from "./parser.js";
import {
  SymbolTableEntry,
  buildContainingFunctionIndex,
  findContainingFunction,
} from "./symbol-table.js";
import { CallsEdge } from "./types.js";

/**
 * Extract CALLS edges from SCIP occurrence data.
 *
 * For each reference occurrence that targets a function/class in the symbol table,
 * find the containing function (the caller) and create a caller→callee edge.
 */
export function extractCallsEdges(
  scipDocuments: ScipDocument[],
  symbolTable: Map<string, SymbolTableEntry>,
  parsedSymbols: ParsedSymbol[],
  repoPath: string
): CallsEdge[] {
  const containingIdx = buildContainingFunctionIndex(parsedSymbols, repoPath);
  const edges: CallsEdge[] = [];

  // Deduplicate: avoid creating duplicate edges for multiple references
  // from the same caller to the same callee on the same line.
  const seen = new Set<string>();

  for (const doc of scipDocuments) {
    for (const occ of doc.occurrences) {
      // Skip definitions and imports — we only want reference call sites
      if (occ.symbolRoles & SymbolRole.Definition) continue;
      if (occ.symbolRoles & SymbolRole.Import) continue;

      // Resolve the target symbol via the symbol table
      const target = symbolTable.get(occ.symbol);
      if (!target) continue; // external or unmatched symbol

      // Only create CALLS edges to functions and classes (constructors)
      if (target.parsed.kind !== "function" && target.parsed.kind !== "class") continue;

      // Find the containing function for this occurrence (the caller)
      const caller = findContainingFunction(
        containingIdx,
        doc.relativePath,
        occ.range[0] // 0-indexed line
      );
      if (!caller) continue; // module-level call — skip for v1

      // Skip self-calls (recursive) — they're valid but noisy
      if (caller === target.parsed) continue;

      // Deduplicate key (filePaths are already relative)
      const callSiteLine = occ.range[0] + 1; // convert to 1-indexed
      const dedupKey = `${caller.filePath}::${caller.name}->${target.parsed.filePath}::${target.parsed.name}@${callSiteLine}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      edges.push({
        callerFilePath: caller.filePath,
        callerName: caller.name,
        calleeFilePath: target.parsed.filePath,
        calleeName: target.parsed.name,
        callSiteLine,
      });
    }
  }

  return edges;
}
