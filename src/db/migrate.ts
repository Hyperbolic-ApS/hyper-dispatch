import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql } from "./connection.js";
import { ensureAdminUserSeeded } from "../auth/queries.js";
import { hashPassword } from "../auth/password.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const schemaPath = join(__dirname, "schema.sql");
  const schema = await readFile(schemaPath, "utf-8");
  await sql.unsafe(schema);

  // Additive column migrations — safe to run repeatedly
  await sql.unsafe(`
    ALTER TABLE project_configs
      ADD COLUMN IF NOT EXISTS github_pat TEXT,
      ADD COLUMN IF NOT EXISTS jira_api_token TEXT,
      ADD COLUMN IF NOT EXISTS jira_email TEXT;
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash    TEXT NOT NULL UNIQUE,
      expires_at    TIMESTAMPTZ NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS invite_links (
      id                 TEXT PRIMARY KEY,
      token_hash         TEXT NOT NULL UNIQUE,
      created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      used_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      used_at            TIMESTAMPTZ,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_invite_links_token_hash ON invite_links(token_hash);
  `);

  await ensureAdminUserSeeded({
    email: "kasper.welner@hyperbolic.dk",
    passwordHash: hashPassword("Nodes2020!"),
  });

  console.log("Database migrations applied successfully");
}
