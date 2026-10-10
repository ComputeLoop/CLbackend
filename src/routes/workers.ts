import { Elysia, t } from "elysia";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../db";
import { jobs, projects, users, workers } from "../db/schema";
import { getOperation } from "../services/operations";
import {
  getWorkerFromRequest,
  requireUser,
  sha256hex,
} from "../services/auth";

export const workerRoutes = new Elysia({ prefix: "/workers" })
  .post(
    "/register",
    ({ body, cookie, status }) => {
      const user = requireUser(cookie);
      if (!user) return status(401, { message: "Not authenticated" });

      const workerId = crypto.randomUUID();
      const secret = randomBytes(24).toString("hex");
      const apiKey = `clw_${workerId}_${secret}`;

      db.insert(workers)
        .values({
          id: workerId,
          userId: user.id,
          name: body.name,
          gpuName: body.gpuName ?? null,
          vramMb: body.vramMb ?? null,
          apiKeyHash: sha256hex(apiKey),
          status: "IDLE",
          lastHeartbeat: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        })
        .run();

      return {
        worker: { id: workerId, name: body.name, gpuName: body.gpuName },
        apiKey,
        command: `WORKER_API_KEY=${apiKey} bun run index.ts <projectId>`,
      };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        gpuName: t.Optional(t.String()),
        vramMb: t.Optional(t.Number()),
      }),
    },
  )
  .get("/", ({ cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });

    const rows = db
      .select()
      .from(workers)
      .where(eq(workers.userId, user.id))
      .orderBy(desc(workers.createdAt))
      .all();

    return rows.map((worker) => {
      const stats = db
        .select({ completed: count() })
        .from(jobs)
        .where(
          and(
            eq(jobs.workerId, worker.id),
            eq(jobs.status, "COMPLETED"),
          ),
        )
        .get();

      const online =
        worker.lastHeartbeat != null &&
        Date.now() - new Date(worker.lastHeartbeat).getTime() < 60_000;

      return {
        id: worker.id,
        name: worker.name,
        gpuName: worker.gpuName,
        vramMb: worker.vramMb,
        status: worker.status,
        lastHeartbeat: worker.lastHeartbeat,
        online,
        completedChunks: stats?.completed ?? 0,
        createdAt: worker.createdAt,
      };
    });
  })
  .get("/projects", ({ request, status }) => {
    const worker = getWorkerFromRequest(request);
    if (!worker) return status(401, { message: "Invalid worker API key" });

   
    const rows = db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        opType: projects.opType,
        status: projects.status,
        ownerId: projects.ownerId,
        ownerUsername: users.username,
        totalJobs: projects.totalJobs,
        completedJobs: projects.completedJobs,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.ownerId))
      .where(
        and(
          sql`${projects.totalJobs} > 0`,
          sql`${projects.completedJobs} < ${projects.totalJobs}`,
        ),
      )
      .orderBy(desc(projects.createdAt))
      .all();

    return rows.map((project) => {
      const op = getOperation(project.opType);
      return {
        id: project.id,
        name: project.name,
        description: project.description,
        opType: project.opType,
        opName: op?.name ?? project.opType,
        gpu: op?.gpu ?? false,
        status: project.status,
        owner: project.ownerUsername,
        totalJobs: project.totalJobs,
        completedJobs: project.completedJobs,
        pendingJobs: project.totalJobs - project.completedJobs,
        createdAt: project.createdAt,
      };
    });
  })
  .get("/me", ({ request, status }) => {
    const worker = getWorkerFromRequest(request);
    if (!worker) return status(401, { message: "Invalid worker API key" });

    const stats = db
      .select({ completed: count() })
      .from(jobs)
      .where(and(eq(jobs.workerId, worker.id), eq(jobs.status, "COMPLETED")))
      .get();

    return {
      worker: { ...worker, apiKeyHash: undefined },
      completedChunks: stats?.completed ?? 0,
    };
  })
  .post("/heartbeat", ({ request, status }) => {
    const worker = getWorkerFromRequest(request);
    if (!worker) return status(401, { message: "Invalid worker API key" });

    db.update(workers)
      .set({ status: "IDLE", lastHeartbeat: new Date().toISOString() })
      .where(eq(workers.id, worker.id))
      .run();

    return { ok: true, workerId: worker.id };
  });
