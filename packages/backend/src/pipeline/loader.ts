import { getSession } from "../db/neo4j.js";
import { getSupabase } from "../db/supabase.js";
import { ScannedFile } from "./scanner.js";
import { ParsedSymbol, ParsedExport } from "./parser.js";
import { ResolvedImport, ResolveResult, DirectlyImportsEdge } from "./resolver.js";
import { IndexedPackage } from "./deps/indexer.js";
import { CallsEdge } from "./scip/types.js";

const BATCH_SIZE = 500;

export async function loadToNeo4j(
  repoUrl: string,
  repoName: string,
  branch: string,
  commitSha: string,
  files: ScannedFile[]
): Promise<{ nodeCount: number; edgeCount: number }> {
  const session = getSession();

  try {
    // Upsert Repository node
    await session.run(
      `MERGE (r:Repository {url: $url})
       SET r.name = $name, r.branch = $branch, r.commit_sha = $commitSha,
           r.last_digest_at = datetime()`,
      { url: repoUrl, name: repoName, branch, commitSha }
    );

    // Batch insert File nodes + CONTAINS_FILE edges
    let nodeCount = 1; // repository node
    let edgeCount = 0;

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE).map((f) => ({
        path: f.path,
        language: f.language,
        size_bytes: f.sizeBytes,
        content_hash: f.contentHash,
      }));

      const result = await session.run(
        `UNWIND $files AS f
         MERGE (file:File {path: f.path, repo_url: $repoUrl})
         SET file.language = f.language,
             file.size_bytes = f.size_bytes,
             file.content_hash = f.content_hash
         WITH file
         MATCH (r:Repository {url: $repoUrl})
         MERGE (r)-[:CONTAINS_FILE]->(file)
         RETURN count(file) AS cnt`,
        { files: batch, repoUrl }
      );

      const cnt = result.records[0]?.get("cnt")?.toNumber?.() ?? batch.length;
      nodeCount += cnt;
      edgeCount += cnt; // one CONTAINS_FILE per file
    }

    return { nodeCount, edgeCount };
  } finally {
    await session.close();
  }
}

export async function loadSymbolsToNeo4j(
  repoUrl: string,
  symbols: ParsedSymbol[],
  exportsList: ParsedExport[]
): Promise<{ nodeCount: number; edgeCount: number }> {
  const session = getSession();
  let nodeCount = 0;
  let edgeCount = 0;

  try {
    // Build a set of exported symbol names per file for quick lookup
    const exportedSymbols = new Set(
      exportsList.map((e) => `${e.filePath}::${e.symbolName}`)
    );
    const defaultExports = new Set(
      exportsList.filter((e) => e.isDefault).map((e) => `${e.filePath}::${e.symbolName}`)
    );

    // Group symbols by kind for batch insertion
    const functions = symbols.filter((s) => s.kind === "function");
    const classes = symbols.filter((s) => s.kind === "class");
    const types = symbols.filter((s) => s.kind === "type");
    const constants = symbols.filter((s) => s.kind === "constant");

    // Batch insert Functions
    for (let i = 0; i < functions.length; i += BATCH_SIZE) {
      const batch = functions.slice(i, i + BATCH_SIZE).map((s) => ({
        name: s.name,
        signature: s.signature,
        docstring: s.docstring,
        start_line: s.startLine,
        end_line: s.endLine,
        file_path: s.filePath,
        repo_url: repoUrl,
        resolved_signature: s.resolvedSignature || null,
        param_types: s.paramTypes || null,
        return_type: s.returnType || null,
        is_generic: s.isGeneric || null,
        type_params: s.typeParams || null,
      }));

      await session.run(
        `UNWIND $symbols AS s
         MATCH (f:File {path: s.file_path, repo_url: s.repo_url})
         MERGE (fn:Function {name: s.name, file_path: s.file_path, repo_url: s.repo_url})
         SET fn.signature = s.signature, fn.docstring = s.docstring,
             fn.start_line = s.start_line, fn.end_line = s.end_line,
             fn.resolved_signature = s.resolved_signature,
             fn.param_types = s.param_types,
             fn.return_type = s.return_type,
             fn.is_generic = s.is_generic,
             fn.type_params = s.type_params
         MERGE (f)-[:CONTAINS]->(fn)
         RETURN count(fn) AS cnt`,
        { symbols: batch }
      );
      nodeCount += batch.length;
      edgeCount += batch.length;
    }

    // Batch insert Classes
    for (let i = 0; i < classes.length; i += BATCH_SIZE) {
      const batch = classes.slice(i, i + BATCH_SIZE).map((s) => ({
        name: s.name,
        signature: s.signature,
        docstring: s.docstring,
        start_line: s.startLine,
        end_line: s.endLine,
        file_path: s.filePath,
        repo_url: repoUrl,
        resolved_signature: s.resolvedSignature || null,
        is_generic: s.isGeneric || null,
        type_params: s.typeParams || null,
      }));

      await session.run(
        `UNWIND $symbols AS s
         MATCH (f:File {path: s.file_path, repo_url: s.repo_url})
         MERGE (c:Class {name: s.name, file_path: s.file_path, repo_url: s.repo_url})
         SET c.signature = s.signature, c.docstring = s.docstring,
             c.start_line = s.start_line, c.end_line = s.end_line,
             c.resolved_signature = s.resolved_signature,
             c.is_generic = s.is_generic,
             c.type_params = s.type_params
         MERGE (f)-[:CONTAINS]->(c)
         RETURN count(c) AS cnt`,
        { symbols: batch }
      );
      nodeCount += batch.length;
      edgeCount += batch.length;
    }

    // Batch insert TypeDefs
    for (let i = 0; i < types.length; i += BATCH_SIZE) {
      const batch = types.slice(i, i + BATCH_SIZE).map((s) => ({
        name: s.name,
        definition: s.signature,
        docstring: s.docstring,
        start_line: s.startLine,
        file_path: s.filePath,
        repo_url: repoUrl,
      }));

      await session.run(
        `UNWIND $symbols AS s
         MATCH (f:File {path: s.file_path, repo_url: s.repo_url})
         MERGE (t:TypeDef {name: s.name, file_path: s.file_path, repo_url: s.repo_url})
         SET t.definition = s.definition, t.docstring = s.docstring,
             t.start_line = s.start_line
         MERGE (f)-[:CONTAINS]->(t)
         RETURN count(t) AS cnt`,
        { symbols: batch }
      );
      nodeCount += batch.length;
      edgeCount += batch.length;
    }

    // Batch insert Constants
    for (let i = 0; i < constants.length; i += BATCH_SIZE) {
      const batch = constants.slice(i, i + BATCH_SIZE).map((s) => ({
        name: s.name,
        value_preview: s.signature,
        start_line: s.startLine,
        file_path: s.filePath,
        repo_url: repoUrl,
      }));

      await session.run(
        `UNWIND $symbols AS s
         MATCH (f:File {path: s.file_path, repo_url: s.repo_url})
         MERGE (c:Constant {name: s.name, file_path: s.file_path, repo_url: s.repo_url})
         SET c.value_preview = s.value_preview, c.start_line = s.start_line
         MERGE (f)-[:CONTAINS]->(c)
         RETURN count(c) AS cnt`,
        { symbols: batch }
      );
      nodeCount += batch.length;
      edgeCount += batch.length;
    }

    // Create EXPORTS edges
    const exportsData = exportsList.map((e) => ({
      file_path: e.filePath,
      symbol_name: e.symbolName,
      is_default: e.isDefault,
      repo_url: repoUrl,
    }));

    for (let i = 0; i < exportsData.length; i += BATCH_SIZE) {
      const batch = exportsData.slice(i, i + BATCH_SIZE);

      await session.run(
        `UNWIND $exports AS e
         MATCH (f:File {path: e.file_path, repo_url: e.repo_url})
         OPTIONAL MATCH (sym {name: e.symbol_name, file_path: e.file_path, repo_url: e.repo_url})
         WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
         WITH f, sym, e
         WHERE sym IS NOT NULL
         MERGE (f)-[r:EXPORTS]->(sym)
         SET r.is_default = e.is_default
         RETURN count(r) AS cnt`,
        { exports: batch }
      );
      edgeCount += batch.length;
    }

    return { nodeCount, edgeCount };
  } finally {
    await session.close();
  }
}

export async function loadImportsToNeo4j(
  repoUrl: string,
  resolveResult: ResolveResult | ResolvedImport[]
): Promise<number> {
  const session = getSession();
  let edgeCount = 0;

  // Support both old ResolvedImport[] and new ResolveResult for backward compat
  const imports = Array.isArray(resolveResult) ? resolveResult : resolveResult.imports;
  const directImports = Array.isArray(resolveResult) ? [] : resolveResult.directImports;

  try {
    // Internal imports: File → File (with enriched properties)
    const internalImports = imports
      .filter((imp) => imp.toFile !== null)
      .map((imp) => {
        const enriched = imp as any; // may have enriched fields
        return {
          from_path: imp.fromFile,
          to_path: imp.toFile!,
          symbols: imp.symbols,
          repo_url: repoUrl,
          resolution_status: enriched.resolutionStatus || "resolved",
          resolved_path: enriched.resolvedPath || null,
          barrel_hops: enriched.barrelHops || 0,
          unresolved_symbols: enriched.unresolvedSymbols || [],
        };
      });

    for (let i = 0; i < internalImports.length; i += BATCH_SIZE) {
      const batch = internalImports.slice(i, i + BATCH_SIZE);

      await session.run(
        `UNWIND $imports AS imp
         MATCH (from:File {path: imp.from_path, repo_url: imp.repo_url})
         MATCH (to:File {path: imp.to_path, repo_url: imp.repo_url})
         MERGE (from)-[r:IMPORTS]->(to)
         SET r.symbols = imp.symbols,
             r.resolution_status = imp.resolution_status,
             r.resolved_path = imp.resolved_path,
             r.barrel_hops = imp.barrel_hops,
             r.unresolved_symbols = imp.unresolved_symbols
         RETURN count(r) AS cnt`,
        { imports: batch }
      );
      edgeCount += batch.length;
    }

    // External imports: File → Package
    const externalImports = imports
      .filter((imp) => imp.toPackage !== null)
      .map((imp) => ({
        from_path: imp.fromFile,
        package_name: imp.toPackage!,
        symbols: imp.symbols,
        repo_url: repoUrl,
      }));

    for (let i = 0; i < externalImports.length; i += BATCH_SIZE) {
      const batch = externalImports.slice(i, i + BATCH_SIZE);

      await session.run(
        `UNWIND $imports AS imp
         MATCH (from:File {path: imp.from_path, repo_url: imp.repo_url})
         MERGE (pkg:Package {name: imp.package_name})
         MERGE (from)-[r:IMPORTS]->(pkg)
         SET r.symbols = imp.symbols
         RETURN count(r) AS cnt`,
        { imports: batch }
      );
      edgeCount += batch.length;
    }

    // DIRECTLY_IMPORTS edges: File → Symbol (new)
    if (directImports.length > 0) {
      const diData = directImports.map((di) => ({
        from_path: di.fromFile,
        symbol_name: di.targetSymbolName,
        target_file_path: di.targetFilePath,
        import_kind: di.importKind,
        alias: di.alias || null,
        resolved_type: di.resolvedType || null,
        repo_url: repoUrl,
      }));

      for (let i = 0; i < diData.length; i += BATCH_SIZE) {
        const batch = diData.slice(i, i + BATCH_SIZE);

        await session.run(
          `UNWIND $directImports AS di
           MATCH (from:File {path: di.from_path, repo_url: di.repo_url})
           OPTIONAL MATCH (sym {name: di.symbol_name, file_path: di.target_file_path, repo_url: di.repo_url})
           WHERE sym:Function OR sym:Class OR sym:TypeDef OR sym:Constant
           WITH from, sym, di
           WHERE sym IS NOT NULL
           MERGE (from)-[r:DIRECTLY_IMPORTS]->(sym)
           SET r.import_kind = di.import_kind, r.alias = di.alias,
               r.resolved_type = di.resolved_type
           RETURN count(r) AS cnt`,
          { directImports: batch }
        );
        edgeCount += batch.length;
      }
    }

    return edgeCount;
  } finally {
    await session.close();
  }
}

export async function loadDependenciesToNeo4j(
  repoUrl: string,
  packages: IndexedPackage[]
): Promise<{ nodeCount: number; edgeCount: number }> {
  const session = getSession();
  let nodeCount = 0;
  let edgeCount = 0;

  try {
    // Batch insert Package nodes + DEPENDS_ON edges
    for (let i = 0; i < packages.length; i += BATCH_SIZE) {
      const batch = packages.slice(i, i + BATCH_SIZE).map((p) => ({
        name: p.name,
        version: p.version,
        registry: p.registry,
      }));

      await session.run(
        `UNWIND $packages AS p
         MERGE (pkg:Package {name: p.name})
         SET pkg.version = p.version, pkg.registry = p.registry
         WITH pkg, p
         MATCH (r:Repository {url: $repoUrl})
         MERGE (r)-[d:DEPENDS_ON]->(pkg)
         SET d.version_spec = p.version
         RETURN count(pkg) AS cnt`,
        { packages: batch, repoUrl }
      );
      nodeCount += batch.length;
      edgeCount += batch.length;
    }

    // Batch insert PackageExport nodes + PROVIDES edges
    for (const pkg of packages) {
      if (pkg.exports.length === 0) continue;

      for (let i = 0; i < pkg.exports.length; i += BATCH_SIZE) {
        const batch = pkg.exports.slice(i, i + BATCH_SIZE).map((e) => ({
          name: e.name,
          signature: e.signature,
          kind: e.kind,
          package_name: pkg.name,
        }));

        await session.run(
          `UNWIND $exports AS e
           MATCH (pkg:Package {name: e.package_name})
           MERGE (pe:PackageExport {name: e.name, package_name: e.package_name})
           SET pe.signature = e.signature, pe.kind = e.kind
           MERGE (pkg)-[:PROVIDES]->(pe)
           RETURN count(pe) AS cnt`,
          { exports: batch }
        );
        nodeCount += batch.length;
        edgeCount += batch.length;
      }
    }

    return { nodeCount, edgeCount };
  } finally {
    await session.close();
  }
}

export async function loadToSupabase(
  repoId: string,
  files: ScannedFile[]
): Promise<void> {
  const sb = getSupabase();

  // Batch upsert file contents
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE).map((f) => ({
      repo_id: repoId,
      file_path: f.path,
      content: f.content,
      content_hash: f.contentHash,
      language: f.language,
      size_bytes: f.sizeBytes,
    }));

    const { error } = await sb
      .from("file_contents")
      .upsert(batch, { onConflict: "repo_id,file_path" });

    if (error) {
      console.error(`Failed to upsert file batch ${i}:`, error.message);
    }
  }
}

export async function purgeRepoFromNeo4j(repoUrl: string): Promise<void> {
  const session = getSession();
  try {
    // Delete all nodes connected to this repo
    await session.run(
      `MATCH (r:Repository {url: $url})-[*]->(n)
       DETACH DELETE n`,
      { url: repoUrl }
    );
    // Delete the repo node itself
    await session.run(
      `MATCH (r:Repository {url: $url}) DETACH DELETE r`,
      { url: repoUrl }
    );
  } finally {
    await session.close();
  }
}

export async function purgeRepoFromSupabase(repoId: string): Promise<void> {
  const sb = getSupabase();
  // Cascade will handle file_contents and digest_jobs
  await sb.from("repositories").delete().eq("id", repoId);
}

export async function purgeImportEdges(repoUrl: string): Promise<void> {
  const session = getSession();
  try {
    // Delete all IMPORTS edges for files in this repo
    await session.run(
      `MATCH (f:File {repo_url: $repoUrl})-[r:IMPORTS]->()
       DELETE r`,
      { repoUrl }
    );
    // Also delete incoming IMPORTS edges from files in this repo to other files
    await session.run(
      `MATCH ()-[r:IMPORTS]->(f:File {repo_url: $repoUrl})
       DELETE r`,
      { repoUrl }
    );
    // Delete all DIRECTLY_IMPORTS edges for files in this repo
    await session.run(
      `MATCH (f:File {repo_url: $repoUrl})-[r:DIRECTLY_IMPORTS]->()
       DELETE r`,
      { repoUrl }
    );
  } finally {
    await session.close();
  }
}

export async function removeFilesFromNeo4j(
  repoUrl: string,
  filePaths: string[]
): Promise<void> {
  if (filePaths.length === 0) return;
  const session = getSession();
  try {
    // Delete file nodes and their connected symbols/edges
    await session.run(
      `UNWIND $paths AS filePath
       MATCH (f:File {path: filePath, repo_url: $repoUrl})
       OPTIONAL MATCH (f)-[:CONTAINS]->(sym)
       DETACH DELETE sym, f`,
      { paths: filePaths, repoUrl }
    );
  } finally {
    await session.close();
  }
}

export async function removeFilesFromSupabase(
  repoId: string,
  filePaths: string[]
): Promise<void> {
  if (filePaths.length === 0) return;
  const sb = getSupabase();
  // Delete in batches
  for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
    const batch = filePaths.slice(i, i + BATCH_SIZE);
    await sb
      .from("file_contents")
      .delete()
      .eq("repo_id", repoId)
      .in("file_path", batch);
  }
}

export async function loadCallsToNeo4j(
  repoUrl: string,
  callsEdges: CallsEdge[]
): Promise<number> {
  if (callsEdges.length === 0) return 0;

  const session = getSession();
  let edgeCount = 0;

  try {
    for (let i = 0; i < callsEdges.length; i += BATCH_SIZE) {
      const batch = callsEdges.slice(i, i + BATCH_SIZE).map((e) => ({
        caller_name: e.callerName,
        caller_file: e.callerFilePath,
        callee_name: e.calleeName,
        callee_file: e.calleeFilePath,
        call_site_line: e.callSiteLine,
        arg_types: e.argTypes || null,
        has_type_mismatch: e.hasTypeMismatch || null,
        type_mismatch_detail: e.typeMismatchDetail || null,
      }));

      const result = await session.run(
        `UNWIND $calls AS c
         MATCH (caller {name: c.caller_name, file_path: c.caller_file, repo_url: $repoUrl})
         WHERE caller:Function OR caller:Class
         MATCH (callee {name: c.callee_name, file_path: c.callee_file, repo_url: $repoUrl})
         WHERE callee:Function OR callee:Class
         MERGE (caller)-[r:CALLS]->(callee)
         SET r.call_site_line = c.call_site_line,
             r.arg_types = c.arg_types,
             r.has_type_mismatch = c.has_type_mismatch,
             r.type_mismatch_detail = c.type_mismatch_detail
         RETURN count(r) AS cnt`,
        { calls: batch, repoUrl }
      );

      const cnt = result.records[0]?.get("cnt")?.toNumber?.() ?? 0;
      edgeCount += cnt;
    }

    return edgeCount;
  } finally {
    await session.close();
  }
}

export async function purgeCallsEdges(repoUrl: string): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (caller {repo_url: $repoUrl})-[r:CALLS]->()
       WHERE caller:Function OR caller:Class
       DELETE r`,
      { repoUrl }
    );
  } finally {
    await session.close();
  }
}
