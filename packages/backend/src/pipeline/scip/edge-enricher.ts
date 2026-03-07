import { SymbolTableEntry } from "./symbol-table.js";
import { CallsEdge } from "./types.js";
import { DirectlyImportsEdge } from "../resolver.js";

/**
 * Enrich CALLS edges with type mismatch information.
 *
 * For each CALLS edge, check whether the callee's param types are defined.
 * If argTypes are available on the edge, compare against paramTypes to detect
 * mismatches. For v1, we do a simple count-based mismatch check (wrong number
 * of arguments) since full type compatibility checking requires a type solver.
 */
export function enrichCallsEdges(
  callsEdges: CallsEdge[],
  symbolTable: Map<string, SymbolTableEntry>
): void {
  // Build a lookup from "relPath::name" -> SymbolTableEntry for callees
  const entryByName = new Map<string, SymbolTableEntry>();
  for (const entry of symbolTable.values()) {
    const relPath = entry.parsed.filePath;
    const key = `${relPath}::${entry.parsed.name}`;
    if (!entryByName.has(key)) {
      entryByName.set(key, entry);
    }
  }

  for (const edge of callsEdges) {
    const calleeKey = `${edge.calleeFilePath}::${edge.calleeName}`;
    const calleeEntry = entryByName.get(calleeKey);
    if (!calleeEntry) continue;

    const callee = calleeEntry.parsed;

    // If the callee has paramTypes from SCIP enrichment, attach to edge
    if (callee.paramTypes && callee.paramTypes.length > 0) {
      // Check arity mismatch if edge has argTypes
      if (edge.argTypes && edge.argTypes.length !== callee.paramTypes.length) {
        edge.hasTypeMismatch = true;
        edge.typeMismatchDetail = `Expected ${callee.paramTypes.length} args (${callee.paramTypes.join(", ")}), got ${edge.argTypes.length}`;
      }
    }
  }
}

/**
 * Enrich DirectlyImportsEdge objects with resolved type information from SCIP.
 *
 * For each import edge, look up the imported symbol in the symbol table and
 * attach its resolved type signature.
 */
export function enrichDirectImports(
  directImports: DirectlyImportsEdge[],
  symbolTable: Map<string, SymbolTableEntry>
): void {
  // Build a lookup from "relPath::name" -> signatureText
  // ParsedSymbol.filePath is already relative (from ScannedFile.path)
  const signatureByName = new Map<string, string>();
  for (const entry of symbolTable.values()) {
    const key = `${entry.parsed.filePath}::${entry.parsed.name}`;
    if (entry.scip.signatureText && !signatureByName.has(key)) {
      signatureByName.set(key, entry.scip.signatureText);
    }
  }

  for (const edge of directImports) {
    if (edge.resolvedType) continue; // already set

    const key = `${edge.targetFilePath}::${edge.targetSymbolName}`;
    const sig = signatureByName.get(key);
    if (sig) {
      edge.resolvedType = sig;
    }
  }
}
