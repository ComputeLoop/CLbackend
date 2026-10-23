import { Elysia, t } from "elysia";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db";
import { creditTransactions, jobs, operations, projects, users, workers } from "../db/schema";
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
import { readObject, signUrl } from "../services/storage";
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

      sweepStaleJobs();

      let projectId = query.projectId;
      const selectedJobId = query.jobId;
      if (selectedJobId && !projectId) {
        return status(400, { message: "projectId is required when selecting a chunk" });
      }
      let project = projectId ? getProject(projectId) : undefined;
      if (projectId && !project) {
        return status(404, { message: "Project not found" });
      }

      if (project && getOperation(project.opType)?.gpu && !worker.cudaReady) {
        return status(409, {
          message: "This operation requires a worker with a verified NVIDIA CUDA runtime.",
        });
      }

      const candidateProjects = projectId
        ? [{ id: projectId }]
        : db
            .select({ id: projects.id })
            .from(jobs)
            .innerJoin(projects, eq(projects.id, jobs.projectId))
            .innerJoin(operations, eq(operations.type, projects.opType))
            .where(
              and(
                eq(jobs.status, "PENDING"),
                eq(operations.status, "BUILTIN"),
                ...(worker.cudaReady ? [] : [eq(operations.gpu, false)]),
              ),
            )
            .orderBy(desc(operations.gpu), asc(projects.createdAt), asc(jobs.jobNumber))
            .limit(100)
            .all();

      const visited = new Set<string>();
      let job = null as ReturnType<typeof claimJob>;
      for (const candidate of candidateProjects) {
        if (visited.has(candidate.id)) continue;
        visited.add(candidate.id);
        const candidateProject = getProject(candidate.id);
        if (!candidateProject) continue;
        const op = getOperation(candidateProject.opType);
        if (!op || (op.gpu && !worker.cudaReady)) continue;
        const outputKey = `projects/${candidate.id}/outputs/${crypto.randomUUID()}.${JSONL_OPS.has(op.type) ? "jsonl" : "json"}`;
        job = claimJob(worker.id, candidate.id, outputKey, selectedJobId);
        if (job) {
          projectId = candidate.id;
          project = candidateProject;
          break;
        }
      }

      if (!job) {
        return status(404, { message: "No chunks available" });
      }

      const op = getOperation(project!.opType);

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
        projectName: project!.name,
        jobNumber: job.jobNumber,
        status: "RUNNING",
        workerId: worker.id,
        opType: op?.type ?? "unknown",
        opName: op?.name ?? "Unknown",
        gpu: op?.gpu ?? false,
        instructions: op?.instructions ?? null,
        attempts: job.attempts,
        input,
        output: { key: job.outputKey!, url: signUrl("PUT", job.outputKey!) },
      };
    },
    {
      query: t.Object({
        projectId: t.Optional(t.String()),
        jobId: t.Optional(t.String()),
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
      if (!job.outputKey) return status(400, { message: "Chunk output was not uploaded" });
      const output = await readObject(job.outputKey);
      if (!output) return status(400, { message: "Chunk output was not uploaded" });
      const actualOutputHash = createHash("sha256").update(output).digest("hex");
      if (actualOutputHash !== body.outputHash.toLowerCase()) {
        return status(400, { message: "Uploaded output hash does not match the reported hash" });
      }

      const completedAt = new Date().toISOString();
      let rewardCredits = 0;

      const project = db.transaction((tx) => {
        const currentProject = tx
          .select(projectFields)
          .from(projects)
          .where(eq(projects.id, job.projectId))
          .get();
        if (!currentProject) return null;

        const completion = tx.update(jobs)
          .set({
            status: "COMPLETED",
            result: body.result ?? null,
            outputHash: body.outputHash,
            completedAt,
            durationMs: body.durationMs ?? null,
            gpuName: body.gpuName ?? worker.gpuName ?? null,
          })
          .where(and(
            eq(jobs.id, job.id),
            eq(jobs.workerId, worker.id),
            eq(jobs.status, "RUNNING"),
          ))
          .run() as unknown as { changes: number };
        if (completion.changes === 0) return null;

        rewardCredits = currentProject.escrowCredits >= currentProject.rewardPerChunk
          ? currentProject.rewardPerChunk
          : 0;

        tx.update(projects)
          .set({
            completedJobs: sql`${projects.completedJobs} + 1`,
            escrowCredits: sql`${projects.escrowCredits} - ${rewardCredits}`,
          })
          .where(eq(projects.id, job.projectId))
          .run();

        if (rewardCredits > 0) {
          tx.update(users)
            .set({ creditBalance: sql`${users.creditBalance} + ${rewardCredits}` })
            .where(eq(users.id, worker.userId))
            .run();
          tx.insert(creditTransactions).values({
            id: crypto.randomUUID(),
            userId: worker.userId,
            projectId: job.projectId,
            jobId: job.id,
            kind: "EARNED",
            amount: rewardCredits,
            note: `Reward for completing ${currentProject.name}, chunk #${job.jobNumber}`,
            createdAt: completedAt,
          }).run();
        }

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
      if (!project) {
        return status(409, { message: "Chunk was already completed or is no longer assigned to this worker" });
      }

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
        rewardCredits,
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
