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
  opType: text("op_type").notNull().default("image-hash"),
  datasetId: text("dataset_id"),
  splitType: text("split_type"),
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
  apiKeyHash: text("api_key_hash").notNull(),
  status: text("status").notNull().default("IDLE"),
  lastHeartbeat: text("last_heartbeat"),
  createdAt: text("created_at").notNull(),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Dataset = typeof datasets.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Worker = typeof workers.$inferSelect;