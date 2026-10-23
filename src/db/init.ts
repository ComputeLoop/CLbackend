import { Database } from "bun:sqlite";
import { DB_PATH } from "../config";
import { BUILTIN_OPERATIONS } from "../services/operationCatalog";

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
addColumn(`ALTER TABLE users ADD COLUMN credit_balance INTEGER NOT NULL DEFAULT 1000`);
addColumn(`ALTER TABLE projects ADD COLUMN reward_per_chunk INTEGER NOT NULL DEFAULT 10`);
addColumn(`ALTER TABLE projects ADD COLUMN escrow_credits INTEGER NOT NULL DEFAULT 0`);

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
    cuda_ready INTEGER NOT NULL DEFAULT 0,
    api_key_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'IDLE',
    last_heartbeat TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS operations (
    type TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    split_kind TEXT NOT NULL,
    default_chunk_size INTEGER NOT NULL,
    gpu INTEGER NOT NULL DEFAULT 0,
    output_format TEXT NOT NULL,
    instructions TEXT,
    status TEXT NOT NULL DEFAULT 'BUILTIN',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS credit_transactions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    project_id TEXT,
    job_id TEXT,
    kind TEXT NOT NULL,
    amount INTEGER NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  );
`);
addColumn(`ALTER TABLE workers ADD COLUMN cuda_ready INTEGER NOT NULL DEFAULT 0`);

const insertOperation = sqlite.prepare(`
  INSERT OR IGNORE INTO operations (
    type, name, description, split_kind, default_chunk_size, gpu,
    output_format, instructions, status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'BUILTIN', ?)
`);
const seedTimestamp = new Date().toISOString();
for (const operation of BUILTIN_OPERATIONS) {
  insertOperation.run(
    operation.type,
    operation.name,
    operation.description,
    operation.splitKind,
    operation.defaultChunkSize,
    operation.gpu ? 1 : 0,
    operation.outputFormat,
    operation.instructions ?? null,
    seedTimestamp,
  );
}

const demoGrantRows = sqlite
  .query(`
    SELECT id, credit_balance FROM users
    WHERE NOT EXISTS (
      SELECT 1 FROM credit_transactions
      WHERE credit_transactions.user_id = users.id
        AND credit_transactions.kind = 'DEMO_GRANT'
    )
  `)
  .all() as { id: string; credit_balance: number }[];
const insertDemoGrant = sqlite.prepare(`
  INSERT INTO credit_transactions (id, user_id, kind, amount, note, created_at)
  VALUES (?, ?, 'DEMO_GRANT', ?, 'Beta demo starting balance', ?)
`);
for (const user of demoGrantRows) {
  insertDemoGrant.run(
    crypto.randomUUID(),
    user.id,
    user.credit_balance,
    new Date().toISOString(),
  );
}

sqlite.close();

console.log("📦 Database initialized");
