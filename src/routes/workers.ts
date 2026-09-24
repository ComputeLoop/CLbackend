import { Elysia, t } from "elysia";
import { and, count, desc, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../db";
import { jobs, workers } from "../db/schema";
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
