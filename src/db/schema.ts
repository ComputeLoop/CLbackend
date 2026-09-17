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
  ownerId:text("owner_id").notNull().references(()=>users.id)
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
});