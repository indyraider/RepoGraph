import path from "path";
import fs from "fs";
import { ParsedImport, ParsedExport, ParsedSymbol, BarrelInfo } from "./parser.js";

// --- Existing types (preserved for backward compat) ---

export interface ResolvedImport {
  fromFile: string;
  toFile: string | null; // null = external package
  toPackage: string | null; // non-null = external package
  symbols: string[];
  defaultImport: string | null;
}

// --- New types for name resolution ---

export type ResolutionStatus = "resolved" | "external" | "unresolvable" | "dynamic";

export interface EnrichedResolvedImport extends ResolvedImport {
  resolutionStatus: ResolutionStatus;
  resolvedPath: string | null;    // canonical path after alias expansion + barrel unwinding
  barrelHops: number;
  unresolvedSymbols: string[];
}

export interface DirectlyImportsEdge {
  fromFile: string;           // importing file path
  targetSymbolName: string;   // symbol name in target file
  targetFilePath: string;     // file where symbol is defined
  importKind: "named" | "default" | "namespace";
  alias?: string;             // namespace alias for import * as x
  resolvedType?: string;      // SCIP: resolved type of imported symbol
}

export interface ResolveResult {
  imports: EnrichedResolvedImport[];
  directImports: DirectlyImportsEdge[];
  stats: {
    total: number;
    resolved: number;
    external: number;
    unresolvable: number;
    dynamic: number;
    unresolvedSymbols: number;
    barrelCycles: number;
    barrelDepthExceeded: number;
  };
}

// --- tsconfig parsing with extends chain support ---

interface TsConfigPaths {
  baseUrl: string;
  paths: Record<string, string[]>;
}

function stripJsonComments(raw: string): string {
  return raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function loadTsConfig(repoPath: string, visited?: Set<string>): TsConfigPaths | null {
  const tsconfigPath = path.join(repoPath, "tsconfig.json");
  return loadTsConfigFromPath(tsconfigPath, repoPath, visited || new Set());
}

function loadTsConfigFromPath(
  configPath: string,
  repoPath: string,
  visited: Set<string>
): TsConfigPaths | null {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) return null;
  if (visited.has(resolved)) return null; // cycle in extends chain
  visited.add(resolved);

  try {
    const raw = fs.readFileSync(resolved, "utf-8");
    const config = JSON.parse(stripJsonComments(raw));
    const compilerOptions = config.compilerOptions || {};

    // Start with this config's values
    let result: TsConfigPaths = {
      baseUrl: compilerOptions.baseUrl || ".",
      paths: compilerOptions.paths || {},
    };

    // Follow extends chain — parent values are overridden by child
    if (config.extends) {
      const extendsPath = path.resolve(path.dirname(resolved), config.extends);
      // Try with .json extension if not specified
      const parentPath = fs.existsSync(extendsPath) ? extendsPath
        : fs.existsSync(extendsPath + ".json") ? extendsPath + ".json"
        : extendsPath;

      const parent = loadTsConfigFromPath(parentPath, repoPath, visited);
      if (parent) {
        // Merge: child values take precedence
        result = {
          baseUrl: compilerOptions.baseUrl || parent.baseUrl,
          paths: { ...parent.paths, ...result.paths },
        };
      }
    }

    return result;
  } catch {
    return null;
  }
}

// --- Path resolution ---

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_FILES = TS_EXTENSIONS.map((ext) => `index${ext}`);

function resolveRelativePath(
  fromFile: string,
  importSource: string,
  repoPath: string
): string | null {
  const fromDir = path.dirname(path.join(repoPath, fromFile));
  const candidate = path.resolve(fromDir, importSource);

  // Try exact (already has extension)
  if (fs.existsSync(candidate)) {
    return path.relative(repoPath, candidate);
  }

  // Try appending extensions
  for (const ext of TS_EXTENSIONS) {
    const full = candidate + ext;
    if (fs.existsSync(full)) {
      return path.relative(repoPath, full);
    }
  }

  // TypeScript convention: imports use .js but files are .ts/.tsx
  // Strip .js/.mjs/.cjs and try .ts/.tsx equivalents
  const jsExtMatch = candidate.match(/\.(js|mjs|cjs)$/);
  if (jsExtMatch) {
    const stripped = candidate.slice(0, -jsExtMatch[0].length);
    for (const ext of TS_EXTENSIONS) {
      const full = stripped + ext;
      if (fs.existsSync(full)) {
        return path.relative(repoPath, full);
      }
    }
  }

  // Try as directory with index file
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    for (const idx of INDEX_FILES) {
      const full = path.join(candidate, idx);
      if (fs.existsSync(full)) {
        return path.relative(repoPath, full);
      }
    }
  }

  return null;
}

function resolveAliasPath(
  importSource: string,
  tsConfig: TsConfigPaths,
  repoPath: string
): string | null {
  for (const [pattern, replacements] of Object.entries(tsConfig.paths)) {
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, "(.*)") + "$"
    );
    const match = importSource.match(regex);

    if (match) {
      for (const replacement of replacements) {
        const resolved = replacement.replace(/\*/g, match[1] || "");
        const fullPath = path.join(repoPath, tsConfig.baseUrl, resolved);

        if (fs.existsSync(fullPath)) {
          return path.relative(repoPath, fullPath);
        }

        for (const ext of TS_EXTENSIONS) {
          const withExt = fullPath + ext;
          if (fs.existsSync(withExt)) {
            return path.relative(repoPath, withExt);
          }
        }

        // Strip .js/.mjs/.cjs and try .ts/.tsx equivalents
        const jsMatch = fullPath.match(/\.(js|mjs|cjs)$/);
        if (jsMatch) {
          const stripped = fullPath.slice(0, -jsMatch[0].length);
          for (const ext of TS_EXTENSIONS) {
            const withExt = stripped + ext;
            if (fs.existsSync(withExt)) {
              return path.relative(repoPath, withExt);
            }
          }
        }

        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
          for (const idx of INDEX_FILES) {
            const withIdx = path.join(fullPath, idx);
            if (fs.existsSync(withIdx)) {
              return path.relative(repoPath, withIdx);
            }
          }
        }
      }
    }
  }
  return null;
}

// Resolve an import source path (could be relative or aliased) from a barrel file context
function resolveSourcePath(
  source: string,
  fromFile: string,
  repoPath: string,
  tsConfig: TsConfigPaths | null
): string | null {
  if (source.startsWith("./") || source.startsWith("../")) {
    return resolveRelativePath(fromFile, source, repoPath);
  }
  if (tsConfig) {
    return resolveAliasPath(source, tsConfig, repoPath);
  }
  return null;
}

function isRelativeImport(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

function isBareSpecifier(source: string): boolean {
  return !source.startsWith(".") && !source.startsWith("/");
}

function extractPackageName(source: string): string {
  if (source.startsWith("@")) {
    const parts = source.split("/");
    return parts.slice(0, 2).join("/");
  }
  return source.split("/")[0];
}

// --- Barrel unwinding ---

const MAX_BARREL_DEPTH = 10;

interface UnwindResult {
  terminalPath: string;
  barrelHops: number;
  flag?: "barrel_depth_exceeded" | "barrel_cycle";
}

function unwindBarrel(
  filePath: string,
  importedSymbols: string[],
  barrelMap: Map<string, BarrelInfo>,
  exportsMap: Map<string, ParsedExport[]>,
  repoPath: string,
  tsConfig: TsConfigPaths | null,
  memo: Map<string, UnwindResult>,
  visited?: Set<string>,
  depth?: number
): UnwindResult {
  const currentDepth = depth || 0;
  const currentVisited = visited || new Set<string>();

  // Memo key includes symbols to avoid collisions when different symbols resolve to different targets
  const memoKey = `${filePath}:${importedSymbols.sort().join(",")}`;
  const cached = memo.get(memoKey);
  if (cached) return cached;

  // Check termination conditions
  if (currentDepth >= MAX_BARREL_DEPTH) {
    return { terminalPath: filePath, barrelHops: currentDepth, flag: "barrel_depth_exceeded" };
  }
  if (currentVisited.has(filePath)) {
    return { terminalPath: filePath, barrelHops: currentDepth, flag: "barrel_cycle" };
  }
  currentVisited.add(filePath);

  const barrel = barrelMap.get(filePath);
  if (!barrel) {
    // Not a barrel — this is the terminal file
    const result: UnwindResult = { terminalPath: filePath, barrelHops: currentDepth };
    memo.set(memoKey, result);
    return result;
  }

  // For each requested symbol, find which re-export provides it
  for (const reExport of barrel.reExports) {
    let providesRequestedSymbol = false;

    if (reExport.isWildcard) {
      // Wildcard: export * from '...' — need to check if target file exports the symbol
      const targetPath = resolveSourcePath(reExport.source, filePath, repoPath, tsConfig);
      if (!targetPath) continue;

      const targetExports = exportsMap.get(targetPath) || [];
      const targetExportNames = new Set(targetExports.map((e) => e.symbolName));
      providesRequestedSymbol = importedSymbols.some((s) => targetExportNames.has(s));

      // Also check if target is itself a barrel that might provide the symbols
      if (!providesRequestedSymbol && barrelMap.has(targetPath)) {
        providesRequestedSymbol = true; // Optimistic — follow the chain
      }

      if (providesRequestedSymbol) {
        const result = unwindBarrel(
          targetPath, importedSymbols, barrelMap, exportsMap, repoPath, tsConfig, memo, currentVisited, currentDepth + 1
        );
        memo.set(memoKey, result);
        return result;
      }
    } else {
      // Named re-export: export { X, Y } from '...'
      const reExportedNames = new Set(reExport.symbols);
      providesRequestedSymbol = importedSymbols.some((s) => reExportedNames.has(s));

      if (providesRequestedSymbol) {
        const targetPath = resolveSourcePath(reExport.source, filePath, repoPath, tsConfig);
        if (!targetPath) continue;

        const result = unwindBarrel(
          targetPath, importedSymbols, barrelMap, exportsMap, repoPath, tsConfig, memo, currentVisited, currentDepth + 1
        );
        memo.set(memoKey, result);
        return result;
      }
    }
  }

  // If we're in a hybrid barrel and the symbol is locally defined, terminal is this file
  if (barrel.kind === "hybrid") {
    const localExports = exportsMap.get(filePath) || [];
    const localNames = new Set(localExports.map((e) => e.symbolName));
    if (importedSymbols.some((s) => localNames.has(s))) {
      const result: UnwindResult = { terminalPath: filePath, barrelHops: currentDepth };
      memo.set(memoKey, result);
      return result;
    }
  }

  // Could not follow any re-export chain — terminal is this file
  const result: UnwindResult = { terminalPath: filePath, barrelHops: currentDepth };
  memo.set(memoKey, result);
  return result;
}

// --- Symbol resolution ---

interface SymbolMatch {
  symbolName: string;
  kind: "function" | "class" | "type" | "constant";
  importKind: "named" | "default" | "namespace";
  targetFilePath: string;
}

interface SymbolResolutionResult {
  matched: SymbolMatch[];
  unresolved: string[];
}

function resolveSymbols(
  terminalPath: string,
  importedSymbols: string[],
  defaultImport: string | null,
  exportsMap: Map<string, ParsedExport[]>,
  symbolsMap: Map<string, ParsedSymbol[]>
): SymbolResolutionResult {
  const matched: SymbolMatch[] = [];
  const unresolved: string[] = [];

  const fileExports = exportsMap.get(terminalPath) || [];
  const fileSymbols = symbolsMap.get(terminalPath) || [];
  const exportNames = new Set(fileExports.map((e) => e.symbolName));
  const symbolsByName = new Map(fileSymbols.map((s) => [s.name, s]));

  // Named imports
  for (const symName of importedSymbols) {
    // Skip namespace imports (handled separately)
    if (symName.startsWith("* as ")) continue;

    if (exportNames.has(symName)) {
      const sym = symbolsByName.get(symName);
      if (sym) {
        matched.push({
          symbolName: symName,
          kind: sym.kind,
          importKind: "named",
          targetFilePath: terminalPath,
        });
      } else {
        // Exported but no symbol node (e.g. re-export, type-only, or parser missed it)
        unresolved.push(symName);
      }
    } else {
      unresolved.push(symName);
    }
  }

  // Default import
  if (defaultImport) {
    const defaultExport = fileExports.find((e) => e.isDefault);
    if (defaultExport) {
      const sym = symbolsByName.get(defaultExport.symbolName);
      if (sym) {
        matched.push({
          symbolName: defaultExport.symbolName,
          kind: sym.kind,
          importKind: "default",
          targetFilePath: terminalPath,
        });
      } else {
        unresolved.push(defaultImport);
      }
    } else {
      unresolved.push(defaultImport);
    }
  }

  // Namespace imports: import * as X — record but don't create individual edges
  // (resolved lazily if CALLS edges later reference X.something)

  return { matched, unresolved };
}

// --- Node builtins ---

const NODE_BUILTINS = new Set([
  "fs", "path", "url", "crypto", "http", "https", "stream", "util", "os",
  "child_process", "events", "buffer", "querystring", "assert", "net",
  "tls", "dns", "zlib",
]);

// --- Rust standard library crates ---

const RUST_STD_CRATES = new Set([
  "std", "core", "alloc", "collections", "proc_macro",
]);

// --- Rust module resolution ---

function findCrateRoot(filePath: string, repoPath: string): string {
  // Walk up from the file looking for Cargo.toml to find crate root
  let dir = path.dirname(path.join(repoPath, filePath));
  while (dir.startsWith(repoPath) && dir.length >= repoPath.length) {
    if (fs.existsSync(path.join(dir, "Cargo.toml"))) {
      // Crate root is the src/ directory inside this Cargo.toml's directory
      const srcDir = path.join(dir, "src");
      if (fs.existsSync(srcDir)) {
        return path.relative(repoPath, srcDir);
      }
      return path.relative(repoPath, dir);
    }
    dir = path.dirname(dir);
  }
  // Fallback: assume src/ at repo root
  return "src";
}

function resolveRustModulePath(
  modulePath: string,
  fromFile: string,
  repoPath: string
): string | null {
  const segments = modulePath.split("::");
  const firstSegment = segments[0];

  let basePath: string;

  if (firstSegment === "crate") {
    // use crate::foo::bar → resolve from crate root (src/)
    const crateRoot = findCrateRoot(fromFile, repoPath);
    basePath = path.join(repoPath, crateRoot);
    segments.shift(); // remove "crate"
  } else if (firstSegment === "super") {
    // use super::foo → resolve from parent module
    basePath = path.dirname(path.join(repoPath, fromFile));
    // If we're in foo/mod.rs, super goes up one more level
    if (path.basename(fromFile) === "mod.rs" || path.basename(fromFile) === "lib.rs") {
      basePath = path.dirname(basePath);
    }
    segments.shift(); // remove "super"
    // Handle multiple super:: prefixes
    while (segments[0] === "super") {
      basePath = path.dirname(basePath);
      segments.shift();
    }
  } else if (firstSegment === "self") {
    // use self::foo → resolve from current module directory
    basePath = path.dirname(path.join(repoPath, fromFile));
    if (path.basename(fromFile) !== "mod.rs" && path.basename(fromFile) !== "lib.rs") {
      // If we're in foo.rs, self:: refers to foo.rs itself (sibling-level)
      basePath = path.dirname(basePath);
    }
    segments.shift(); // remove "self"
  } else {
    // External crate: use tokio::spawn → external
    return null;
  }

  if (segments.length === 0) return null;

  // Walk the remaining segments as module path
  // The last segment might be a type/function (not a module), so we try
  // resolving with and without the last segment as a directory
  let currentPath = basePath;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;

    // Try as file: segment.rs
    const asFile = path.join(currentPath, segment + ".rs");
    if (fs.existsSync(asFile)) {
      return path.relative(repoPath, asFile);
    }

    // Try as directory module: segment/mod.rs
    const asMod = path.join(currentPath, segment, "mod.rs");
    if (fs.existsSync(asMod)) {
      if (isLast) {
        return path.relative(repoPath, asMod);
      }
      currentPath = path.join(currentPath, segment);
      continue;
    }

    // If not last segment and directory exists, continue traversing
    const asDir = path.join(currentPath, segment);
    if (!isLast && fs.existsSync(asDir)) {
      currentPath = asDir;
      continue;
    }

    // Last segment might be a symbol name inside the previously resolved module
    // This is fine — the file path is the parent module
    if (isLast && i > 0) {
      // Return the module file we resolved up to the previous segment
      return null; // symbol in an already-resolved module
    }

    return null;
  }

  return null;
}

function resolveRustImport(
  imp: ParsedImport,
  repoPath: string,
  exportsMap: Map<string, ParsedExport[]>,
  symbolsMap: Map<string, ParsedSymbol[]>,
  enrichedImports: EnrichedResolvedImport[],
  directImports: DirectlyImportsEdge[],
  stats: ResolveResult["stats"]
): void {
  const { source, symbols, defaultImport, filePath } = imp;
  stats.total++;

  // Skip standard library imports
  const firstSegment = source.split("::")[0];
  if (RUST_STD_CRATES.has(firstSegment)) {
    return;
  }

  // Handle mod declarations (source is just a module name like "config")
  if (defaultImport && symbols.length === 0 && !source.includes("::")) {
    // mod foo; → try foo.rs or foo/mod.rs relative to current file
    const fromDir = path.dirname(path.join(repoPath, filePath));
    const asFile = path.join(fromDir, source + ".rs");
    const asMod = path.join(fromDir, source, "mod.rs");

    let resolved: string | null = null;
    if (fs.existsSync(asFile)) {
      resolved = path.relative(repoPath, asFile);
    } else if (fs.existsSync(asMod)) {
      resolved = path.relative(repoPath, asMod);
    }

    if (resolved) {
      stats.resolved++;
      enrichedImports.push({
        fromFile: filePath, toFile: resolved, toPackage: null,
        symbols, defaultImport,
        resolutionStatus: "resolved", resolvedPath: resolved, barrelHops: 0, unresolvedSymbols: [],
      });
    }
    return;
  }

  // Try to resolve use crate::/super::/self:: paths
  if (firstSegment === "crate" || firstSegment === "super" || firstSegment === "self") {
    const resolved = resolveRustModulePath(source, filePath, repoPath);
    if (resolved) {
      stats.resolved++;
      enrichedImports.push({
        fromFile: filePath, toFile: resolved, toPackage: null,
        symbols, defaultImport,
        resolutionStatus: "resolved", resolvedPath: resolved, barrelHops: 0, unresolvedSymbols: [],
      });

      // Create DirectlyImportsEdge for named imports
      for (const symName of symbols) {
        if (symName === "*") continue;
        const fileSymbols = symbolsMap.get(resolved) || [];
        const match = fileSymbols.find((s) => s.name === symName);
        if (match) {
          directImports.push({
            fromFile: filePath,
            targetSymbolName: symName,
            targetFilePath: resolved,
            importKind: "named",
          });
        }
      }
      return;
    }
  }

  // External crate import
  const crateName = firstSegment;
  stats.external++;
  enrichedImports.push({
    fromFile: filePath, toFile: null, toPackage: crateName,
    symbols, defaultImport,
    resolutionStatus: "external", resolvedPath: null, barrelHops: 0, unresolvedSymbols: [],
  });
}

// --- JVM (Java/Kotlin) standard library packages ---

const JVM_STD_PACKAGES = new Set([
  "java", "javax", "kotlin", "kotlinx", "android", "dalvik",
  "sun", "com.sun", "org.xml", "org.w3c",
]);

// --- JVM source root detection ---

const JVM_SOURCE_ROOTS = [
  "src/main/java",
  "src/main/kotlin",
  "src/test/java",
  "src/test/kotlin",
  "app/src/main/java",
  "app/src/main/kotlin",
  "src",
];

function findJvmSourceRoots(repoPath: string): string[] {
  const roots: string[] = [];
  for (const root of JVM_SOURCE_ROOTS) {
    const fullPath = path.join(repoPath, root);
    if (fs.existsSync(fullPath)) {
      roots.push(root);
    }
  }
  return roots.length > 0 ? roots : ["src"];
}

// --- JVM import resolution ---

function resolveJvmImport(
  imp: ParsedImport,
  repoPath: string,
  sourceRoots: string[],
  exportsMap: Map<string, ParsedExport[]>,
  symbolsMap: Map<string, ParsedSymbol[]>,
  enrichedImports: EnrichedResolvedImport[],
  directImports: DirectlyImportsEdge[],
  stats: ResolveResult["stats"]
): void {
  const { source, symbols, defaultImport, filePath } = imp;
  stats.total++;

  // Skip standard library imports
  const topPackage = source.split(".")[0];
  const twoSegment = source.split(".").slice(0, 2).join(".");
  if (JVM_STD_PACKAGES.has(topPackage) || JVM_STD_PACKAGES.has(twoSegment)) {
    return;
  }

  // Wildcard imports (import com.example.*) — can't resolve to single file
  if (symbols.length === 1 && symbols[0] === "*") {
    stats.unresolvable++;
    enrichedImports.push({
      fromFile: filePath, toFile: null, toPackage: source,
      symbols, defaultImport,
      resolutionStatus: "unresolvable", resolvedPath: null, barrelHops: 0, unresolvedSymbols: symbols,
    });
    return;
  }

  // Convert package path to directory path: com.example.Foo → com/example/Foo
  const packageDirPath = source.replace(/\./g, "/");
  const symbolName = symbols[0] || "";

  // Try to find the file in source roots
  for (const root of sourceRoots) {
    // Try as direct class file: com/example/Foo.java or .kt
    for (const ext of [".java", ".kt"]) {
      const candidatePath = path.join(root, packageDirPath, symbolName + ext);
      const fullPath = path.join(repoPath, candidatePath);
      if (fs.existsSync(fullPath)) {
        stats.resolved++;
        enrichedImports.push({
          fromFile: filePath, toFile: candidatePath, toPackage: null,
          symbols, defaultImport,
          resolutionStatus: "resolved", resolvedPath: candidatePath, barrelHops: 0, unresolvedSymbols: [],
        });

        // Create DirectlyImportsEdge
        const fileSymbols = symbolsMap.get(candidatePath) || [];
        const match = fileSymbols.find((s) => s.name === symbolName);
        if (match) {
          directImports.push({
            fromFile: filePath,
            targetSymbolName: symbolName,
            targetFilePath: candidatePath,
            importKind: "named",
          });
        }
        return;
      }
    }

    // Try the symbol as a nested class: source path includes the class
    // e.g., import com.example.Outer.Inner → com/example/Outer.java
    const parts = source.split(".");
    for (let i = parts.length - 1; i >= 1; i--) {
      const packagePart = parts.slice(0, i).join("/");
      const className = parts[i];
      for (const ext of [".java", ".kt"]) {
        const candidatePath = path.join(root, packagePart, className + ext);
        const fullPath = path.join(repoPath, candidatePath);
        if (fs.existsSync(fullPath)) {
          stats.resolved++;
          enrichedImports.push({
            fromFile: filePath, toFile: candidatePath, toPackage: null,
            symbols, defaultImport,
            resolutionStatus: "resolved", resolvedPath: candidatePath, barrelHops: 0, unresolvedSymbols: [],
          });
          return;
        }
      }
    }
  }

  // Could not find in source — mark as external package
  const packageName = source.split(".").slice(0, 2).join(".");
  stats.external++;
  enrichedImports.push({
    fromFile: filePath, toFile: null, toPackage: packageName,
    symbols, defaultImport,
    resolutionStatus: "external", resolvedPath: null, barrelHops: 0, unresolvedSymbols: [],
  });
}

// --- Main resolve function ---

export function resolveImports(
  parsedImports: ParsedImport[],
  repoPath: string,
  allExports?: ParsedExport[],
  allSymbols?: ParsedSymbol[],
  barrelMap?: Map<string, BarrelInfo>
): ResolveResult {
  const tsConfig = loadTsConfig(repoPath);

  // Build lookup maps for symbol resolution
  const exportsMap = new Map<string, ParsedExport[]>();
  const symbolsMap = new Map<string, ParsedSymbol[]>();

  if (allExports) {
    for (const exp of allExports) {
      const list = exportsMap.get(exp.filePath) || [];
      list.push(exp);
      exportsMap.set(exp.filePath, list);
    }
  }

  if (allSymbols) {
    for (const sym of allSymbols) {
      const list = symbolsMap.get(sym.filePath) || [];
      list.push(sym);
      symbolsMap.set(sym.filePath, list);
    }
  }

  const barrels = barrelMap || new Map<string, BarrelInfo>();
  const barrelMemo = new Map<string, UnwindResult>();

  const enrichedImports: EnrichedResolvedImport[] = [];
  const directImports: DirectlyImportsEdge[] = [];
  const stats = {
    total: 0,
    resolved: 0,
    external: 0,
    unresolvable: 0,
    dynamic: 0,
    unresolvedSymbols: 0,
    barrelCycles: 0,
    barrelDepthExceeded: 0,
  };

  const jvmSourceRoots = findJvmSourceRoots(repoPath);

  for (const imp of parsedImports) {
    const { source, symbols, defaultImport, filePath } = imp;

    // Dispatch Rust files to the Rust-specific resolver
    if (filePath.endsWith(".rs")) {
      resolveRustImport(imp, repoPath, exportsMap, symbolsMap, enrichedImports, directImports, stats);
      continue;
    }

    // Dispatch Java/Kotlin files to the JVM-specific resolver
    if (filePath.endsWith(".java") || filePath.endsWith(".kt")) {
      resolveJvmImport(imp, repoPath, jvmSourceRoots, exportsMap, symbolsMap, enrichedImports, directImports, stats);
      continue;
    }

    stats.total++;

    // Skip Node built-ins
    if (source.startsWith("node:") || NODE_BUILTINS.has(source)) {
      continue;
    }

    // Detect dynamic imports (template literals or expressions in source)
    if (source.includes("${") || source.includes("`")) {
      enrichedImports.push({
        fromFile: filePath, toFile: null, toPackage: null,
        symbols, defaultImport,
        resolutionStatus: "dynamic", resolvedPath: null, barrelHops: 0, unresolvedSymbols: [],
      });
      stats.dynamic++;
      continue;
    }

    let toFile: string | null = null;
    let toPackage: string | null = null;
    let resolutionStatus: ResolutionStatus = "unresolvable";

    if (isRelativeImport(source)) {
      toFile = resolveRelativePath(filePath, source, repoPath);
      if (toFile) {
        resolutionStatus = "resolved";
      } else {
        stats.unresolvable++;
        enrichedImports.push({
          fromFile: filePath, toFile: null, toPackage: null,
          symbols, defaultImport,
          resolutionStatus: "unresolvable", resolvedPath: null, barrelHops: 0,
          unresolvedSymbols: symbols,
        });
        continue;
      }
    } else if (isBareSpecifier(source)) {
      if (tsConfig) {
        toFile = resolveAliasPath(source, tsConfig, repoPath);
      }
      if (!toFile) {
        toPackage = extractPackageName(source);
        resolutionStatus = "external";
        stats.external++;
        enrichedImports.push({
          fromFile: filePath, toFile: null, toPackage,
          symbols, defaultImport,
          resolutionStatus: "external", resolvedPath: null, barrelHops: 0, unresolvedSymbols: [],
        });
        continue;
      }
      resolutionStatus = "resolved";
    } else {
      toFile = resolveRelativePath(filePath, source, repoPath);
      if (toFile) {
        resolutionStatus = "resolved";
      } else {
        stats.unresolvable++;
        enrichedImports.push({
          fromFile: filePath, toFile: null, toPackage: null,
          symbols, defaultImport,
          resolutionStatus: "unresolvable", resolvedPath: null, barrelHops: 0,
          unresolvedSymbols: symbols,
        });
        continue;
      }
    }

    // --- Pass 1: Barrel unwinding ---
    let resolvedPath = toFile!;
    let barrelHops = 0;
    let barrelFlag: string | undefined;

    // Filter out namespace import notation for barrel symbol matching
    const namedSymbols = symbols.filter((s) => !s.startsWith("* as "));
    const symbolsToFind = defaultImport
      ? [...namedSymbols, defaultImport]
      : namedSymbols;

    if (symbolsToFind.length > 0 && barrels.has(toFile!)) {
      const unwindResult = unwindBarrel(
        toFile!, symbolsToFind, barrels, exportsMap, repoPath, tsConfig, barrelMemo
      );
      resolvedPath = unwindResult.terminalPath;
      barrelHops = unwindResult.barrelHops;
      barrelFlag = unwindResult.flag;

      if (barrelFlag === "barrel_cycle") stats.barrelCycles++;
      if (barrelFlag === "barrel_depth_exceeded") stats.barrelDepthExceeded++;
    }

    // --- Pass 2: Symbol resolution ---
    let unresolvedSymbols: string[] = [];

    if (allExports && allSymbols && (namedSymbols.length > 0 || defaultImport)) {
      const symResult = resolveSymbols(
        resolvedPath, namedSymbols, defaultImport, exportsMap, symbolsMap
      );

      for (const match of symResult.matched) {
        directImports.push({
          fromFile: filePath,
          targetSymbolName: match.symbolName,
          targetFilePath: match.targetFilePath,
          importKind: match.importKind,
        });
      }

      unresolvedSymbols = symResult.unresolved;
      stats.unresolvedSymbols += unresolvedSymbols.length;

      // Handle namespace imports — record alias on the edge
      for (const sym of symbols) {
        if (sym.startsWith("* as ")) {
          const alias = sym.slice(5); // "* as X" → "X"
          directImports.push({
            fromFile: filePath,
            targetSymbolName: alias,
            targetFilePath: resolvedPath,
            importKind: "namespace",
            alias,
          });
        }
      }
    }

    stats.resolved++;
    enrichedImports.push({
      fromFile: filePath,
      toFile: toFile!,
      toPackage: null,
      symbols,
      defaultImport,
      resolutionStatus,
      resolvedPath,
      barrelHops,
      unresolvedSymbols,
    });
  }

  return { imports: enrichedImports, directImports, stats };
}
