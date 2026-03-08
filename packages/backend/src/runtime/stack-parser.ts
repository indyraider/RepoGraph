/**
 * Stack Trace Parser — extracts file paths, line numbers, and function names
 * from raw stack trace strings across multiple languages/runtimes.
 */

export interface ParsedFrame {
  filePath: string;
  lineNumber: number;
  columnNumber?: number;
  functionName?: string;
}

// Container/serverless path prefixes to strip
const PATH_PREFIXES_TO_STRIP = [
  /^\/var\/task\//,
  /^\/app\//,
  /^\/home\/\w+\//,
  /^\/opt\/\w+\//,
  /^\/workspace\//,
];

function stripContainerPrefix(filePath: string): string {
  for (const prefix of PATH_PREFIXES_TO_STRIP) {
    if (prefix.test(filePath)) {
      return filePath.replace(prefix, "");
    }
  }
  return filePath;
}

// Node.js: "    at functionName (src/api/payments.ts:142:18)"
// Also matches: "    at src/api/payments.ts:142:18" (no function name)
const NODE_JS_FRAME =
  /at\s+(?:(.+?)\s+\()?(.+?):(\d+)(?::(\d+))?\)?/;

// Python: '  File "src/api/payments.py", line 142, in process_payment'
const PYTHON_FRAME =
  /File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?/;

// Go: "goroutine 1 [running]:" followed by "src/api/payments.go:142"
// or "src/api/payments.go:142 +0x1a3"
const GO_FRAME =
  /^\s*(.+\.go):(\d+)/;

// Java/Kotlin: "at com.example.MyClass.method(MyClass.java:42)"
// Distinctive: parenthesized (File.java:line) or (File.kt:line) pattern
const JAVA_FRAME =
  /at\s+([a-zA-Z0-9_.]+(?:\$[a-zA-Z0-9_]+)*)\(([^)]+\.(?:java|kt)):(\d+)\)/;

// Rust: backtrace "at" lines: "             at src/main.rs:42:13"
// Also matches: "thread 'main' panicked at src/main.rs:10:5"
const RUST_FRAME =
  /at\s+(.+\.rs):(\d+)(?::(\d+))?/;

// C#: "   at Namespace.Class.Method() in /path/File.cs:line 42"
const CSHARP_FRAME =
  /at\s+([a-zA-Z0-9_.]+)\([^)]*\)\s+in\s+(.+\.cs):line\s+(\d+)/;

// Ruby: "file.rb:42:in `method_name'" or "/path/file.rb:42:in `method'"
const RUBY_FRAME =
  /^(.+\.rb):(\d+)(?::in\s+[`'](.+?)'?)?/;

// PHP: "#0 /path/file.php(42): ClassName->method()" or "#0 file.php(42): function()"
const PHP_FRAME =
  /#\d+\s+(.+\.php)\((\d+)\)(?::\s+(.+?)(?:\(|$))?/;

// Swift: crash log "4   MyApp   0x... ClassName.method + 42 (File.swift:42)"
// Also: "  #0 0x... at File.swift:42"
const SWIFT_FRAME =
  /(?:at\s+)?(.+\.swift):(\d+)(?::(\d+))?/;

/**
 * Parse a raw stack trace string into structured frames.
 * Returns an empty array if no frames could be parsed (never throws).
 */
export function parseStackTrace(stackTrace: string): ParsedFrame[] {
  if (!stackTrace) return [];

  const frames: ParsedFrame[] = [];
  const lines = stackTrace.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Try Rust format first — both Rust and Node.js use "at" prefix,
    // but Rust frames always end in .rs so check them first to avoid
    // the Node.js regex swallowing Rust frames
    const rustMatch = trimmed.match(RUST_FRAME);
    if (rustMatch) {
      const filePath = stripContainerPrefix(rustMatch[1]);
      // Skip external crate frames, cargo registry, and rustc internals
      if (
        filePath.includes(".cargo/registry/") ||
        filePath.includes(".rustup/") ||
        filePath.includes("/rustc/")
      ) continue;
      frames.push({
        filePath,
        lineNumber: parseInt(rustMatch[2], 10),
        columnNumber: rustMatch[3] ? parseInt(rustMatch[3], 10) : undefined,
      });
      continue;
    }

    // Try Swift format early — Swift uses "at" prefix like Node.js,
    // but ends in .swift. Must check before Node.js regex.
    const swiftMatch = trimmed.match(SWIFT_FRAME);
    if (swiftMatch) {
      const filePath = stripContainerPrefix(swiftMatch[1]);
      if (
        filePath.includes("/Xcode.app/") ||
        filePath.includes("/usr/lib/swift/")
      ) continue;
      frames.push({
        filePath,
        lineNumber: parseInt(swiftMatch[2], 10),
        columnNumber: swiftMatch[3] ? parseInt(swiftMatch[3], 10) : undefined,
      });
      continue;
    }

    // Try Java/Kotlin format — also uses "at" prefix but has distinctive
    // parenthesized (File.java:42) pattern. Must be before Node.js regex.
    const javaMatch = trimmed.match(JAVA_FRAME);
    if (javaMatch) {
      const functionName = javaMatch[1];
      const fileName = javaMatch[2];
      const lineNumber = parseInt(javaMatch[3], 10);
      // Skip common framework internals
      if (
        functionName.startsWith("java.") ||
        functionName.startsWith("javax.") ||
        functionName.startsWith("sun.") ||
        functionName.startsWith("jdk.") ||
        functionName.startsWith("kotlin.") ||
        functionName.startsWith("kotlinx.coroutines.")
      ) continue;
      frames.push({
        functionName,
        filePath: fileName,
        lineNumber,
      });
      continue;
    }

    // Try Node.js format
    const nodeMatch = trimmed.match(NODE_JS_FRAME);
    if (nodeMatch) {
      const filePath = stripContainerPrefix(nodeMatch[2]);
      // Skip node_modules and internal frames
      if (filePath.includes("node_modules/") || filePath.startsWith("node:")) continue;
      frames.push({
        functionName: nodeMatch[1] || undefined,
        filePath,
        lineNumber: parseInt(nodeMatch[3], 10),
        columnNumber: nodeMatch[4] ? parseInt(nodeMatch[4], 10) : undefined,
      });
      continue;
    }

    // Try Python format
    const pyMatch = trimmed.match(PYTHON_FRAME);
    if (pyMatch) {
      const filePath = stripContainerPrefix(pyMatch[1]);
      if (filePath.includes("site-packages/") || filePath.startsWith("<")) continue;
      frames.push({
        filePath,
        lineNumber: parseInt(pyMatch[2], 10),
        functionName: pyMatch[3] || undefined,
      });
      continue;
    }

    // Try Go format
    const goMatch = trimmed.match(GO_FRAME);
    if (goMatch) {
      const filePath = stripContainerPrefix(goMatch[1]);
      if (filePath.includes("/pkg/mod/")) continue;
      frames.push({
        filePath,
        lineNumber: parseInt(goMatch[2], 10),
      });
      continue;
    }

    // Try C# format — uses "at" prefix but has distinctive "in File.cs:line N" pattern
    const csharpMatch = trimmed.match(CSHARP_FRAME);
    if (csharpMatch) {
      const functionName = csharpMatch[1];
      const filePath = stripContainerPrefix(csharpMatch[2]);
      // Skip framework internals
      if (
        functionName.startsWith("System.") ||
        functionName.startsWith("Microsoft.") ||
        filePath.includes("/usr/share/dotnet/")
      ) continue;
      frames.push({
        functionName,
        filePath,
        lineNumber: parseInt(csharpMatch[3], 10),
      });
      continue;
    }

    // Try Ruby format
    const rubyMatch = trimmed.match(RUBY_FRAME);
    if (rubyMatch) {
      const filePath = stripContainerPrefix(rubyMatch[1]);
      if (filePath.includes("/gems/") || filePath.includes("/ruby/")) continue;
      frames.push({
        filePath,
        lineNumber: parseInt(rubyMatch[2], 10),
        functionName: rubyMatch[3] || undefined,
      });
      continue;
    }

    // Try PHP format
    const phpMatch = trimmed.match(PHP_FRAME);
    if (phpMatch) {
      const filePath = stripContainerPrefix(phpMatch[1]);
      if (filePath.includes("/vendor/")) continue;
      frames.push({
        filePath,
        lineNumber: parseInt(phpMatch[2], 10),
        functionName: phpMatch[3] || undefined,
      });
      continue;
    }

  }

  return frames;
}
