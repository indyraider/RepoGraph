import { parseLockfiles, ParsedDependency } from "./lockfile.js";
import { fetchPackageExports, PackageExportSymbol, clearTypesCache } from "./types-fetcher.js";

export interface IndexedPackage {
  name: string;
  version: string;
  registry: string;
  exports: PackageExportSymbol[];
}

/**
 * Index all direct dependencies for a repository.
 * Parses lockfiles to find deps, then fetches type definitions for npm packages.
 */
export async function indexDependencies(
  repoPath: string,
  onProgress?: (msg: string) => void
): Promise<IndexedPackage[]> {
  clearTypesCache();

  // Parse lockfiles to get direct dependencies
  const deps = await parseLockfiles(repoPath);
  onProgress?.(`Found ${deps.length} direct dependencies`);

  if (deps.length === 0) return [];

  const indexed: IndexedPackage[] = [];

  // Only fetch types for npm packages (TS type definitions are the most reliable)
  const npmDeps = deps.filter((d) => d.registry === "npm");
  const otherDeps = deps.filter((d) => d.registry !== "npm");

  // Process npm packages — fetch types in parallel with concurrency limit
  const CONCURRENCY = 5;
  for (let i = 0; i < npmDeps.length; i += CONCURRENCY) {
    const batch = npmDeps.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (dep) => {
        onProgress?.(`Fetching types for ${dep.name}@${dep.version}`);
        const exports = await fetchPackageExports(dep.name, dep.version);
        return { ...dep, exports };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        indexed.push(result.value);
      } else {
        // On failure, still create the package node without exports
        const dep = batch[results.indexOf(result)];
        indexed.push({ ...dep, exports: [] });
      }
    }
  }

  // For non-npm deps, create package nodes without exports (no type fetching)
  for (const dep of otherDeps) {
    indexed.push({ ...dep, exports: [] });
  }

  onProgress?.(
    `Indexed ${indexed.length} packages, ${indexed.reduce((sum, p) => sum + p.exports.length, 0)} exported symbols`
  );

  return indexed;
}
