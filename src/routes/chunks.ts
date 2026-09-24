import { Elysia, t } from "elysia";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { jobs, projects, workers } from "../db/schema";
import { requireWorker } from "../services/auth";
import {
  claimJob,
  getProject,
  jobFields,
  JSONL_OPS,
  mergeProject,
  projectFields,
  sweepStaleJobs,
} from "../services/projects";
import { getOperation } from "../services/operations";
import { signUrl } from "../services/storage";
import { MAX_FAIL_ATTEMPTS } from "../config";

interface TabularManifestData {
  kind: "tabular";
  key: string;
  byteStart: number;
  byteEnd: number;
  rowStart: number;
  rowEnd: number;
  header: string;
}

interface FileListManifestData {
  kind: "file-list";
  items: { path: string; size: number; key: string }[];
}

type ChunkManifestData = TabularManifestData | FileListManifestData;

export const chunkRoutes = new Elysia({ prefix: "/chunks" })
  .get(
    "/next",
    ({ query, request, status }) => {
      const worker = requireWorker(request);
      if (!worker) return status(401, { message: "Invalid worker API key" });

      const project = getProject(query.projectId);
      if (!project) return status(404, { message: "Project not found" });

      sweepStaleJobs();

      const op = getOperation(project.opType);
      const isJsonl = op != null && JSONL_OPS.has(op.type);
      const outputKey = `projects/${project.id}/outputs/${crypto.randomUUID()}.${isJsonl ? "jsonl" : "json"}`;

      const job = claimJob(worker.id, project.id, outputKey);
      if (!job) {
        return status(404, { message: "No chunks available" });
      }

      db.update(workers)
        .set({ status: "WORKING" })
        .where(eq(workers.id, worker.id))
        .run();

      let manifest: ChunkManifestData | null = null;
      try {
        manifest = job.inputManifest ? JSON.parse(job.inputManifest) : null;
      } catch {
        manifest = null;
      }

      let input;
      if (manifest && manifest.kind === "tabular") {
        input = {
          kind: "tabular",
          url: signUrl("GET", manifest.key),
          range: { start: manifest.byteStart, end: manifest.byteEnd - 1 },
          rowStart: manifest.rowStart,
          rowEnd: manifest.rowEnd,
          header: manifest.header,
          bytes: manifest.byteEnd - manifest.byteStart,
        };
      } else if (manifest && manifest.kind === "file-list") {
        input = {
          kind: "file-list",
          items: manifest.items.map((item) => ({
            path: item.path,
            size: item.size,
            url: signUrl("GET", item.key),
          })),
        };
      } else {
        return status(500, { message: "Malformed chunk manifest" });
      }

      return {
        id: job.id,
        projectId: job.projectId,
        jobNumber: job.jobNumber,
        status: "RUNNING",
        workerId: worker.id,
        opType: op?.type ?? "unknown",
        opName: op?.name ?? "Unknown",
        gpu: op?.gpu ?? false,
        instructions: op?.instructions ?? null,
        attempts: job.attempts,
        input,
        output: { key: outputKey, url: signUrl("PUT", outputKey) },
      };
    },
    {
      query: t.Object({
        projectId: t.String(),
      }),
    },
  )
  .post(
    "/:id/complete",
    async ({ params, body, request, status }) => {
      const worker = requireWorker(request);
      if (!worker) return status(401, { message: "Invalid worker API key" });

      const job = db
        .select(jobFields)
        .from(jobs)
        .where(eq(jobs.id, params.id))
        .get();
      if (!job) return status(404, { message: "Chunk not found" });
      if (job.workerId !== worker.id) {
        return status(403, { message: "Chunk claimed by another worker" });
      }
      if (job.status !== "RUNNING") {
        return status(400, { message: "Chunk is not running" });
      }
      if (!/^[0-9a-f]{64}$/i.test(body.outputHash)) {
        return status(400, { message: "outputHash must be a sha256 hex digest" });
      }

      const completedAt = new Date().toISOString();

      const project = db.transaction((tx) => {
        tx.update(jobs)
          .set({
            status: "COMPLETED",
            result: body.result ?? null,
            outputHash: body.outputHash,
            completedAt,
            durationMs: body.durationMs ?? null,
            gpuName: body.gpuName ?? worker.gpuName ?? null,
          })
          .where(eq(jobs.id, job.id))
          .run();

        tx.update(projects)
          .set({ completedJobs: sql`${projects.completedJobs} + 1` })
          .where(eq(projects.id, job.projectId))
          .run();

        const updatedProject = tx
          .select(projectFields)
          .from(projects)
          .where(eq(projects.id, job.projectId))
          .get();

        if (!updatedProject) return null;

        const newStatus =
          updatedProject.completedJobs >= updatedProject.totalJobs
            ? "COMPLETED"
            : "RUNNING";
        tx.update(projects)
          .set({ status: newStatus })
          .where(eq(projects.id, job.projectId))
          .run();

        return { ...updatedProject, status: newStatus };
      });

      db.update(workers)
        .set({ status: "IDLE", lastHeartbeat: completedAt })
        .where(eq(workers.id, worker.id))
        .run();

      let merge = null;
      if (project && project.status === "COMPLETED") {
        merge = await mergeProject(job.projectId);
      }

      return {
        message: "Chunk completed",
        job: { ...job, status: "COMPLETED", outputHash: body.outputHash },
        project,
        merge,
      };
    },
    {
      body: t.Object({
        outputHash: t.String(),
        result: t.Optional(t.String()),
        durationMs: t.Optional(t.Number()),
        gpuName: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/:id/fail",
    ({ params, body, request, status }) => {
      const worker = requireWorker(request);
      if (!worker) return status(401, { message: "Invalid worker API key" });

      const job = db
        .select(jobFields)
        .from(jobs)
        .where(eq(jobs.id, params.id))
        .get();
      if (!job) return status(404, { message: "Chunk not found" });
      if (job.workerId !== worker.id) {
        return status(403, { message: "Chunk claimed by another worker" });
      }
      if (job.status !== "RUNNING") {
        return status(400, { message: "Chunk is not running" });
      }

      const attempts = job.attempts + 1;
      const reason = body.reason ?? "worker reported failure";

      if (body.permanent === true || attempts >= MAX_FAIL_ATTEMPTS) {
        db.update(jobs)
          .set({
            status: "FAILED",
            attempts,
            error: reason,
            completedAt: new Date().toISOString(),
          })
          .where(eq(jobs.id, job.id))
          .run();
      } else {
        db.update(jobs)
          .set({
            status: "PENDING",
            workerId: null,
            attempts,
            error: reason,
          })
          .where(eq(jobs.id, job.id))
          .run();
      }

      db.update(workers)
        .set({ status: "IDLE", lastHeartbeat: new Date().toISOString() })
        .where(eq(workers.id, worker.id))
        .run();

      return {
        message: "Chunk failure recorded",
        attempts,
        requeued: body.permanent !== true && attempts < MAX_FAIL_ATTEMPTS,
      };
    },
    {
      body: t.Object({
        reason: t.Optional(t.String()),
        permanent: t.Optional(t.Boolean()),
      }),
    },
  );
