# Brainstorm: Java & Kotlin Language Support
**Created:** 2026-03-07
**Status:** Draft

## Vision
Add Java and Kotlin as supported languages in RepoGraph, following the same pattern established by the Rust language addition. This closes more of the competitive gap vs CodeGraphContext (they support both) and targets the large enterprise market where Java/Kotlin dominate. Since `scip-java` handles both languages and the SCIP adapter already exists in `runner.ts`, the main work is tree-sitter parsing + import resolution + dependency parsing.

## Existing Context

### Already Done (from SCIP refactor + Rust build)
- **SCIP adapter** for Java/Kotlin exists in `runner.ts` (`javaAdapter` using `scip-java`, maps both `"java"` and `"kotlin"`)
- **Scanner** maps `.java` → `"java"` but **`.kt` is NOT mapped** — gap found
- **Parser pattern** well-established: add language binding, extend `SupportedLanguage`, add case to `getParser()`/`parseFile()`, write walker function
- **Resolver pattern** established: detect file extension, dispatch to language-specific resolver

### Key Differences from Rust
1. **Java imports are package-based** (`import com.example.MyClass;`) — no filesystem path in the import. Resolution requires matching package declarations to directory structure.
2. **Kotlin has the same package system** as Java but with different syntax for some constructs (data classes, sealed classes, companion objects, extension functions).
3. **Both languages share the JVM ecosystem** — Maven/Gradle dependencies, same classpath concept.
4. **Java stack traces are very common** — `at com.example.MyClass.method(MyClass.java:42)` format is one of the most recognizable in software.

## Components Identified

### 1. Scanner Extension (MODIFY `scanner.ts`)
- **Responsibility**: Map `.kt` and `.kts` extensions to `"kotlin"` language
- **Upstream (receives from)**: File system scan
- **Downstream (sends to)**: Parser dispatch, SCIP orchestrator language detection
- **External dependencies**: None
- **Hands test**: PASS — one-line change

### 2. Java Tree-Sitter Parser (NEW function in `parser.ts`)
- **Responsibility**: Walk Java AST and extract classes, interfaces, methods, fields, imports, package declaration
- **Upstream (receives from)**: `parseFile()` dispatches based on `"java"` language
- **Downstream (sends to)**: Returns `ParseResult` (same interface)
- **External dependencies**: `tree-sitter-java` npm package
- **Hands test**: PASS if package is in dependencies

### 3. Kotlin Tree-Sitter Parser (NEW function in `parser.ts`)
- **Responsibility**: Walk Kotlin AST and extract classes, data classes, objects, functions, properties, imports
- **Upstream (receives from)**: `parseFile()` dispatches based on `"kotlin"` language
- **Downstream (sends to)**: Returns `ParseResult` (same interface)
- **External dependencies**: `tree-sitter-kotlin` npm package
- **Hands test**: PASS if package is in dependencies

### 4. Java/Kotlin Import Resolver (NEW strategy in `resolver.ts`)
- **Responsibility**: Resolve `import com.example.MyClass` to file paths based on package → directory convention
- **Upstream (receives from)**: `resolveImports()` dispatch for `.java`/`.kt` files
- **Downstream (sends to)**: Returns `ResolveResult` entries
- **External dependencies**: None — resolves against filesystem
- **Hands test**: PASS — Java's package convention maps directly to directories

### 5. Maven/Gradle Dependency Parser (NEW functions in `deps/lockfile.ts`)
- **Responsibility**: Parse `pom.xml` and `build.gradle`/`build.gradle.kts` for dependencies
- **Upstream (receives from)**: `parseLockfiles()` checks for these files
- **Downstream (sends to)**: Returns `ParsedDependency[]` with `registry: "maven"`
- **External dependencies**: None
- **Hands test**: PASS — file parsing

### 6. Java Stack Trace Regex (ADD to `stack-parser.ts`)
- **Responsibility**: Parse Java/Kotlin stack traces: `at com.example.MyClass.method(MyClass.java:42)`
- **Upstream (receives from)**: `parseStackTrace()` regex sequence
- **Downstream (sends to)**: Returns `ParsedFrame[]`
- **External dependencies**: None
- **Hands test**: PASS — regex matching

## Rough Dependency Map
```
Scanner (.kt → "kotlin")
    ↓
Parser (parseFile → parseJava / parseKotlin)  ← tree-sitter-java, tree-sitter-kotlin
    ↓
SCIP Orchestrator (already handles "java"/"kotlin" via javaAdapter)
    ↓
Resolver (resolveImports → resolveJvmImport)
    ↓
Deps (parseLockfiles → parsePomXml / parseBuildGradle)
    ↓
Stack Parser (JAVA_FRAME regex)
```

## Open Questions
1. **Kotlin AST node names**: What does tree-sitter-kotlin call its nodes? Need to check grammar.
2. **Multi-module projects**: Maven/Gradle multi-module projects have nested `pom.xml`/`build.gradle` files. Should we walk up looking for them or just check repo root?
3. **Gradle Kotlin DSL**: `build.gradle.kts` uses Kotlin syntax for dependency declarations — different regex than Groovy `build.gradle`.

## Risks and Concerns
1. **Java import resolution is inherently imprecise without full classpath**: Unlike Rust/TS where imports map to files, Java `import com.foo.Bar` requires knowing the source root. Convention is `src/main/java/` for Maven or `src/main/kotlin/` for Kotlin, but some projects use `src/` directly.
2. **Kotlin-specific constructs**: Extension functions, companion objects, object declarations, sealed interfaces — need to map these to our symbol model correctly.
3. **Gradle dependency syntax variety**: Groovy DSL (`implementation 'group:artifact:version'`) vs Kotlin DSL (`implementation("group:artifact:version")`) vs variable-based declarations.
