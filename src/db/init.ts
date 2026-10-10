import { Database } from "bun:sqlite";
import { DB_PATH } from "../config";

const sqlite = new Database(DB_PATH);

function addColumn(statement: string) {
  try {
    sqlite.run(statement);
  } catch {}
}

sqlite.run(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    total_jobs INTEGER NOT NULL,
    completed_jobs INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    job_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    worker_id TEXT,
    input_start INTEGER NOT NULL,
    input_end INTEGER NOT NULL,
    result TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );
`);

addColumn(`ALTER TABLE projects ADD COLUMN op_type TEXT DEFAULT 'image-hash'`);
addColumn(`ALTER TABLE projects ADD COLUMN dataset_id TEXT`);
addColumn(`ALTER TABLE projects ADD COLUMN split_type TEXT`);
addColumn(`ALTER TABLE projects ADD COLUMN merged_key TEXT`);
addColumn(`ALTER TABLE projects ADD COLUMN merged_at TEXT`);

addColumn(`ALTER TABLE jobs ADD COLUMN input_key TEXT`);
addColumn(`ALTER TABLE jobs ADD COLUMN input_manifest TEXT`);
addColumn(`ALTER TABLE jobs ADD COLUMN output_key TEXT`);
addColumn(`ALTER TABLE jobs ADD COLUMN output_hash TEXT`);
addColumn(`ALTER TABLE jobs ADD COLUMN started_at TEXT`);
addColumn(`ALTER TABLE jobs ADD COLUMN completed_at TEXT`);
addColumn(`ALTER TABLE jobs ADD COLUMN duration_ms INTEGER`);
addColumn(`ALTER TABLE jobs ADD COLUMN gpu_name TEXT`);
addColumn(`ALTER TABLE jobs ADD COLUMN attempts INTEGER DEFAULT 0`);
addColumn(`ALTER TABLE jobs ADD COLUMN error TEXT`);

sqlite.run(`
  CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    format TEXT NOT NULL,
    item_count INTEGER,
    size_bytes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'UPLOADED',
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    gpu_name TEXT,
    vram_mb INTEGER,
    api_key_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'IDLE',
    last_heartbeat TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

sqlite.close();

console.log("📦 Database initialized");