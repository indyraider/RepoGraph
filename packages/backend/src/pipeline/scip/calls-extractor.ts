import { ParsedSymbol } from "../parser.js";
import { ScipDocument, SymbolRole } from "./parser.js";
import {
  SymbolTableEntry,
  buildContainingFunctionIndex,
  findContainingFunction,
} from "./symbol-table.js";
import { CallsEdge } from "./types.js";

/**
 * Extract argument expressions from the call site line.
 * Looks for `calleeName(arg1, arg2, ...)` and extracts the argument list.
 */
function extractArgExpressions(
  fileLines: string[] | undefined,
  calleeName: string,
  callSiteLine0: number // 0-indexed
): string[] | undefined {
  if (!fileLines) return undefined;

  // Look at the call site line and a few lines after (for multi-line calls)
  const startLine = callSiteLine0;
  const endLine = Math.min(startLine + 10, fileLines.length);
  const chunk = fileLines.slice(startLine, endLine).join("\n");

  // Find the function call and extract the argument list
  const escaped = calleeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const callMatch = chunk.match(new RegExp(escaped + "(?:<[^>]*>)?\\s*\\("));
  if (!callMatch || callMatch.index === undefined) return undefined;

  // Walk forward from the opening paren, counting depth
  const startIdx = callMatch.index + callMatch[0].length;
  let depth = 1;
  let current = "";
  const args: string[] = [];

  for (let i = startIdx; i < chunk.length && depth > 0; i++) {
    const ch = chunk[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        if (current.trim()) args.push(current.trim());
        break;
      }
    }
    if (ch === "," && depth === 1) {
      if (current.trim()) args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }

  if (args.length === 0) return undefined;

  // Truncate long expressions to keep graph data manageable
  return args.map((a) => a.length > 80 ? a.slice(0, 77) + "..." : a);
}

/**
 * Extract CALLS edges from SCIP occurrence data.
 *
 * For each reference occurrence that targets a function/class in the symbol table,
 * find the containing function (the caller) and create a caller→callee edge.
 *
 * @param fileContentMap Optional map of relative file path → file content string.
 *   When provided, argument expressions are extracted from the source at each call site.
 */
export function extractCallsEdges(
  scipDocuments: ScipDocument[],
  symbolTable: Map<string, SymbolTableEntry>,
  parsedSymbols: ParsedSymbol[],
  repoPath: string,
  fileContentMap?: Map<string, string>
): CallsEdge[] {
  const containingIdx = buildContainingFunctionIndex(parsedSymbols, repoPath);
  const edges: CallsEdge[] = [];

  // Pre-split file contents into lines for efficient lookup
  const fileLinesCache = new Map<string, string[]>();
  function getFileLines(path: string): string[] | undefined {
    if (fileLinesCache.has(path)) return fileLinesCache.get(path);
    const content = fileContentMap?.get(path);
    if (!content) return undefined;
    const lines = content.split("\n");
    fileLinesCache.set(path, lines);
    return lines;
  }

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

      // Extract argument expressions from the source
      const argExpressions = extractArgExpressions(
        getFileLines(doc.relativePath),
        target.parsed.name,
        occ.range[0]
      );

      edges.push({
        callerFilePath: caller.filePath,
        callerName: caller.name,
        calleeFilePath: target.parsed.filePath,
        calleeName: target.parsed.name,
        callSiteLine,
        argExpressions,
      });
    }
  }

  return edges;
}
