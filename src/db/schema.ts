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
  creditBalance: integer("credit_balance").notNull().default(1000),
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
  opType: text("op_type").notNull().default("image-hash"),
  datasetId: text("dataset_id"),
  splitType: text("split_type"),
  mergedKey: text("merged_key"),
  mergedAt: text("merged_at"),
  rewardPerChunk: integer("reward_per_chunk").notNull().default(10),
  escrowCredits: integer("escrow_credits").notNull().default(0),
});

export const datasets = sqliteTable("datasets", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  name: text("name").notNull(),
  originalName: text("original_name").notNull(),
  storageKey: text("storage_key").notNull(),
  format: text("format").$type<"file-list" | "tabular">().notNull(),
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
  inputKey: text("input_key"),
  inputManifest: text("input_manifest"),
  outputKey: text("output_key"),
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
  cudaReady: integer("cuda_ready", { mode: "boolean" }).notNull().default(false),
  apiKeyHash: text("api_key_hash").notNull(),
  status: text("status").notNull().default("IDLE"),
  lastHeartbeat: text("last_heartbeat"),
  createdAt: text("created_at").notNull(),
});

export const operations = sqliteTable("operations", {
  type: text("type").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  splitKind: text("split_kind").$type<"file-list" | "tabular">().notNull(),
  defaultChunkSize: integer("default_chunk_size").notNull(),
  gpu: integer("gpu", { mode: "boolean" }).notNull().default(false),
  outputFormat: text("output_format").notNull(),
  instructions: text("instructions"),
  status: text("status").notNull().default("BUILTIN"),
  createdAt: text("created_at").notNull(),
});

export const creditTransactions = sqliteTable("credit_transactions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  projectId: text("project_id").references(() => projects.id),
  jobId: text("job_id").references(() => jobs.id),
  kind: text("kind").notNull(),
  amount: integer("amount").notNull(),
  note: text("note").notNull(),
  createdAt: text("created_at").notNull(),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Dataset = typeof datasets.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Worker = typeof workers.$inferSelect;
