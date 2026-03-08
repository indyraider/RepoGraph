# Build Plan: Java & Kotlin Language Support
**Created:** 2026-03-07
**Brainstorm:** ../brainstorm/java-kotlin-support-brainstorm-2026-03-07.md
**Status:** Draft

## Overview
Add Java and Kotlin as supported languages across the full pipeline: tree-sitter parsing, import resolution, SCIP enrichment (adapter already exists), Maven/Gradle dependency parsing, and JVM stack trace parsing. Follows the established pattern from the Rust language addition.

## Component Inventory

| # | Component | File(s) | Type | Effort |
|---|-----------|---------|------|--------|
| 1 | Scanner `.kt`/`.kts` mapping | `scanner.ts` | Modify | Trivial |
| 2 | Java tree-sitter parser | `parser.ts` | New function | Medium |
| 3 | Kotlin tree-sitter parser | `parser.ts` | New function | Medium |
| 4 | Parser dispatch wiring | `parser.ts` | Modify | Trivial |
| 5 | JVM import resolver | `resolver.ts` | New strategy | Medium |
| 6 | Maven `pom.xml` parser | `deps/lockfile.ts` | New function | Low |
| 7 | Gradle `build.gradle` parser | `deps/lockfile.ts` | New function | Low |
| 8 | Java stack trace regex | `stack-parser.ts` | Add regex | Trivial |
| 9 | npm package deps | `package.json` | Modify | Trivial |

All paths relative to `packages/backend/src/pipeline/`.

## Integration Contracts

### Contract 1: Parser → Digest (same as Rust)
```
parseFile(filePath, content, "java"|"kotlin") → ParseResult
  What flows:     ParseResult { symbols, imports, exports, barrel: null }
  How it flows:   Direct call from digest.ts:337 loop
  Error path:     try/catch increments parseFailures, logs, continues
```
**Wire**: `isSupportedLanguage()` must include `"java"` and `"kotlin"`.

### Contract 2: Resolver Language Dispatch
```
resolveImports() → detects .java/.kt files → resolveJvmImport()
  What flows:     ParsedImport[] → ResolveResult entries
  How it flows:   File extension check in main loop (same pattern as Rust)
  Error path:     Unresolvable imports marked as such, not fatal
```

### Contract 3: Lockfile → Deps
```
parseLockfiles() → checks pom.xml / build.gradle → ParsedDependency[]
  What flows:     File contents → ParsedDependency[] with registry: "maven"
  Error path:     Parse errors caught, returns empty array
```
**Wire**: `ParsedDependency.registry` must include `"maven"`.

### Contract 4: Stack Trace
```
parseStackTrace() → JAVA_FRAME regex → ParsedFrame[]
  What flows:     Raw stack trace → structured frames
  Error path:     Unmatched lines silently skipped
```
**Note**: Java regex must be tried AFTER Rust (`.rs` specific) and BEFORE Node.js (`at` prefix overlap — Java also uses `at` prefix but with different format).

## End-to-End Flow: Digest a Java/Kotlin Repository

1. Scanner maps `.java` → `"java"`, `.kt` → `"kotlin"`
2. `isSupportedLanguage("java")` → true
3. `parseFile()` → `parseJava()` / `parseKotlin()` walker
4. Returns symbols (classes, methods, fields, interfaces) + imports + exports
5. SCIP orchestrator → `getAdaptersForLanguages(["java"])` → `[javaAdapter]` (already wired)
6. If `scip-java` available: runs indexer, enriches types and CALLS edges
7. If not: graceful skip, tree-sitter symbols still indexed
8. Resolver detects `.java`/`.kt` → `resolveJvmImport()` → maps packages to files
9. Lockfile parser finds `pom.xml` or `build.gradle` → parses dependencies
10. Loader pushes everything to Neo4j + Supabase (unchanged)

## Issues Found

### Issue 1: Scanner Missing `.kt` and `.kts` Mappings
`EXTENSION_LANGUAGE_MAP` has `.java` → `"java"` but no `.kt` or `.kts` entries. Must add both.

### Issue 2: `ParsedDependency.registry` Missing `"maven"`
Currently `"npm" | "pypi" | "go" | "cargo"`. Must add `"maven"`.

### Issue 3: Java Import Resolution Needs Source Root Detection
Java imports (`import com.example.Foo`) require knowing where the source root is. Convention:
- Maven: `src/main/java/` and `src/main/kotlin/`
- Gradle: same, or `src/` directly
- Some projects: `app/src/main/java/` (Android)

The resolver should walk up looking for known source roots, then map package path to directory path.

### Issue 4: Java Stack Trace vs Node.js "at" Conflict
Java frames start with `at ` just like Node.js frames. However, Java format is distinctive: `at com.pkg.Class.method(File.java:42)`. The parenthesized `(File.java:42)` pattern distinguishes it. Should be checked BEFORE the generic Node.js regex, similar to how we moved Rust before Node.js.

## Wiring Checklist

### Phase 1: Parser Setup + Scanner Fix
- [ ] Install `tree-sitter-java` and `tree-sitter-kotlin` npm packages
- [ ] Add `.kt` → `"kotlin"` and `.kts` → `"kotlin"` to `EXTENSION_LANGUAGE_MAP` in `scanner.ts`
- [ ] Add `"java"` and `"kotlin"` to `SupportedLanguage` union type
- [ ] Add `"java"` and `"kotlin"` to `isSupportedLanguage()` array
- [ ] Add `getParser()` cases for `"java"` and `"kotlin"`
- [ ] Add `parseFile()` dispatch cases
- [ ] Implement `parseJava()` walker:
  - [ ] `class_declaration` → class (kind: "class")
  - [ ] `interface_declaration` → type (kind: "type")
  - [ ] `enum_declaration` → class (kind: "class")
  - [ ] `method_declaration` → function (kind: "function", name: "Class.method")
  - [ ] `constructor_declaration` → function
  - [ ] `field_declaration` with `static final` → constant (kind: "constant")
  - [ ] `import_declaration` → ParsedImport
  - [ ] `package_declaration` → used for export context
  - [ ] `public` modifier → ParsedExport
  - [ ] Javadoc `/** ... */` → docstring
  - [ ] `annotation_type_declaration` → type
  - [ ] `record_declaration` → class (Java 16+)
- [ ] Implement `parseKotlin()` walker:
  - [ ] `class_declaration` → class
  - [ ] `object_declaration` → class (Kotlin singleton)
  - [ ] `data_class` / `sealed_class` / `enum_class` → class
  - [ ] `function_declaration` → function
  - [ ] `property_declaration` with `val`/`const` → constant
  - [ ] `import_header` → ParsedImport
  - [ ] `package_header` → export context
  - [ ] `interface_declaration` → type
  - [ ] `type_alias` → type
  - [ ] `companion_object` methods → function (name: "Class.Companion.method")
  - [ ] KDoc `/** ... */` → docstring

### Phase 2: Import Resolver
- [ ] Add `resolveJvmImport()` function to `resolver.ts`
- [ ] Dispatch `.java`/`.kt` files in main loop
- [ ] Detect source roots (`src/main/java/`, `src/main/kotlin/`, `src/`, `app/src/main/java/`)
- [ ] Map `import com.example.Foo` → `src/main/java/com/example/Foo.java` or `.kt`
- [ ] Handle wildcard imports: `import com.example.*` → mark as unresolvable (can't resolve to single file)
- [ ] Handle static imports: `import static com.example.Foo.BAR` → resolve to Foo file
- [ ] Mark standard library imports (`java.*`, `javax.*`, `kotlin.*`, `android.*`) as skipped
- [ ] Mark external packages (not found in source) as `external` with package name extracted

### Phase 3: Dependencies + Stack Traces
- [ ] Add `"maven"` to `ParsedDependency.registry` union type
- [ ] Implement `parsePomXml()`:
  - [ ] Parse `<dependency>` elements: groupId, artifactId, version
  - [ ] Handle `<dependencyManagement>` section
  - [ ] Handle `${property}` version variables (best-effort)
- [ ] Implement `parseBuildGradle()`:
  - [ ] Parse Groovy DSL: `implementation 'group:artifact:version'`
  - [ ] Parse Kotlin DSL: `implementation("group:artifact:version")`
  - [ ] Handle `api`, `implementation`, `compileOnly`, `testImplementation` configurations
- [ ] Add detection for `pom.xml`, `build.gradle`, `build.gradle.kts` in `parseLockfiles()`
- [ ] Add `JAVA_FRAME` regex to `stack-parser.ts`
  - [ ] Format: `at com.example.MyClass.method(MyClass.java:42)`
  - [ ] Move before Node.js regex (both use `at` prefix)
  - [ ] Skip frames from common frameworks when internal (e.g., keep all user frames)

## Build Order

**Phase 1: Parsers + Scanner** — Foundation
- Files: `parser.ts`, `scanner.ts`, `package.json`
- Checkpoint: Can parse Java and Kotlin files, extract symbols/imports/exports

**Phase 2: Import Resolver** — Depends on Phase 1 output format
- Files: `resolver.ts`
- Checkpoint: Resolves `import com.example.Foo` to file paths

**Phase 3: Dependencies + Stack Traces** — Independent of Phase 2
- Files: `deps/lockfile.ts`, `runtime/stack-parser.ts`
- Checkpoint: Parses pom.xml/build.gradle deps, parses JVM stack traces

**Phase 4: Integration Test** — After all phases
- Run test script covering all components
- Verify end-to-end with synthetic Java/Kotlin source
