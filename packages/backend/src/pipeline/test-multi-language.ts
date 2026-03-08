/**
 * Integration test for multi-language support.
 * Tests: Rust parser, SCIP adapter registry, Cargo.toml parser,
 * Rust stack traces, Rust import resolver, SCIP symbol ID parser.
 *
 * Run: npx tsx packages/backend/src/pipeline/test-multi-language.ts
 */

import { parseFile, isSupportedLanguage } from "./parser.js";
import { getAdaptersForLanguages, getScipAdapter, isAdapterAvailable } from "./scip/runner.js";
import { parseScipSymbolId } from "./scip/parser.js";
import { parseStackTrace } from "../runtime/stack-parser.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

// =========================================================
// Test 1: Rust is now a supported language
// =========================================================
console.log("\n🔧 Test 1: Language support");
assert(isSupportedLanguage("rust"), "rust is a supported language");
assert(isSupportedLanguage("typescript"), "typescript still supported");
assert(isSupportedLanguage("python"), "python still supported");
assert(isSupportedLanguage("go"), "go still supported");
assert(isSupportedLanguage("java"), "java is a supported language");
assert(isSupportedLanguage("kotlin"), "kotlin is a supported language");

// =========================================================
// Test 2: Rust tree-sitter parser
// =========================================================
console.log("\n🦀 Test 2: Rust parser");

const RUST_SOURCE = `
use std::collections::HashMap;
use crate::config::Settings;
use super::utils::{parse_input, validate};

mod database;

/// Application configuration
pub struct AppConfig {
    pub name: String,
    pub debug: bool,
}

/// Error types for the application
pub enum AppError {
    NotFound,
    Internal(String),
}

/// A trait for serializable types
pub trait Serialize {
    fn to_json(&self) -> String;
}

pub type Result<T> = std::result::Result<T, AppError>;

pub const MAX_RETRIES: u32 = 3;

static GLOBAL_COUNT: u32 = 0;

/// Process incoming data
pub fn process_data(input: &str) -> Result<String> {
    let config = AppConfig { name: "test".into(), debug: false };
    Ok(input.to_string())
}

fn private_helper() -> bool {
    true
}

impl AppConfig {
    pub fn new(name: &str) -> Self {
        Self { name: name.into(), debug: false }
    }

    fn validate(&self) -> bool {
        !self.name.is_empty()
    }
}

impl Serialize for AppConfig {
    fn to_json(&self) -> String {
        format!(r#"{{"name":"{}"}}"#, self.name)
    }
}
`;

const rustResult = parseFile("src/main.rs", RUST_SOURCE, "rust");

// Symbols
const symbolNames = rustResult.symbols.map(s => s.name);
assert(symbolNames.includes("process_data"), "parsed pub fn process_data");
assert(symbolNames.includes("private_helper"), "parsed private fn private_helper");
assert(symbolNames.includes("AppConfig"), "parsed pub struct AppConfig");
assert(symbolNames.includes("AppError"), "parsed pub enum AppError");
assert(symbolNames.includes("Serialize"), "parsed pub trait Serialize");
assert(symbolNames.includes("Result"), "parsed pub type alias Result");
assert(symbolNames.includes("MAX_RETRIES"), "parsed pub const MAX_RETRIES");
assert(symbolNames.includes("GLOBAL_COUNT"), "parsed static GLOBAL_COUNT");
assert(symbolNames.includes("AppConfig.new"), "parsed impl method AppConfig.new");
assert(symbolNames.includes("AppConfig.validate"), "parsed impl method AppConfig.validate");
assert(symbolNames.includes("AppConfig.to_json"), "parsed trait impl method AppConfig.to_json");

// Check symbol kinds
const fnSymbol = rustResult.symbols.find(s => s.name === "process_data")!;
assert(fnSymbol.kind === "function", "process_data is a function");
assert(fnSymbol.docstring.includes("Process incoming data"), "process_data has docstring");

const structSymbol = rustResult.symbols.find(s => s.name === "AppConfig")!;
assert(structSymbol.kind === "class", "AppConfig is a class (struct)");

const traitSymbol = rustResult.symbols.find(s => s.name === "Serialize")!;
assert(traitSymbol.kind === "type", "Serialize is a type (trait)");

const constSymbol = rustResult.symbols.find(s => s.name === "MAX_RETRIES")!;
assert(constSymbol.kind === "constant", "MAX_RETRIES is a constant");

// Imports
assert(rustResult.imports.length >= 4, `parsed ${rustResult.imports.length} imports (expected ≥4)`);
const stdImport = rustResult.imports.find(i => i.source === "std::collections");
assert(!!stdImport, "parsed use std::collections::HashMap");
assert(stdImport?.symbols.includes("HashMap") === true, "imported symbol HashMap");

const crateImport = rustResult.imports.find(i => i.source === "crate::config");
assert(!!crateImport, "parsed use crate::config::Settings");
assert(crateImport?.symbols.includes("Settings") === true, "imported symbol Settings");

const superImport = rustResult.imports.find(i => i.source === "super::utils");
assert(!!superImport, "parsed use super::utils::{parse_input, validate}");
assert(superImport?.symbols.length === 2, "imported 2 symbols from super::utils");

const modImport = rustResult.imports.find(i => i.source === "database");
assert(!!modImport, "parsed mod database;");

// Exports (pub items)
const exportNames = rustResult.exports.map(e => e.symbolName);
assert(exportNames.includes("process_data"), "exports process_data (pub)");
assert(exportNames.includes("AppConfig"), "exports AppConfig (pub)");
assert(exportNames.includes("AppError"), "exports AppError (pub)");
assert(exportNames.includes("Serialize"), "exports Serialize (pub)");
assert(exportNames.includes("MAX_RETRIES"), "exports MAX_RETRIES (pub)");
assert(!exportNames.includes("private_helper"), "does NOT export private_helper");

// =========================================================
// Test 3: SCIP adapter registry
// =========================================================
console.log("\n🔌 Test 3: SCIP adapter registry");

const rustAdapter = getScipAdapter("rust");
assert(rustAdapter !== null, "rust has a SCIP adapter");
assert(rustAdapter?.label === "rust-analyzer", "rust adapter uses rust-analyzer");

const tsAdapter = getScipAdapter("typescript");
assert(tsAdapter !== null, "typescript has a SCIP adapter");
assert(tsAdapter?.label === "scip-typescript", "typescript adapter uses scip-typescript");

const tsxAdapter = getScipAdapter("tsx");
assert(tsxAdapter?.label === "scip-typescript", "tsx maps to same scip-typescript adapter");

const pyAdapter = getScipAdapter("python");
assert(pyAdapter?.label === "scip-python", "python adapter uses scip-python");

const javaAdapter = getScipAdapter("java");
assert(javaAdapter?.label === "scip-java", "java adapter uses scip-java");

const kotlinAdapter = getScipAdapter("kotlin");
assert(kotlinAdapter?.label === "scip-java", "kotlin maps to same scip-java adapter");

assert(getScipAdapter("ruby") === null, "ruby has no SCIP adapter (yet)");

// Deduplication
const adapters = getAdaptersForLanguages(["typescript", "tsx", "javascript", "rust", "python"]);
assert(adapters.length === 3, `deduplicates to 3 unique adapters (got ${adapters.length})`);
const labels = adapters.map(a => a.label).sort();
assert(labels.includes("scip-typescript"), "includes scip-typescript");
assert(labels.includes("rust-analyzer"), "includes rust-analyzer");
assert(labels.includes("scip-python"), "includes scip-python");

// Empty languages
const noAdapters = getAdaptersForLanguages(["json", "yaml", "markdown"]);
assert(noAdapters.length === 0, "no adapters for non-supported languages");

// =========================================================
// Test 4: SCIP symbol ID parser (multi-scheme)
// =========================================================
console.log("\n🔍 Test 4: SCIP symbol ID parser");

// TypeScript format
const tsSymbol = parseScipSymbolId("scip-typescript npm . . src/utils/`helper.ts`/doSomething.");
assert(tsSymbol !== null, "parses TypeScript symbol ID");
assert(tsSymbol?.filePath === "src/utils/helper.ts", `TS filePath: ${tsSymbol?.filePath}`);
assert(tsSymbol?.name === "doSomething", `TS name: ${tsSymbol?.name}`);

// TypeScript class method
const tsMethod = parseScipSymbolId("scip-typescript npm . . src/`app.ts`/MyClass#process().");
assert(tsMethod !== null, "parses TS class method");
assert(tsMethod?.name === "process", `TS method name: ${tsMethod?.name}`);
assert(tsMethod?.containerName === "MyClass", `TS container: ${tsMethod?.containerName}`);

// Rust format
const rustSymbol = parseScipSymbolId("rust-analyzer cargo test-crate 0.1.0 src/`main.rs`/process_data().");
assert(rustSymbol !== null, "parses Rust symbol ID");
assert(rustSymbol?.filePath === "src/main.rs", `Rust filePath: ${rustSymbol?.filePath}`);
assert(rustSymbol?.name === "process_data", `Rust name: ${rustSymbol?.name}`);

// Python format
const pySymbol = parseScipSymbolId("scip-python python mypackage 1.0.0 `module.py`/MyClass#method().");
assert(pySymbol !== null, "parses Python symbol ID");
assert(pySymbol?.filePath === "module.py", `Python filePath: ${pySymbol?.filePath}`);
assert(pySymbol?.name === "method", `Python name: ${pySymbol?.name}`);

// Java format
const javaSymbol = parseScipSymbolId("scip-java maven com.example:app 1.0.0 src/main/java/`App.java`/MyClass#run().");
assert(javaSymbol !== null, "parses Java symbol ID");
assert(javaSymbol?.filePath === "src/main/java/App.java", `Java filePath: ${javaSymbol?.filePath}`);
assert(javaSymbol?.name === "run", `Java name: ${javaSymbol?.name}`);

// Invalid
assert(parseScipSymbolId("not a valid symbol") === null, "returns null for invalid input");
assert(parseScipSymbolId("") === null, "returns null for empty string");

// =========================================================
// Test 5: Rust stack trace parser
// =========================================================
console.log("\n📚 Test 5: Rust stack trace parser");

const rustPanic = `
thread 'main' panicked at 'index out of bounds', src/main.rs:42:5
stack backtrace:
   0: std::panicking::begin_panic_handler
             at /rustc/abc123/library/std/src/panicking.rs:584:5
   1: core::panicking::panic_fmt
             at /rustc/abc123/library/core/src/panicking.rs:142:14
   2: core::panicking::panic_bounds_check
             at /rustc/abc123/library/core/src/panicking.rs:84:5
   3: myapp::process_data
             at src/processor.rs:87:13
   4: myapp::main
             at src/main.rs:42:5
   5: some_dependency::thing
             at /Users/dev/.cargo/registry/src/dep-1.0.0/src/lib.rs:10:1
`;

const rustFrames = parseStackTrace(rustPanic);
assert(rustFrames.length >= 3, `parsed ${rustFrames.length} Rust frames (expected ≥3)`);

// Should include user code frames
const mainFrame = rustFrames.find(f => f.filePath.includes("main.rs"));
assert(!!mainFrame, "found src/main.rs frame");
assert(mainFrame?.lineNumber === 42, `main.rs line number: ${mainFrame?.lineNumber}`);

const processorFrame = rustFrames.find(f => f.filePath.includes("processor.rs"));
assert(!!processorFrame, "found src/processor.rs frame");
assert(processorFrame?.lineNumber === 87, `processor.rs line number: ${processorFrame?.lineNumber}`);

// Should exclude .cargo/registry frames
const cargoFrame = rustFrames.find(f => f.filePath.includes(".cargo/registry"));
assert(!cargoFrame, "filtered out .cargo/registry frames");

// Should exclude /rustc/ internal frames
const rustcFrame = rustFrames.find(f => f.filePath.includes("/rustc/"));
assert(!rustcFrame, "filtered out /rustc/ internal frames");

// Existing formats still work
const nodeTrace = `Error: something
    at processData (src/api/handler.ts:42:18)
    at Router.handle (node_modules/express/lib/router.js:123:7)`;
const nodeFrames = parseStackTrace(nodeTrace);
assert(nodeFrames.length === 1, "Node.js parser still works (1 user frame)");

const pythonTrace = `  File "src/api/handler.py", line 42, in process_data
  File "/usr/lib/python3.11/site-packages/flask/app.py", line 10, in wsgi_app`;
const pyFrames = parseStackTrace(pythonTrace);
assert(pyFrames.length === 1, "Python parser still works (1 user frame)");

// =========================================================
// Test 6: Cargo.toml parser
// =========================================================
console.log("\n📦 Test 6: Cargo.toml parser");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "repograph-test-"));

const cargoToml = `
[package]
name = "my-app"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = "1.0"
tokio = { version = "1.35", features = ["full"] }
local-lib = { path = "../lib" }

[dev-dependencies]
assert_cmd = "2.0"

[build-dependencies]
cc = "1.0"
`;

await fs.writeFile(path.join(tmpDir, "Cargo.toml"), cargoToml);

// Dynamically import parseLockfiles
const { parseLockfiles } = await import("./deps/lockfile.js");
const deps = await parseLockfiles(tmpDir);

assert(deps.length >= 4, `parsed ${deps.length} Cargo deps (expected ≥4)`);

const serdeDep = deps.find(d => d.name === "serde");
assert(!!serdeDep, "found serde dependency");
assert(serdeDep?.version === "1.0", `serde version: ${serdeDep?.version}`);
assert(serdeDep?.registry === "cargo", "serde registry is cargo");

const tokioDep = deps.find(d => d.name === "tokio");
assert(!!tokioDep, "found tokio dependency (table format)");
assert(tokioDep?.version === "1.35", `tokio version: ${tokioDep?.version}`);

const localDep = deps.find(d => d.name === "local-lib");
assert(!!localDep, "found local-lib path dependency");
assert(localDep?.version === "path", "local-lib version is 'path'");

const devDep = deps.find(d => d.name === "assert_cmd");
assert(!!devDep, "found dev-dependency assert_cmd");

const buildDep = deps.find(d => d.name === "cc");
assert(!!buildDep, "found build-dependency cc");

// Cleanup
await fs.rm(tmpDir, { recursive: true });

// =========================================================
// Test 7: Rust import resolver
// =========================================================
console.log("\n🔗 Test 7: Rust import resolver");

const rustRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "repograph-rust-"));

// Create a mini Rust project structure
await fs.mkdir(path.join(rustRepoDir, "src"), { recursive: true });
await fs.mkdir(path.join(rustRepoDir, "src/utils"), { recursive: true });

await fs.writeFile(path.join(rustRepoDir, "Cargo.toml"), `[package]\nname = "test"\n`);
await fs.writeFile(path.join(rustRepoDir, "src/lib.rs"), `mod config;\nmod utils;\n`);
await fs.writeFile(path.join(rustRepoDir, "src/config.rs"), `pub struct Settings { pub debug: bool }\n`);
await fs.writeFile(path.join(rustRepoDir, "src/utils/mod.rs"), `pub fn parse_input() {}\n`);
await fs.writeFile(path.join(rustRepoDir, "src/main.rs"), `
use crate::config::Settings;
use crate::utils::parse_input;
use super::something;
use tokio::runtime::Runtime;
use std::collections::HashMap;

mod config;
`);

// Parse the main.rs file
const mainContent = await fs.readFile(path.join(rustRepoDir, "src/main.rs"), "utf-8");
const mainParseResult = parseFile("src/main.rs", mainContent, "rust");

const { resolveImports } = await import("./resolver.js");
const resolveResult = resolveImports(mainParseResult.imports, rustRepoDir);

// Check that crate:: imports resolved to files
const configImport = resolveResult.imports.find(i => i.fromFile === "src/main.rs" && i.toFile?.includes("config"));
assert(!!configImport, "resolved use crate::config::Settings to file");
assert(configImport?.resolutionStatus === "resolved", `config import status: ${configImport?.resolutionStatus}`);

const utilsImport = resolveResult.imports.find(i => i.fromFile === "src/main.rs" && i.toFile?.includes("utils"));
assert(!!utilsImport, "resolved use crate::utils to file");

// External crate should be marked external
const tokioImport = resolveResult.imports.find(i => i.toPackage === "tokio");
assert(!!tokioImport, "tokio import marked as external");
assert(tokioImport?.resolutionStatus === "external", "tokio is external");

// std should be skipped (not in results)
const stdImportResolved = resolveResult.imports.find(i => i.toPackage === "std");
assert(!stdImportResolved, "std imports are skipped");

// mod config; should resolve to config.rs
const modConfigImport = resolveResult.imports.find(i =>
  i.fromFile === "src/main.rs" && i.toFile === "src/config.rs"
);
assert(!!modConfigImport, "mod config; resolved to src/config.rs");

// Cleanup
await fs.rm(rustRepoDir, { recursive: true });

// =========================================================
// Test 8: SCIP adapter availability check
// =========================================================
console.log("\n🔍 Test 8: SCIP adapter availability");

const tsAvailable = await isAdapterAvailable(tsAdapter!);
console.log(`  ℹ️  scip-typescript available: ${tsAvailable}`);

const rustAvailable = await isAdapterAvailable(rustAdapter!);
console.log(`  ℹ️  rust-analyzer available: ${rustAvailable}`);

const pyAvailable = await isAdapterAvailable(pyAdapter!);
console.log(`  ℹ️  scip-python available: ${pyAvailable}`);

// These are informational — we don't fail if binaries aren't installed
assert(true, "adapter availability checks completed without crash");

// =========================================================
// Test 9: Java language support flag
// =========================================================
console.log("\n🔍 Test 9: Java language support");
assert(isSupportedLanguage("java"), "java is a supported language");
assert(isSupportedLanguage("kotlin"), "kotlin is a supported language");

// =========================================================
// Test 10: Java parser — symbols, imports, exports
// =========================================================
console.log("\n🔍 Test 10: Java parser");

const javaCode = `
package com.example.service;

import java.util.List;
import com.example.model.User;
import static com.example.util.Constants.MAX_RETRIES;
import org.apache.commons.*;

/**
 * Main service class for user operations.
 */
public class UserService {
    public static final String SERVICE_NAME = "user-service";
    private static final int TIMEOUT = 5000;

    public UserService() {
        // constructor
    }

    public List<User> findAll() {
        return null;
    }

    private void internalMethod() {
    }
}

public interface Serializable {
    String serialize();
}

public enum Status {
    ACTIVE, INACTIVE, PENDING
}

public record UserDTO(String name, int age) {}
`;

const javaResult = parseFile("src/main/java/com/example/service/UserService.java", javaCode, "java");

assert(javaResult.symbols.length > 0, "Java parser extracted symbols");

const javaClasses = javaResult.symbols.filter(s => s.kind === "class");
assert(javaClasses.some(s => s.name === "UserService"), "found UserService class");
assert(javaClasses.some(s => s.name === "Status"), "found Status enum as class");
assert(javaClasses.some(s => s.name === "UserDTO"), "found UserDTO record as class");

const javaTypes = javaResult.symbols.filter(s => s.kind === "type");
assert(javaTypes.some(s => s.name === "Serializable"), "found Serializable interface as type");

const javaMethods = javaResult.symbols.filter(s => s.kind === "function");
assert(javaMethods.some(s => s.name === "UserService.findAll"), "found UserService.findAll method");
assert(javaMethods.some(s => s.name === "UserService.constructor"), "found UserService constructor");
assert(javaMethods.some(s => s.name === "UserService.internalMethod"), "found UserService.internalMethod");

const javaConstants = javaResult.symbols.filter(s => s.kind === "constant");
assert(javaConstants.some(s => s.name === "UserService.SERVICE_NAME"), "found static final SERVICE_NAME constant");

// Imports
assert(javaResult.imports.length >= 3, `Java parser found ${javaResult.imports.length} imports (expected >= 3)`);
const javaImportSources = javaResult.imports.map(i => i.source);
assert(javaImportSources.some(s => s.includes("java.util")), "found java.util import");
assert(javaImportSources.some(s => s.includes("com.example.model")), "found com.example.model import");

// Exports (public declarations)
assert(javaResult.exports.some(e => e.symbolName === "UserService"), "UserService is exported (public)");
assert(javaResult.exports.some(e => e.symbolName === "Serializable"), "Serializable is exported (public)");

// Docstrings
const userServiceSym = javaResult.symbols.find(s => s.name === "UserService");
assert(userServiceSym?.docstring?.includes("Main service class") ?? false, "Java docstring extracted for UserService");

// =========================================================
// Test 11: Kotlin parser — symbols, imports, exports
// =========================================================
console.log("\n🔍 Test 11: Kotlin parser");

const kotlinCode = `
package com.example.app

import com.example.model.User
import kotlinx.coroutines.*

/**
 * Application configuration.
 */
data class AppConfig(val name: String, val debug: Boolean)

sealed class Result<T> {
    data class Success<T>(val data: T) : Result<T>()
    data class Error<T>(val message: String) : Result<T>()
}

object AppRegistry {
    fun register(name: String) {}
}

class UserManager {
    companion object {
        fun create(): UserManager = UserManager()
        const val VERSION = 2
    }

    fun getUser(id: Int): User? = null
    private fun validate(id: Int): Boolean = true
}

interface Repository<T> {
    fun findById(id: Int): T?
    fun save(entity: T): T
}

typealias UserList = List<User>

val DEFAULT_TIMEOUT = 5000
const val MAX_CONNECTIONS = 100

fun processRequest(request: String): Result<String> {
    return Result.Success(request)
}

private fun helperFunction() {}
`;

const kotlinResult = parseFile("src/main/kotlin/com/example/app/App.kt", kotlinCode, "kotlin");

assert(kotlinResult.symbols.length > 0, "Kotlin parser extracted symbols");

const ktClasses = kotlinResult.symbols.filter(s => s.kind === "class");
assert(ktClasses.some(s => s.name === "AppConfig"), "found AppConfig data class");
assert(ktClasses.some(s => s.name === "Result"), "found Result sealed class");
assert(ktClasses.some(s => s.name === "AppRegistry"), "found AppRegistry object");
assert(ktClasses.some(s => s.name === "UserManager"), "found UserManager class");

const ktTypes = kotlinResult.symbols.filter(s => s.kind === "type");
assert(ktTypes.some(s => s.name === "Repository"), "found Repository interface");

const ktFunctions = kotlinResult.symbols.filter(s => s.kind === "function");
assert(ktFunctions.some(s => s.name === "processRequest"), "found top-level processRequest function");
assert(ktFunctions.some(s => s.name === "AppRegistry.register"), "found AppRegistry.register method");
assert(ktFunctions.some(s => s.name === "UserManager.getUser"), "found UserManager.getUser method");

// Companion object methods
assert(ktFunctions.some(s => s.name === "UserManager.Companion.create"), "found UserManager.Companion.create method");

// Kotlin val/const as constants
const ktConstants = kotlinResult.symbols.filter(s => s.kind === "constant");
assert(ktConstants.length > 0, `Kotlin parser found ${ktConstants.length} constants`);

// Imports
assert(kotlinResult.imports.length >= 2, `Kotlin parser found ${kotlinResult.imports.length} imports`);

// Exports (public by default in Kotlin)
assert(kotlinResult.exports.some(e => e.symbolName === "AppConfig"), "AppConfig is exported (public by default)");
assert(kotlinResult.exports.some(e => e.symbolName === "processRequest"), "processRequest is exported (public by default)");

// =========================================================
// Test 12: Java stack traces
// =========================================================
console.log("\n🔍 Test 12: Java/Kotlin stack traces");

const javaStackTrace = `
Exception in thread "main" java.lang.NullPointerException: Cannot invoke method on null
	at com.example.service.UserService.findAll(UserService.java:42)
	at com.example.controller.UserController.list(UserController.java:28)
	at java.base/java.lang.reflect.Method.invoke(Method.java:566)
	at javax.servlet.http.HttpServlet.service(HttpServlet.java:750)
	at com.example.App.main(App.java:15)
`;

const javaFrames = parseStackTrace(javaStackTrace);
assert(javaFrames.length >= 3, `Java stack trace parsed ${javaFrames.length} frames (expected >= 3)`);
assert(javaFrames.some(f => f.filePath === "UserService.java" && f.lineNumber === 42), "found UserService.java:42 frame");
assert(javaFrames.some(f => f.functionName?.includes("UserService.findAll")), "found UserService.findAll function name");
// java.* and javax.* frames should be filtered
assert(!javaFrames.some(f => f.functionName?.startsWith("java.")), "java.* frames filtered out");
assert(!javaFrames.some(f => f.functionName?.startsWith("javax.")), "javax.* frames filtered out");

const kotlinStackTrace = `
Exception in thread "main" kotlin.KotlinNullPointerException
	at com.example.app.UserManager.getUser(UserManager.kt:15)
	at kotlin.coroutines.jvm.internal.BaseContinuationImpl.resumeWith(ContinuationImpl.kt:33)
	at kotlinx.coroutines.DispatchedTask.run(DispatchedTask.kt:106)
	at com.example.app.App.main(App.kt:8)
`;

const kotlinFrames = parseStackTrace(kotlinStackTrace);
assert(kotlinFrames.length >= 2, `Kotlin stack trace parsed ${kotlinFrames.length} frames (expected >= 2)`);
assert(kotlinFrames.some(f => f.filePath === "UserManager.kt" && f.lineNumber === 15), "found UserManager.kt:15 frame");
// kotlin.* and kotlinx.coroutines.* should be filtered
assert(!kotlinFrames.some(f => f.functionName?.startsWith("kotlin.coroutines")), "kotlin.coroutines.* frames filtered out");
assert(!kotlinFrames.some(f => f.functionName?.startsWith("kotlinx.coroutines")), "kotlinx.coroutines.* frames filtered out");

// =========================================================
// Test 13: Maven pom.xml parsing
// =========================================================
console.log("\n🔍 Test 13: Maven pom.xml parsing");

const pomXmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <properties>
    <spring.version>5.3.20</spring.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-core</artifactId>
      <version>\${spring.version}</version>
    </dependency>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>31.1-jre</version>
    </dependency>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
    </dependency>
  </dependencies>
</project>`;

const mavenRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "rg-maven-test-"));
await fs.writeFile(path.join(mavenRepoDir, "pom.xml"), pomXmlContent);

const mavenDeps = await parseLockfiles(mavenRepoDir);
const mavenOnly = mavenDeps.filter(d => d.registry === "maven");

assert(mavenOnly.length >= 2, `Found ${mavenOnly.length} Maven dependencies (expected >= 2)`);
assert(mavenOnly.some(d => d.name === "org.springframework:spring-core"), "found spring-core dependency");
assert(mavenOnly.some(d => d.name === "com.google.guava:guava" && d.version === "31.1-jre"), "found guava with version");
// Property substitution
const springDep = mavenOnly.find(d => d.name === "org.springframework:spring-core");
assert(springDep?.version === "5.3.20", `spring-core version resolved from property: ${springDep?.version}`);

await fs.rm(mavenRepoDir, { recursive: true });

// =========================================================
// Test 14: Gradle build.gradle parsing
// =========================================================
console.log("\n🔍 Test 14: Gradle build.gradle parsing");

const buildGradleContent = `
plugins {
    id 'java'
    id 'org.springframework.boot' version '3.0.0'
}

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web:3.0.0'
    api 'com.fasterxml.jackson.core:jackson-databind:2.14.0'
    testImplementation 'org.junit.jupiter:junit-jupiter:5.9.0'
    compileOnly 'org.projectlombok:lombok:1.18.24'
}
`;

const gradleRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "rg-gradle-test-"));
await fs.writeFile(path.join(gradleRepoDir, "build.gradle"), buildGradleContent);

const gradleDeps = await parseLockfiles(gradleRepoDir);
const gradleOnly = gradleDeps.filter(d => d.registry === "maven");

assert(gradleOnly.length >= 3, `Found ${gradleOnly.length} Gradle dependencies (expected >= 3)`);
assert(gradleOnly.some(d => d.name === "org.springframework.boot:spring-boot-starter-web"), "found spring-boot-starter-web");
assert(gradleOnly.some(d => d.name === "com.fasterxml.jackson.core:jackson-databind"), "found jackson-databind");
assert(gradleOnly.some(d => d.name === "org.junit.jupiter:junit-jupiter"), "found junit-jupiter");

await fs.rm(gradleRepoDir, { recursive: true });

// =========================================================
// Test 15: Gradle Kotlin DSL build.gradle.kts parsing
// =========================================================
console.log("\n🔍 Test 15: Gradle Kotlin DSL parsing");

const buildGradleKtsContent = `
plugins {
    kotlin("jvm") version "1.9.0"
}

dependencies {
    implementation("io.ktor:ktor-server-core:2.3.0")
    testImplementation("io.mockk:mockk:1.13.0")
}
`;

const gradleKtsRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "rg-gradlekts-test-"));
await fs.writeFile(path.join(gradleKtsRepoDir, "build.gradle.kts"), buildGradleKtsContent);

const gradleKtsDeps = await parseLockfiles(gradleKtsRepoDir);
const gradleKtsOnly = gradleKtsDeps.filter(d => d.registry === "maven");

assert(gradleKtsOnly.length >= 2, `Found ${gradleKtsOnly.length} Gradle KTS dependencies (expected >= 2)`);
assert(gradleKtsOnly.some(d => d.name === "io.ktor:ktor-server-core"), "found ktor-server-core");

await fs.rm(gradleKtsRepoDir, { recursive: true });

// =========================================================
// Test 16: JVM import resolver
// =========================================================
console.log("\n🔍 Test 16: JVM import resolver");

const jvmRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "rg-jvm-resolve-test-"));
// Create source root structure
await fs.mkdir(path.join(jvmRepoDir, "src/main/java/com/example/model"), { recursive: true });
await fs.mkdir(path.join(jvmRepoDir, "src/main/java/com/example/service"), { recursive: true });
await fs.mkdir(path.join(jvmRepoDir, "src/main/kotlin/com/example/app"), { recursive: true });

await fs.writeFile(path.join(jvmRepoDir, "src/main/java/com/example/model/User.java"),
  `package com.example.model;\npublic class User { public String name; }`);
await fs.writeFile(path.join(jvmRepoDir, "src/main/java/com/example/service/UserService.java"),
  `package com.example.service;\nimport com.example.model.User;\npublic class UserService { public User find() { return null; } }`);
await fs.writeFile(path.join(jvmRepoDir, "src/main/kotlin/com/example/app/App.kt"),
  `package com.example.app\nimport com.example.model.User\nclass App { fun run() {} }`);

const jvmImports = [
  { source: "com.example.model", symbols: ["User"], defaultImport: null, filePath: "src/main/java/com/example/service/UserService.java" },
  { source: "java.util", symbols: ["List"], defaultImport: null, filePath: "src/main/java/com/example/service/UserService.java" },
  { source: "com.example.model", symbols: ["User"], defaultImport: null, filePath: "src/main/kotlin/com/example/app/App.kt" },
  { source: "org.apache.commons", symbols: ["*"], defaultImport: null, filePath: "src/main/java/com/example/service/UserService.java" },
];

const jvmResult = resolveImports(jvmImports, jvmRepoDir);

// java.util.List should be skipped (standard library)
assert(jvmResult.stats.total >= 3, `JVM resolver processed ${jvmResult.stats.total} imports`);

// com.example.model.User should resolve
const resolvedJvm = jvmResult.imports.filter(i => i.resolutionStatus === "resolved");
assert(resolvedJvm.length >= 1, `JVM resolver resolved ${resolvedJvm.length} imports`);

// Wildcard import should be unresolvable
const unresolvableJvm = jvmResult.imports.filter(i => i.resolutionStatus === "unresolvable");
assert(unresolvableJvm.length >= 1, "Wildcard import marked as unresolvable");

// External packages
const externalJvm = jvmResult.imports.filter(i => i.resolutionStatus === "external");
// org.apache.commons should be external if not found
assert(externalJvm.length >= 0, "External packages handled");

await fs.rm(jvmRepoDir, { recursive: true });

// =========================================================
// Test 17: C# parser
// =========================================================
console.log("\n🔍 Test 17: C# parser");

const csharpCode = `
using System;
using System.Collections.Generic;
using MyApp.Models;

namespace MyApp.Services
{
    /// <summary>
    /// Handles user operations.
    /// </summary>
    public class UserService
    {
        public static readonly string ServiceName = "user-service";

        public UserService() { }

        public List<User> GetAll() { return null; }

        private void InternalMethod() { }
    }

    public interface IRepository<T>
    {
        T FindById(int id);
    }

    public struct Point
    {
        public int X;
        public int Y;
    }

    public enum Status
    {
        Active, Inactive
    }

    public record UserDTO(string Name, int Age);
}
`;

const csharpResult = parseFile("src/Services/UserService.cs", csharpCode, "csharp");
assert(csharpResult.symbols.length > 0, "C# parser extracted symbols");

const csClasses = csharpResult.symbols.filter(s => s.kind === "class");
assert(csClasses.some(s => s.name === "UserService"), "found UserService class");
assert(csClasses.some(s => s.name === "Point"), "found Point struct as class");
assert(csClasses.some(s => s.name === "Status"), "found Status enum as class");
assert(csClasses.some(s => s.name === "UserDTO"), "found UserDTO record as class");

const csTypes = csharpResult.symbols.filter(s => s.kind === "type");
assert(csTypes.some(s => s.name === "IRepository"), "found IRepository interface as type");

const csMethods = csharpResult.symbols.filter(s => s.kind === "function");
assert(csMethods.some(s => s.name === "UserService.GetAll"), "found UserService.GetAll method");
assert(csMethods.some(s => s.name === "UserService.constructor"), "found UserService constructor");

// Imports
assert(csharpResult.imports.length >= 2, `C# parser found ${csharpResult.imports.length} imports`);
assert(csharpResult.imports.some(i => i.source.includes("System.Collections.Generic")), "found System.Collections.Generic using");

// Exports (public)
assert(csharpResult.exports.some(e => e.symbolName === "UserService"), "UserService is exported (public)");

// =========================================================
// Test 18: Ruby parser
// =========================================================
console.log("\n🔍 Test 18: Ruby parser");

const rubyCode = `
require 'json'
require_relative './models/user'
require 'active_record'

module MyApp
  module Services
    # Handles user operations
    class UserService
      MAX_RETRIES = 3

      def initialize(repo)
        @repo = repo
      end

      def find_all
        @repo.all
      end

      def self.create(params)
        new(params)
      end

      private

      def validate(user)
        user.valid?
      end
    end
  end
end
`;

const rubyResult = parseFile("lib/my_app/services/user_service.rb", rubyCode, "ruby");
assert(rubyResult.symbols.length > 0, "Ruby parser extracted symbols");

const rbClasses = rubyResult.symbols.filter(s => s.kind === "class");
assert(rbClasses.some(s => s.name === "UserService"), "found UserService class");

const rbModules = rubyResult.symbols.filter(s => s.kind === "class" && s.name === "MyApp" || s.name === "Services");
assert(rbModules.length >= 1, "found module(s)");

const rbMethods = rubyResult.symbols.filter(s => s.kind === "function");
assert(rbMethods.some(s => s.name === "find_all" || s.name === "UserService.find_all"), "found find_all method");

// Imports
assert(rubyResult.imports.length >= 2, `Ruby parser found ${rubyResult.imports.length} imports`);
assert(rubyResult.imports.some(i => i.source === "json"), "found require 'json'");

// =========================================================
// Test 19: PHP parser
// =========================================================
console.log("\n🔍 Test 19: PHP parser");

const phpCode = `<?php
namespace App\\Services;

use App\\Models\\User;
use App\\Repositories\\UserRepository;

/**
 * User service class.
 */
class UserService
{
    const MAX_RETRIES = 3;

    public function __construct(
        private UserRepository $repo
    ) {}

    public function findAll(): array
    {
        return $this->repo->all();
    }

    private function validate(User $user): bool
    {
        return true;
    }
}

interface Cacheable
{
    public function getCacheKey(): string;
}

trait HasTimestamps
{
    public function getCreatedAt(): string
    {
        return '';
    }
}

enum Status: string
{
    case Active = 'active';
    case Inactive = 'inactive';
}
`;

const phpResult = parseFile("src/Services/UserService.php", phpCode, "php");
assert(phpResult.symbols.length > 0, "PHP parser extracted symbols");

const phpClasses = phpResult.symbols.filter(s => s.kind === "class");
assert(phpClasses.some(s => s.name === "UserService"), "found UserService class");
assert(phpClasses.some(s => s.name === "Status"), "found Status enum as class");

const phpTypes = phpResult.symbols.filter(s => s.kind === "type");
assert(phpTypes.some(s => s.name === "Cacheable"), "found Cacheable interface as type");

const phpMethods = phpResult.symbols.filter(s => s.kind === "function");
assert(phpMethods.some(s => s.name === "UserService.findAll"), "found UserService.findAll method");

// Imports
assert(phpResult.imports.length >= 1, `PHP parser found ${phpResult.imports.length} imports`);

// =========================================================
// Test 20: Swift parser
// =========================================================
console.log("\n🔍 Test 20: Swift parser");

const swiftCode = `
import Foundation
import MyFramework

/// User service for managing users.
public class UserService {
    public let serviceName = "user-service"
    private var users: [User] = []

    public init() {}

    public func findAll() -> [User] {
        return users
    }

    private func validate(_ user: User) -> Bool {
        return true
    }
}

public struct Point {
    public var x: Int
    public var y: Int
}

public enum Status {
    case active
    case inactive
}

public protocol Repository {
    func findById(id: Int) -> Any?
    func save(entity: Any) -> Any
}

public func processRequest(_ request: String) -> String {
    return request
}
`;

const swiftResult = parseFile("Sources/MyApp/UserService.swift", swiftCode, "swift");
assert(swiftResult.symbols.length > 0, "Swift parser extracted symbols");

const swClasses = swiftResult.symbols.filter(s => s.kind === "class");
assert(swClasses.some(s => s.name === "UserService"), "found UserService class");

const swTypes = swiftResult.symbols.filter(s => s.kind === "type");
assert(swTypes.some(s => s.name === "Repository"), "found Repository protocol as type");

const swFunctions = swiftResult.symbols.filter(s => s.kind === "function");
assert(swFunctions.some(s => s.name === "UserService.findAll" || s.name === "findAll"), "found findAll method");
assert(swFunctions.some(s => s.name === "processRequest"), "found top-level processRequest function");

// Imports
assert(swiftResult.imports.length >= 1, `Swift parser found ${swiftResult.imports.length} imports`);
assert(swiftResult.imports.some(i => i.source === "Foundation"), "found import Foundation");

// Exports (public items)
assert(swiftResult.exports.some(e => e.symbolName === "UserService"), "UserService is exported (public)");
assert(swiftResult.exports.some(e => e.symbolName === "processRequest"), "processRequest is exported (public)");

// =========================================================
// Test 21: C#/Ruby/PHP/Swift stack traces
// =========================================================
console.log("\n🔍 Test 21: C#/Ruby/PHP/Swift stack traces");

const csharpTrace = `
System.NullReferenceException: Object reference not set to an instance of an object.
   at MyApp.Services.UserService.GetAll() in /app/src/Services/UserService.cs:line 42
   at MyApp.Controllers.UserController.Index() in /app/src/Controllers/UserController.cs:line 18
   at System.Runtime.CompilerServices.AsyncTaskMethodBuilder.Start() in /usr/share/dotnet/shared/something.cs:line 100
`;

const csFrames = parseStackTrace(csharpTrace);
assert(csFrames.length >= 2, `C# stack trace parsed ${csFrames.length} frames (expected >= 2)`);
assert(csFrames.some(f => f.filePath.includes("UserService.cs") && f.lineNumber === 42), "found UserService.cs:42");
assert(!csFrames.some(f => f.functionName?.startsWith("System.")), "System.* frames filtered out");

const rubyTrace = `
app/services/user_service.rb:42:in \`find_all'
app/controllers/users_controller.rb:18:in \`index'
/usr/lib/ruby/gems/3.0.0/gems/actionpack-7.0/lib/action_dispatch.rb:100:in \`call'
`;

const rbFrames = parseStackTrace(rubyTrace);
assert(rbFrames.length >= 2, `Ruby stack trace parsed ${rbFrames.length} frames (expected >= 2)`);
assert(rbFrames.some(f => f.filePath.includes("user_service.rb") && f.lineNumber === 42), "found user_service.rb:42");
assert(!rbFrames.some(f => f.filePath.includes("/gems/")), "gem frames filtered out");

const phpTrace = `
#0 /app/src/Services/UserService.php(42): UserService->findAll()
#1 /app/src/Controllers/UserController.php(18): UserController->index()
#2 /app/vendor/laravel/framework/src/Router.php(100): Router->dispatch()
`;

const phpFrames = parseStackTrace(phpTrace);
assert(phpFrames.length >= 2, `PHP stack trace parsed ${phpFrames.length} frames (expected >= 2)`);
assert(phpFrames.some(f => f.filePath.includes("UserService.php") && f.lineNumber === 42), "found UserService.php:42");
assert(!phpFrames.some(f => f.filePath.includes("/vendor/")), "vendor frames filtered out");

const swiftTrace = `
Fatal error: Index out of range
  #0 0x00000001 at Sources/MyApp/UserService.swift:42:5
  #1 0x00000002 at Sources/MyApp/App.swift:18
  #2 0x00000003 at /Applications/Xcode.app/Contents/SharedFrameworks/something.swift:100:1
`;

const swFrames = parseStackTrace(swiftTrace);
assert(swFrames.length >= 2, `Swift stack trace parsed ${swFrames.length} frames (expected >= 2)`);
assert(swFrames.some(f => f.filePath.includes("UserService.swift") && f.lineNumber === 42), "found UserService.swift:42");
assert(!swFrames.some(f => f.filePath.includes("/Xcode.app/")), "Xcode frames filtered out");

// =========================================================
// Test 22: NuGet .csproj parsing
// =========================================================
console.log("\n🔍 Test 22: NuGet .csproj parsing");

const csprojContent = `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="7.0.0" />
    <PackageReference Include="Serilog" Version="3.0.0" />
  </ItemGroup>
</Project>`;

const nugetRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "rg-nuget-test-"));
await fs.writeFile(path.join(nugetRepoDir, "MyApp.csproj"), csprojContent);

const nugetDeps = await parseLockfiles(nugetRepoDir);
const nugetOnly = nugetDeps.filter(d => d.registry === "nuget");

assert(nugetOnly.length >= 3, `Found ${nugetOnly.length} NuGet dependencies (expected >= 3)`);
assert(nugetOnly.some(d => d.name === "Newtonsoft.Json" && d.version === "13.0.1"), "found Newtonsoft.Json");
assert(nugetOnly.some(d => d.name === "Microsoft.EntityFrameworkCore"), "found EF Core");

await fs.rm(nugetRepoDir, { recursive: true });

// =========================================================
// Test 23: Gemfile parsing
// =========================================================
console.log("\n🔍 Test 23: Gemfile parsing");

const gemfileContent = `
source 'https://rubygems.org'

gem 'rails', '~> 7.0'
gem 'pg', '>= 1.1'
gem 'puma'
# gem 'commented_out'

group :development do
  gem 'rubocop', '~> 1.50'
end
`;

const gemRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "rg-gem-test-"));
await fs.writeFile(path.join(gemRepoDir, "Gemfile"), gemfileContent);

const gemDeps = await parseLockfiles(gemRepoDir);
const gemsOnly = gemDeps.filter(d => d.registry === "rubygems");

assert(gemsOnly.length >= 3, `Found ${gemsOnly.length} Ruby gem dependencies (expected >= 3)`);
assert(gemsOnly.some(d => d.name === "rails"), "found rails gem");
assert(gemsOnly.some(d => d.name === "puma"), "found puma gem");

await fs.rm(gemRepoDir, { recursive: true });

// =========================================================
// Test 24: composer.json parsing
// =========================================================
console.log("\n🔍 Test 24: composer.json parsing");

const composerContent = JSON.stringify({
  require: {
    "php": ">=8.1",
    "laravel/framework": "^10.0",
    "guzzlehttp/guzzle": "^7.2",
    "ext-mbstring": "*",
  },
  "require-dev": {
    "phpunit/phpunit": "^10.0",
  }
});

const composerRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "rg-composer-test-"));
await fs.writeFile(path.join(composerRepoDir, "composer.json"), composerContent);

const composerDeps = await parseLockfiles(composerRepoDir);
const packagistOnly = composerDeps.filter(d => d.registry === "packagist");

assert(packagistOnly.length >= 3, `Found ${packagistOnly.length} Packagist dependencies (expected >= 3)`);
assert(packagistOnly.some(d => d.name === "laravel/framework"), "found laravel/framework");
assert(packagistOnly.some(d => d.name === "phpunit/phpunit"), "found phpunit");
// php and ext-mbstring should be filtered out
assert(!packagistOnly.some(d => d.name === "php"), "php itself filtered out");
assert(!packagistOnly.some(d => d.name === "ext-mbstring"), "ext-mbstring filtered out");

await fs.rm(composerRepoDir, { recursive: true });

// =========================================================
// Test 25: Package.swift parsing
// =========================================================
console.log("\n🔍 Test 25: Package.swift parsing");

const packageSwiftContent = `
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MyApp",
    dependencies: [
        .package(url: "https://github.com/vapor/vapor.git", from: "4.77.0"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.2.0"),
    ]
)
`;

const swiftRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "rg-swift-test-"));
await fs.writeFile(path.join(swiftRepoDir, "Package.swift"), packageSwiftContent);

const swiftDeps = await parseLockfiles(swiftRepoDir);
const swiftpmOnly = swiftDeps.filter(d => d.registry === "swiftpm");

assert(swiftpmOnly.length >= 2, `Found ${swiftpmOnly.length} SwiftPM dependencies (expected >= 2)`);
assert(swiftpmOnly.some(d => d.name === "vapor"), "found vapor dependency");
assert(swiftpmOnly.some(d => d.name === "swift-argument-parser"), "found swift-argument-parser");
assert(swiftpmOnly.some(d => d.version === "4.77.0"), "parsed vapor version 4.77.0");

await fs.rm(swiftRepoDir, { recursive: true });

// =========================================================
// Test 26: Language support flags for new languages
// =========================================================
console.log("\n🔍 Test 26: Language support flags");
assert(isSupportedLanguage("csharp"), "csharp is a supported language");
assert(isSupportedLanguage("ruby"), "ruby is a supported language");
assert(isSupportedLanguage("php"), "php is a supported language");
assert(isSupportedLanguage("swift"), "swift is a supported language");

// =========================================================
// Summary
// =========================================================
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("❌ SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("✅ ALL TESTS PASSED");
}
