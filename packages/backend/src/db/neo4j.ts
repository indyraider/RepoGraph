import neo4j, { Driver, Session } from "neo4j-driver";
import { config } from "../config.js";

let driver: Driver;

export function getNeo4jDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(
      config.neo4j.uri,
      neo4j.auth.basic(config.neo4j.username, config.neo4j.password)
    );
  }
  return driver;
}

export function getSession(): Session {
  return getNeo4jDriver().session({ database: config.neo4j.database });
}

export async function verifyNeo4jConnection(): Promise<boolean> {
  const session = getSession();
  try {
    await session.run("RETURN 1");
    return true;
  } catch (err) {
    console.error("Neo4j connection failed:", err);
    return false;
  } finally {
    await session.close();
  }
}

export async function initNeo4jIndexes(): Promise<void> {
  const session = getSession();
  try {
    const indexes = [
      "CREATE CONSTRAINT repo_url IF NOT EXISTS FOR (r:Repository) REQUIRE r.url IS UNIQUE",
      "CREATE INDEX file_path IF NOT EXISTS FOR (f:File) ON (f.path)",
      "CREATE INDEX function_name IF NOT EXISTS FOR (fn:Function) ON (fn.name)",
      "CREATE INDEX class_name IF NOT EXISTS FOR (c:Class) ON (c.name)",
      "CREATE INDEX typedef_name IF NOT EXISTS FOR (t:TypeDef) ON (t.name)",
      "CREATE INDEX package_name IF NOT EXISTS FOR (p:Package) ON (p.name)",
    ];
    for (const idx of indexes) {
      await session.run(idx);
    }
    console.log("Neo4j indexes created");
  } finally {
    await session.close();
  }
}

export async function closeNeo4j(): Promise<void> {
  if (driver) {
    await driver.close();
  }
}
