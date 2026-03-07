import { ParsedSymbol } from "../parser.js";
import { ScipDocument, ScipSymbolInfo, parseScipSymbolId } from "./parser.js";

/** Entry in the symbol table linking a SCIP symbol to a ParsedSymbol. */
export interface SymbolTableEntry {
  parsed: ParsedSymbol;
  scip: ScipSymbolInfo;
}

/**
 * Build a symbol table mapping SCIP symbols to ParsedSymbol objects.
 *
 * Matches by file path (relative) and symbol name. The SCIP symbol ID encodes
 * the file path and name; ParsedSymbol has filePath and name directly.
 *
 * Returns the table and a count of unmatched SCIP symbols.
 */
export function buildSymbolTable(
  scipDocuments: ScipDocument[],
  parsedSymbols: ParsedSymbol[],
  repoPath: string
): { table: Map<string, SymbolTableEntry>; unmatchedCount: number } {
  // Build a lookup index: "relativePath::name" -> ParsedSymbol
  // ParsedSymbol.filePath is absolute; we need to convert to relative.
  const repoPrefix = repoPath.endsWith("/") ? repoPath : repoPath + "/";
  const parsedIndex = new Map<string, ParsedSymbol>();

  for (const sym of parsedSymbols) {
    const relPath = sym.filePath.startsWith(repoPrefix)
      ? sym.filePath.slice(repoPrefix.length)
      : sym.filePath;
    const key = `${relPath}::${sym.name}`;
    // If there are multiple symbols with the same name in the same file
    // (e.g. overloads), keep the first one. SCIP will have separate entries.
    if (!parsedIndex.has(key)) {
      parsedIndex.set(key, sym);
    }
  }

  const table = new Map<string, SymbolTableEntry>();
  let unmatchedCount = 0;

  for (const doc of scipDocuments) {
    // Use the document's relativePath (repo-root-relative, e.g. "packages/backend/src/config.ts")
    // instead of parsing the file path from the SCIP symbol ID, which is package-relative
    // (e.g. "src/config.ts") and won't match ParsedSymbol paths.
    const docPath = doc.relativePath;

    for (const scipSym of doc.symbols) {
      // Parse the SCIP symbol ID to get the symbol name and container
      const parsed = parseScipSymbolId(scipSym.symbol);
      if (!parsed) {
        unmatchedCount++;
        continue;
      }

      // Try matching against the parsed symbols index using the document's path
      const key = `${docPath}::${parsed.name}`;
      const matchedParsed = parsedIndex.get(key);

      if (matchedParsed) {
        table.set(scipSym.symbol, { parsed: matchedParsed, scip: scipSym });
      } else if (parsed.containerName) {
        // Try ClassName.methodName (tree-sitter convention for class methods)
        const dotKey = `${docPath}::${parsed.containerName}.${parsed.name}`;
        const dotMatch = parsedIndex.get(dotKey);
        if (dotMatch) {
          table.set(scipSym.symbol, { parsed: dotMatch, scip: scipSym });
        } else {
          // Fallback: match the container (class) itself
          const containerKey = `${docPath}::${parsed.containerName}`;
          const containerMatch = parsedIndex.get(containerKey);
          if (containerMatch && !table.has(scipSym.symbol)) {
            table.set(scipSym.symbol, { parsed: containerMatch, scip: scipSym });
          } else {
            unmatchedCount++;
          }
        }
      } else {
        unmatchedCount++;
      }
    }
  }

  return { table, unmatchedCount };
}

/**
 * Build a reverse lookup: for a given relative file path and line number,
 * find the ParsedSymbol (function/class) that contains that line.
 */
export function buildContainingFunctionIndex(
  parsedSymbols: ParsedSymbol[],
  repoPath: string
): Map<string, ParsedSymbol[]> {
  const repoPrefix = repoPath.endsWith("/") ? repoPath : repoPath + "/";
  const index = new Map<string, ParsedSymbol[]>();

  for (const sym of parsedSymbols) {
    if (sym.kind !== "function" && sym.kind !== "class") continue;
    const relPath = sym.filePath.startsWith(repoPrefix)
      ? sym.filePath.slice(repoPrefix.length)
      : sym.filePath;
    const existing = index.get(relPath) || [];
    existing.push(sym);
    index.set(relPath, existing);
  }

  // Sort each file's symbols by startLine for binary search
  for (const syms of index.values()) {
    syms.sort((a, b) => a.startLine - b.startLine);
  }

  return index;
}

/**
 * Find the containing function for a given line number in a file.
 * Uses the index built by buildContainingFunctionIndex.
 */
export function findContainingFunction(
  index: Map<string, ParsedSymbol[]>,
  relativePath: string,
  line: number // 0-indexed (SCIP convention)
): ParsedSymbol | null {
  const syms = index.get(relativePath);
  if (!syms) return null;

  // Convert from 0-indexed (SCIP) to 1-indexed (ParsedSymbol)
  const line1 = line + 1;

  // Find the innermost function containing this line
  let best: ParsedSymbol | null = null;
  for (const sym of syms) {
    if (sym.startLine <= line1 && sym.endLine >= line1) {
      // Prefer the innermost (smallest range) function
      if (!best || (sym.endLine - sym.startLine) < (best.endLine - best.startLine)) {
        best = sym;
      }
    }
  }
  return best;
}
