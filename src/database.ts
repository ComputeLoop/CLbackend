import { Database } from "bun:sqlite";

export const db = new Database("computeloop.db");

db.run(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    total_jobs INTEGER NOT NULL,
    completed_jobs INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    job_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    worker_id TEXT,
    input_start INTEGER NOT NULL,
    input_end INTEGER NOT NULL,
    result TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  )
`);

console.log("📦 SQLite database ready");