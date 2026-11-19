import { Database } from "bun:sqlite";
import { DB_PATH } from "../config";
import { initializeWorkspaces } from "./workspaceSchema";

const sqlite = new Database(DB_PATH);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL
  );
`);

// Keep the legacy column for compatibility with existing databases and auth's schema.
if (!sqlite.query("SELECT 1 FROM pragma_table_info('users') WHERE name = 'credit_balance'").get()) {
  sqlite.exec("ALTER TABLE users ADD COLUMN credit_balance INTEGER NOT NULL DEFAULT 1000");
}
initializeWorkspaces(sqlite);
sqlite.close();

console.log("📦 Database initialized");
