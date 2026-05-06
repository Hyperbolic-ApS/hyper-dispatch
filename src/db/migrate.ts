import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql } from "./connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const schemaPath = join(__dirname, "schema.sql");
  const schema = await readFile(schemaPath, "utf-8");
  await sql.unsafe(schema);
  console.log("Database migrations applied successfully");
}
