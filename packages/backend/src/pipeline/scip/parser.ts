import fs from "fs";

// Import SCIP protobuf classes from scip-typescript's bundled module.
// This is a CommonJS module using google-protobuf, imported via createRequire.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { scip } = require("@sourcegraph/scip-typescript/dist/src/scip.js");

/** Parsed symbol info from the SCIP index. */
export interface ScipSymbolInfo {
  /** Fully qualified SCIP symbol identifier. */
  symbol: string;
  /** Documentation strings (hover info). */
  documentation: string[];
  /** Resolved type signature text (e.g. "(order: Order) => Promise<Result>"). */
  signatureText: string | null;
  /** Relationships to other symbols (implements, overrides). */
  relationships: Array<{
    symbol: string;
    isImplementation: boolean;
    isReference: boolean;
    isTypeDefinition: boolean;
  }>;
}

/** Parsed occurrence from the SCIP index. */
export interface ScipOccurrence {
  /** SCIP symbol identifier this occurrence refers to. */
  symbol: string;
  /** [startLine, startChar, endLine, endChar] — 0-indexed. */
  range: [number, number, number, number];
  /** Bitmask of symbol roles (Definition=1, Import=2, etc). */
  symbolRoles: number;
}

/** Parsed diagnostic from the SCIP index. */
export interface ScipDiagnostic {
  severity: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
  code: string;
  message: string;
  /** [startLine, startChar, endLine, endChar] — 0-indexed. */
  range: [number, number, number, number];
}

/** All data extracted from one SCIP document (one file). */
export interface ScipDocument {
  relativePath: string;
  symbols: ScipSymbolInfo[];
  occurrences: ScipOccurrence[];
  diagnostics: ScipDiagnostic[];
}

/** Result of parsing the entire SCIP index. */
export interface ScipIndexData {
  documents: ScipDocument[];
  externalSymbols: ScipSymbolInfo[];
}

// SCIP SymbolRole bitmask values
export const SymbolRole = {
  Definition: 1,
  Import: 2,
  WriteAccess: 4,
  ReadAccess: 8,
} as const;

/**
 * Parse a binary .scip index file and return structured data.
 * Throws if the file doesn't exist. Returns empty data for 0-byte files.
 */
export function parseScipIndex(indexPath: string): ScipIndexData {
  if (!fs.existsSync(indexPath)) {
    throw new Error(`SCIP index file not found: ${indexPath}`);
  }
  if (fs.statSync(indexPath).size === 0) {
    return { documents: [], externalSymbols: [] };
  }

  const buffer = fs.readFileSync(indexPath);
  const index = scip.Index.deserializeBinary(new Uint8Array(buffer));

  const documents: ScipDocument[] = [];

  for (const doc of index.documents) {
    const relativePath: string = doc.relative_path;

    const symbols: ScipSymbolInfo[] = (doc.symbols || []).map((sym: any) => ({
      symbol: sym.symbol,
      documentation: sym.documentation || [],
      signatureText: sym.signature_documentation?.text || null,
      relationships: (sym.relationships || []).map((rel: any) => ({
        symbol: rel.symbol,
        isImplementation: rel.is_implementation || false,
        isReference: rel.is_reference || false,
        isTypeDefinition: rel.is_type_definition || false,
      })),
    }));

    const occurrences: ScipOccurrence[] = (doc.occurrences || []).map(
      (occ: any) => {
        const range = occ.range || [];
        // SCIP ranges can be 3 elements [line, startChar, endChar] (single line)
        // or 4 elements [startLine, startChar, endLine, endChar]
        const normalizedRange: [number, number, number, number] =
          range.length === 3
            ? [range[0], range[1], range[0], range[2]]
            : [range[0], range[1], range[2], range[3]];

        return {
          symbol: occ.symbol,
          range: normalizedRange,
          symbolRoles: occ.symbol_roles || 0,
        };
      }
    );

    // Diagnostics are on Occurrence objects in scip-typescript
    const diagnostics: ScipDiagnostic[] = [];
    for (const occ of doc.occurrences || []) {
      for (const diag of occ.diagnostics || []) {
        const dRange = occ.range || [];
        const normalizedRange: [number, number, number, number] =
          dRange.length === 3
            ? [dRange[0], dRange[1], dRange[0], dRange[2]]
            : [dRange[0], dRange[1], dRange[2], dRange[3]];
        diagnostics.push({
          severity: diag.severity ?? 0,
          code: diag.code || "",
          message: diag.message || "",
          range: normalizedRange,
        });
      }
    }

    documents.push({ relativePath, symbols, occurrences, diagnostics });
  }

  // External symbols (symbols defined outside the indexed project)
  const externalSymbols: ScipSymbolInfo[] = (index.external_symbols || []).map(
    (sym: any) => ({
      symbol: sym.symbol,
      documentation: sym.documentation || [],
      signatureText: sym.signature_documentation?.text || null,
      relationships: (sym.relationships || []).map((rel: any) => ({
        symbol: rel.symbol,
        isImplementation: rel.is_implementation || false,
        isReference: rel.is_reference || false,
        isTypeDefinition: rel.is_type_definition || false,
      })),
    })
  );

  return { documents, externalSymbols };
}

/**
 * Extract the file path and symbol name from a SCIP symbol identifier.
 *
 * SCIP symbol formats vary by indexer but share a common structure:
 *   <indexer> <manager> <package> <version> <path>`<file>`/<descriptors>
 *
 * Examples:
 *   scip-typescript npm . . src/utils/`helper.ts`/doSomething.
 *   rust-analyzer cargo <crate> <version> src/`main.rs`/process_data().
 *   scip-python python <package> <version> `module.py`/MyClass#method().
 *   scip-java maven <group:artifact> <version> src/main/java/`App.java`/MyClass#run().
 *
 * Returns null if the symbol ID can't be parsed.
 */
export function parseScipSymbolId(
  symbolId: string
): { filePath: string; name: string; containerName?: string } | null {
  // All SCIP symbol IDs use backtick-quoted filenames
  const backtickMatch = symbolId.match(/`([^`]+)`/);
  if (!backtickMatch) return null;

  const quotedFile = backtickMatch[1];
  const backtickStart = backtickMatch.index!;

  // Extract path prefix: everything between the last space before the backtick
  // and the backtick itself. This is more robust than counting spaces from the
  // front, since different indexers have different numbers of header tokens.
  // Find the 4th space (standard SCIP format: indexer manager package version path`file`)
  let spaceCount = 0;
  let pathStart = 0;
  for (let i = 0; i < backtickStart; i++) {
    if (symbolId[i] === " ") {
      spaceCount++;
      if (spaceCount === 4) {
        pathStart = i + 1;
        break;
      }
    }
  }

  // If we didn't find 4 spaces (some indexers use fewer tokens), fall back
  // to using everything from the last space before the backtick
  if (spaceCount < 4) {
    const lastSpace = symbolId.lastIndexOf(" ", backtickStart);
    pathStart = lastSpace >= 0 ? lastSpace + 1 : 0;
  }

  const pathPrefix = symbolId.slice(pathStart, backtickStart);
  const filePath = pathPrefix + quotedFile;

  // Get everything after the closing backtick + /
  const closingIdx = backtickStart + 1 + quotedFile.length + 1; // ` + filename + `
  const slashIdx = closingIdx; // the / after `filename`
  const afterFile = symbolId.slice(slashIdx + 1);
  if (!afterFile) return null;

  // Parse descriptor chain: Class#method(). or just name.
  const parts = afterFile.split(/(?<=[.#])/);
  const cleanParts = parts
    .map((p) => p.replace(/[.#()]/g, ""))
    .filter(Boolean);

  if (cleanParts.length === 0) return null;

  if (cleanParts.length === 1) {
    return { filePath, name: cleanParts[0] };
  }

  return {
    filePath,
    name: cleanParts[cleanParts.length - 1],
    containerName: cleanParts[0],
  };
}
