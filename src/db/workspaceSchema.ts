import type { Database } from "bun:sqlite";

export function initializeWorkspaces(sqlite: Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
      paid_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')), PRIMARY KEY (workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS workspace_invites (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id),
      PRIMARY KEY (workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS team_workers (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
      name TEXT NOT NULL, key_hash TEXT NOT NULL, last_seen INTEGER, gpu TEXT
    );
    CREATE TABLE IF NOT EXISTS team_apps (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL, gpu INTEGER NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_jobs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      app_id TEXT NOT NULL REFERENCES team_apps(id), name TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS team_jobs_app ON team_jobs(app_id);
    CREATE TABLE IF NOT EXISTS team_tasks (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES team_jobs(id), position INTEGER NOT NULL,
      label TEXT NOT NULL, args TEXT NOT NULL, input_bytes INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending', worker_id TEXT, lease TEXT, expires INTEGER,
      error TEXT, duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS team_tasks_job ON team_tasks(job_id, position);
    CREATE TABLE IF NOT EXISTS demo_wallets (
      user_id TEXT PRIMARY KEY REFERENCES users(id), balance INTEGER NOT NULL CHECK(balance >= 0)
    );
    CREATE TABLE IF NOT EXISTS demo_ledger (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), workspace_id TEXT,
      amount INTEGER NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL
    );
  `);
  const addColumn = (table: string, column: string, definition: string) => {
    if (!sqlite.query(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
  addColumn("team_apps", "source_url", "TEXT");
  addColumn("team_apps", "instructions", "TEXT NOT NULL DEFAULT ''");
  addColumn("team_apps", "package_id", "TEXT");
  addColumn("team_jobs", "result_instructions", "TEXT NOT NULL DEFAULT ''");
  addColumn("team_tasks", "claimed_by", "TEXT REFERENCES users(id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS team_tasks_claimed_by ON team_tasks(claimed_by, state)");
}
