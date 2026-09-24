import {
  sqliteTable,
  text,
  integer,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: text("expires_at").notNull(),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  totalJobs: integer("total_jobs").notNull(),
  completedJobs: integer("completed_jobs").notNull().default(0),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  ownerId: text("owner_id").notNull().references(() => users.id),

  // Operation this project runs over its dataset chunks.
  opType: text("op_type").notNull().default("image-hash"),
  // Uploaded dataset (raw file).
  datasetId: text("dataset_id"),
  // How chunks slice the dataset: "file-list" | "tabular".
  splitType: text("split_type"),
  // Merged artifact produced when every chunk completed.
  mergedKey: text("merged_key"),
  mergedAt: text("merged_at"),
});

export const datasets = sqliteTable("datasets", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  name: text("name").notNull(),
  originalName: text("original_name").notNull(),
  // Storage key of the raw uploaded file.
  storageKey: text("storage_key").notNull(),
  // "file-list" (zip of files) | "tabular" (csv/tsv/jsonl).
  format: text("format").notNull(),
  itemCount: integer("item_count"),
  sizeBytes: integer("size_bytes").notNull(),
  status: text("status").notNull().default("UPLOADED"),
  createdAt: text("created_at").notNull(),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),

  jobNumber: integer("job_number").notNull(),

  status: text("status").notNull(),

  workerId: text("worker_id"),

  inputStart: integer("input_start").notNull(),
  inputEnd: integer("input_end").notNull(),

  result: text("result"),

  // Storage key of the raw input this chunk reads (tabular, for ranged GET).
  inputKey: text("input_key"),
  // JSON manifest describing the slice:
  //   file-list: [{ path, size, key }]
  //   tabular:   { key, byteStart, byteEnd, rowStart, rowEnd, header }
  inputManifest: text("input_manifest"),

  // Storage key of the produced output (worker uploads here).
  outputKey: text("output_key"),
  // SHA-256 hex of the uploaded output, reported by the worker.
  outputHash: text("output_hash"),

  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  durationMs: integer("duration_ms"),
  gpuName: text("gpu_name"),

  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
});

export const workers = sqliteTable("workers", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  gpuName: text("gpu_name"),
  vramMb: integer("vram_mb"),
  apiKeyHash: text("api_key_hash").notNull(),
  status: text("status").notNull().default("IDLE"),
  lastHeartbeat: text("last_heartbeat"),
  createdAt: text("created_at").notNull(),
});