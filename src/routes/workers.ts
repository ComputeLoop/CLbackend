import { Elysia, t } from "elysia";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../db";
import { creditTransactions, jobs, projects, users, workers } from "../db/schema";
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
        cudaReady: worker.cudaReady,
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
        rewardPerChunk: projects.rewardPerChunk,
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

    return rows.flatMap((project) => {
      const op = getOperation(project.opType);
      if (!op) return [];
      const pendingJobs = db
        .select({ count: count() })
        .from(jobs)
        .where(and(eq(jobs.projectId, project.id), eq(jobs.status, "PENDING")))
        .get()?.count ?? 0;
      if (pendingJobs === 0) return [];
      return {
        id: project.id,
        name: project.name,
        description: project.description,
        opType: project.opType,
        opName: op?.name ?? project.opType,
        gpu: op?.gpu ?? false,
        requiresCuda: op?.gpu ?? false,
        rewardPerChunk: project.rewardPerChunk,
        status: project.status,
        owner: project.ownerUsername,
        totalJobs: project.totalJobs,
        completedJobs: project.completedJobs,
        pendingJobs,
        createdAt: project.createdAt,
      };
    });
  })
  .get("/projects/:projectId/chunks", ({ params, request, status }) => {
    const worker = getWorkerFromRequest(request);
    if (!worker) return status(401, { message: "Invalid worker API key" });

    const project = db
      .select({ id: projects.id, opType: projects.opType })
      .from(projects)
      .where(eq(projects.id, params.projectId))
      .get();
    if (!project) return status(404, { message: "Project not found" });

    const operation = getOperation(project.opType);
    if (!operation) return status(404, { message: "No supported operation for this project" });
    return db
      .select({ id: jobs.id, jobNumber: jobs.jobNumber, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.projectId, project.id), eq(jobs.status, "PENDING")))
      .orderBy(jobs.jobNumber)
      .all();
  })
  .get("/me", ({ request, status }) => {
    const worker = getWorkerFromRequest(request);
    if (!worker) return status(401, { message: "Invalid worker API key" });

    const stats = db
      .select({ completed: count() })
      .from(jobs)
      .where(and(eq(jobs.workerId, worker.id), eq(jobs.status, "COMPLETED")))
      .get();

    const account = db
      .select({ creditBalance: users.creditBalance })
      .from(users)
      .where(eq(users.id, worker.userId))
      .get();
    const earned = db
      .select({ total: sql<number>`COALESCE(SUM(${creditTransactions.amount}), 0)` })
      .from(creditTransactions)
      .where(and(
        eq(creditTransactions.userId, worker.userId),
        eq(creditTransactions.kind, "EARNED"),
      ))
      .get();

    return {
      worker: { ...worker, apiKeyHash: undefined },
      completedChunks: stats?.completed ?? 0,
      creditBalance: account?.creditBalance ?? 0,
      creditsEarned: earned?.total ?? 0,
    };
  })
  .post("/heartbeat", async ({ request, status }) => {
    const worker = getWorkerFromRequest(request);
    if (!worker) return status(401, { message: "Invalid worker API key" });

    let body: { gpuName?: string | null; cudaReady?: boolean } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      // Legacy workers may send an empty heartbeat body.
    }

    const updates: {
      status: string;
      lastHeartbeat: string;
      gpuName?: string | null;
      cudaReady?: boolean;
    } = {
      status: "IDLE",
      lastHeartbeat: new Date().toISOString(),
    };
    if (typeof body.gpuName === "string" || body.gpuName === null) {
      updates.gpuName = body.gpuName;
    }
    if (typeof body.cudaReady === "boolean") {
      updates.cudaReady = body.cudaReady;
    }

    db.update(workers)
      .set(updates)
      .where(eq(workers.id, worker.id))
      .run();

    return { ok: true, workerId: worker.id };
  });
